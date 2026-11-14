// The Build Loop: a deterministic walk through `.bish-bash-bosh/plan.md`'s prioritised checklist
// (see src/bash/prompts/bash-planner.js for the format the Plan Pass's agent writes into it: one numbered line per
// item in priority order, `<n>. [ ] T: <name> - <detail> S: <specification ids>`), with a single checkbox ticked only once that item has been
// implemented, independently verified and both gates have passed. Unlike the Interview Loop there is
// no human input: each unprocessed item is simply handed to the agent in turn. Every call — build or
// QA — starts a fresh agent context (no continuing session, unlike `bish`/`bash`): the agent is
// instructed to read `.bish-bash-bosh/plan.md` and the project's own source/test files rather than rely
// on memory of earlier calls.
import { describeTestErrors } from './bosh-test-runner.js';
import testWriterPrompt from './prompts/bosh-test-writer.js';
import builderPrompt from './prompts/bosh-builder.js';
import { join } from 'node:path';
import testFileTemplate from './templates/bosh-test-file.js';
import inspectorPrompt from './prompts/bosh-inspector.js';
import { subject } from '../shared/git-commit.js';
import { parseSpecificationItems } from '../bash/bash-planner.js';
import { parseInterview } from '../bish/bish-analyst-loop.js';
import { parseVerdict, tickSpecs } from './bosh-spec-status.js';
import { takeSnapshot, enforce, describeViolations } from './bosh-zones.js';

const CYAN = '\x1b[1;36m';
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';

// Every step (write tests, implement, verify) that fails its gate or throws is retried, in a fresh agent
// context with that failure as input, up to this many attempts.
export const MAX_ATTEMPTS = 5;
const MAX_TEST_ROUNDS = 3;
const MAX_INSPECTION_ROUNDS = 3;
const MAX_FAILURE_CHARS = 4000;

const LINE = /^(\d+)\.\s*\[([ x])\]\s*T:\s*(.*?)(?:\s+S:\s*(.*))?$/;

// Parses the numbered plan lines out of a plan.md's text. Returns one entry per well-formed
// `<n>. [ ] T: <name> - <detail> S: <spec ids>` line, with its line index so the loop can rewrite it in place.
export function parsePlanItems(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i]);
    if (!m) continue;
    out.push({
      id: Number(m[1]),
      checked: m[2] === 'x',
      task: m[3].trim(),
      specs: (m[4] ?? '').match(/\d+/g)?.map(Number) ?? [],
      lineIndex: i,
    });
  }
  return out;
}

// The next plan item to hand to the agent: the first unchecked line. The plan is written in priority order
// (see src/bash/prompts/bash-planner.js), so file order is build order.
export function nextPlanItem(items) {
  return items.find((i) => !i.checked) ?? null;
}

// The item text handed to every build persona: just the task.
function describeItem(item) {
  return item.task;
}

// The one test file for an item, named from its number, task and specification ids, so every step and retry agrees on it.
export function testFileFor(item) {
  const slug = item.task.split(' - ')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'item';
  const specs = item.specs?.length ? `.${item.specs.map((n) => `s${n}`).join('-')}` : '';
  return `.bish-bash-bosh/tests/${String(item.id).padStart(2, '0')}-${slug}${specs}.test.js`;
}

// Writes the item's starter test file unless an earlier run already left one.
function ensureTestFile(repoDir, item, readFile, writeFile) {
  const path = join(repoDir, testFileFor(item));
  try {
    readFile(path);
  } catch {
    writeFile(path, testFileTemplate(item.task.split(' - ')[0]));
  }
}

// The item's specification lines exactly as they appear in specification.md, for the Test Writer's prompt.
export function specRowsFor(item, specText) {
  const wanted = new Set(item.specs ?? []);
  return parseSpecificationItems(specText).filter((r) => wanted.has(r.id)).map((r) => specText.split('\n')[r.lineIndex]).join('\n');
}

const INTERVIEW_FILE = '.bish-bash-bosh/interview.md';

// The interview lines (verbatim) behind an item's specification rows: each row's `Q:` field lists question numbers.
export function questionsFor(specrows, interviewText) {
  const ids = new Set(specrows.split('\n').flatMap((row) => (/\sQ\s*:(.*)$/.exec(row)?.[1].match(/\d+/g) ?? []).map(Number)));
  const lines = interviewText.split('\n');
  return parseInterview(interviewText).filter((q) => ids.has(q.id)).map((q) => lines[q.lineIndex]).join('\n');
}

// What the Builder and Inspector are told about why an item exists: its specification rows and the interview
// questions behind them as [specrows, questions], each empty when the file or link is missing.
function contextFor(item, { repoDir, specPath, readFile }) {
  const read = (path) => {
    try {
      return readFile(path);
    } catch {
      return '';
    }
  };
  const specrows = specRowsFor(item, specPath ? read(specPath) : '');
  return [specrows, questionsFor(specrows, read(join(repoDir, INTERVIEW_FILE)))];
}

function clip(failure) {
  return failure.length > MAX_FAILURE_CHARS ? `...${failure.slice(-MAX_FAILURE_CHARS)}` : failure;
}

// Step 1's prompt (src/bosh/prompts/bosh-test-writer.js): write the harness verification tests for this item only,
// no implementation. A retry also carries the failure the harness found under `## Feedback`.
export function buildTestLoopPrompt(item, failure, specrows = '', questions = '') {
  return testWriterPrompt(describeItem(item), clip(failure ?? ''), testFileFor(item), specrows, questions);
}

// Step 2's prompt (src/bosh/prompts/bosh-builder.js): implement the item so the tests written in step 1 pass. A
// retry also carries the failing test output under `## Feedback`, tail-truncated.
export function buildBuildLoopPrompt(item, failure, specrows = '', questions = '', inspection = '') {
  return builderPrompt(describeItem(item), clip(failure ?? ''), testFileFor(item), specrows, questions, clip(inspection));
}

// Step 3's prompt (src/bosh/prompts/bosh-inspector.js): independently verify against interview.md/specification.md/
// plan.md and the source, fixing bugs directly. A retry carries the previous failure the same way.
export const TEST_RESULTS_FILE = '.bish-bash-bosh/test-results.txt';

export function buildQaLoopPrompt(item, failure, specrows = '', questions = '', changedFiles = [], laterItems = []) {
  return inspectorPrompt(describeItem(item), clip(failure ?? ''), testFileFor(item), TEST_RESULTS_FILE, specrows, questions, changedFiles, laterItems.map((i) => `${i.id}. ${i.task}`));
}

// Ticks a plan item's checkbox by line index, re-reading the file first since something else may have
// changed it meanwhile. Only the checkbox flips, so the item's number and text survive. A line that
// no longer matches (gone, or changed beyond recognition) is left alone rather than erroring.
function markProcessed(planPath, readFile, writeFile, lineIndex) {
  const text = readFile(planPath);
  const lines = text.split('\n');
  if (!LINE.test(lines[lineIndex] ?? '')) return;
  lines[lineIndex] = lines[lineIndex].replace('[ ]', '[x]');
  writeFile(planPath, lines.join('\n'));
}

// Runs one agent call under its role's write zone: whatever it changed outside the zone is reverted and reported.
// Returns { reply, changed, violations }.
async function callAgent(adapter, repoDir, prompt, log, persona, role) {
  log(`${persona} prompt`, prompt);
  let reasoning = '';
  // No `session` key: every call (build or QA) is opted out of session tracking, so each one is a
  // fresh agent context with no memory of any earlier call in this loop (see adapters/*.js: session
  // tracking is opt-in via `Object.hasOwn(req, 'session')`).
  const before = takeSnapshot(repoDir);
  const res = await adapter.run({ prompt, cwd: repoDir, limits: {}, onReasoning: (chunk) => { reasoning += chunk; } });
  if (reasoning) log(`${persona} response`, reasoning);
  const { changed, violations } = enforce(repoDir, before, role);
  return { reply: `${res?.transcript ?? ''}\n${reasoning}`, changed, violations };
}

const ALREADY_IMPLEMENTED = /^[ \t>*-]*ALREADY IMPLEMENTED:/m;

// The Builder reports a defective test by ending its reply with a `TEST FEEDBACK: <what is wrong>` line (it never edits tests).
export function testFeedbackFrom(reply) {
  const hits = [...reply.matchAll(/^[ \t>*-]*TEST FEEDBACK:[ \t]*([\s\S]*)$/gm)];
  return hits.length ? hits[hits.length - 1][1].trim() : '';
}

// Runs the loop against `plan.md` in `repoDir`: finds the next unprocessed item, shows it in colour,
// then for that one item, each agent call a fresh context and every gate bosh's own code, never the
// agent's self-report: (1) WRITE TESTS (src/bosh/prompts/bosh-test-writer.js): the agent writes the harness
// verification tests for the item and nothing else; the harness checks that new/changed test files
// exist and that they run RED (fail) before any implementation, (2) IMPLEMENT (src/bosh/prompts/bosh-builder.js):
// the agent implements the item; the harness runs the full `.bish-bash-bosh/tests/` suite and requires
// GREEN, (3) VERIFY (src/bosh/prompts/bosh-inspector.js): an independent agent checks the work against
// interview.md/specification.md/plan.md and fixes bugs directly; the harness runs the suite again.
// A step that throws or fails its gate is retried (up to MAX_ATTEMPTS) with the failure passed back in
// its prompt; if it never passes, the invocation stops with the item left unticked (a later `bosh` run
// retries it, since the loop always picks the first unticked item). Only once all three steps have
// passed is the item's checkbox ticked. Unlike the Plan Loop there is no human input and no pause: it
// processes every unprocessed item in one call, stopping once none remain (status 'ok') or a step
// gives up (status 'failed'). `log` (see bish-log.js), if given, is called with the full prompt sent for
// each agent call (`'bosh'`) and, if the agent streamed any reasoning text via an opt-in `onReasoning`
// callback, the full accumulated text of that stream (`'agent'`) — never the raw JSON behind either.
// These harness tests are bish-bash-bosh's own verification and never stand in for anything the
// user's objective specifies for itself.
/**
 * @param {{
 *   planPath: string,
 *   specPath?: string,
 *   commit?: (message: string) => unknown,
 *   readFile: (p: string) => string,
 *   writeFile: (p: string, s: string) => void,
 *   say: (s: string) => void,
 *   adapter: { run: (req: object) => Promise<object> },
 *   repoDir?: string,
 *   runTests: (opts: { cwd: string, files?: string[] }) => { ok: boolean, output: string },
 *   listTests: (opts: { cwd: string }) => Map<string, string>,
 *   log?: (source: string, text: string) => void,
 * }} opts
 */
export async function runBuildLoop({
  planPath,
  specPath,
  commit = () => {},
  readFile,
  writeFile,
  say,
  adapter,
  repoDir,
  runTests,
  listTests,
  log = (/** @type {string} */ _source, /** @type {string} */ _text) => {},
}) {
  // A line for work the harness itself does between the agents, in the same grey as the agent steps.
  const harness = (what) => say(`${GREY}Harness: ${what}...${RESET}\n`);
  // Runs one step up to MAX_ATTEMPTS times; `attempt(previousFailure)` returns '' on success or the failure text.
  async function step(label, attempt, seed = '', note = '') {
    let previous = seed;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      say(`${GREY}${label}${n > 1 ? ' (trying again with feedback)' : note ? ` (${note})` : ''}...${RESET}\n`);
      let failure;
      try {
        failure = await attempt(previous);
      } catch (e) {
        failure = `${label} threw an error: ${e?.message ?? e}`;
      }
      if (!failure) return '';
      log('bosh/harness', `${label} attempt ${n} got feedback:\n${failure}`);
      previous = failure;
    }
    return previous;
  }

  let processed = 0;
  let spec;
  for (;;) {
    const text = readFile(planPath);
    const items = parsePlanItems(text);
    const next = nextPlanItem(items);
    if (!next) {
      if (items.length === 0) return { status: 'empty', processed };
      return { status: 'ok', processed, total: items.length, spec };
    }
    say(`\n${CYAN}${next.task.split(' - ')[0]}${RESET}\n`);
    const fail = (output, persona) => ({ status: 'failed', processed, item: next, output, persona, spec });

    // Each role only changes its own files (see bosh-zones.js): the Test Writer the tests, the Builder the project,
    // the Inspector nothing. The Builder reports a defective test as TEST FEEDBACK and the Test Writer fixes it
    // (at most MAX_TEST_ROUNDS times); the Inspector, on behalf of the user, either approves or sends feedback to
    // the Builder (at most MAX_INSPECTION_ROUNDS times).
    harness('Preparing the test file');
    ensureTestFile(repoDir, next, readFile, writeFile);
    let testFeedback = '';
    let inspection = '';
    let latestResults = '';
    let needTests = true;
    let testRounds = 0;
    let inspectionRounds = 0;
    let implementedAlready = false;
    const projectFiles = new Set();
    for (;;) {
      if (needTests) {
        const before = listTests({ cwd: repoDir });
        // An item whose implementation survived an interrupted earlier run can never go red. So tests that still
        // pass on the retry are accepted (the Inspector then checks the work) instead of failing the item.
        let alreadyGreen = 0;
        const redFailure = await step('Test Writer', async (previous) => {
          const { reply, violations } = await callAgent(adapter, repoDir, buildTestLoopPrompt(next, previous, ...contextFor(next, { repoDir, specPath, readFile })), log, 'bosh/test-writer', 'test-writer');
          if (violations.length) return describeViolations('test-writer', violations);
          const after = listTests({ cwd: repoDir });
          const touched = [...after].filter(([path, stamp]) => before.get(path) !== stamp).map(([path]) => path);
          if (touched.length === 0) return 'No test file under .bish-bash-bosh/tests/ was added or changed: write or fix at least one test for this item.';
          harness('Testing the new tests, expecting them to fail');
          const red = runTests({ cwd: repoDir, files: touched });
          const broken = red.ok ? '' : describeTestErrors(red.output);
          if (broken) return `${broken}Fix the tests so they run and fail on an assertion because the item's behaviour is missing.\n${red.output}`;
          if (red.ok && testFeedback) return '';
          if (red.ok && ALREADY_IMPLEMENTED.test(reply)) {
            implementedAlready = true;
            log('bosh/harness', `The Test Writer reports the item is already implemented; its tests (${touched.join(', ')}) pass as they stand.`);
            return '';
          }
          if (red.ok && ++alreadyGreen >= 2) {
            implementedAlready = true;
            log('bosh/harness', `The new tests (${touched.join(', ')}) still pass before any implementation; accepting them, the item may already be implemented from an earlier run.`);
            return '';
          }
          if (red.ok) return `The new tests (${touched.join(', ')}) already pass before any implementation, so they prove nothing: make them fail for the right reason (the item's behaviour missing). If the project's files already implement this item, keep the tests as they are and end your reply with a line starting with ALREADY IMPLEMENTED: saying where.\n${red.output}`;
          return '';
        }, testFeedback, testFeedback ? 'with feedback from the Builder' : '');
        if (redFailure) return fail(redFailure, 'Test Writer');
        testFeedback = '';
        needTests = false;
      }

      const greenFailure = await step('Builder', async (previous) => {
        const built = await callAgent(adapter, repoDir, buildBuildLoopPrompt(next, previous, ...contextFor(next, { repoDir, specPath, readFile }), inspection), log, 'bosh/builder', 'builder');
        built.changed.forEach((file) => projectFiles.add(file));
        if (built.violations.length) return `${describeViolations('builder', built.violations)} If a test is defective, end your reply with a line starting with TEST FEEDBACK: instead of editing it.`;
        testFeedback = testFeedbackFrom(built.reply);
        if (testFeedback) return '';
        harness('Testing the whole suite');
        const result = runTests({ cwd: repoDir });
        latestResults = result.output;
        if (!result.ok) return `${describeTestErrors(result.output)}${result.output}`;
        // The deliverable is the project itself, so an item can't pass on harness files alone.
        return projectFiles.size === 0 && !implementedAlready ? 'None of the project\'s own files was added or changed. The item\'s deliverables live in the project folder, outside .bish-bash-bosh/: implement the item there.' : '';
      }, '', inspection ? 'with feedback from the Inspector' : '');
      if (greenFailure) return fail(greenFailure, 'Builder');
      if (testFeedback) {
        log('bosh/harness', `Builder sent feedback on the tests (round ${++testRounds} of ${MAX_TEST_ROUNDS}):\n${testFeedback}`);
        if (testRounds >= MAX_TEST_ROUNDS) return fail(`The Builder still reports a defective test after ${MAX_TEST_ROUNDS} fixes: ${testFeedback}`, 'Builder');
        harness('The Builder reports a defective test, sending it back to the Test Writer');
        needTests = true;
        continue;
      }

      let verdict = { approved: false, feedback: '', verified: [] };
      const qaFailure = await step('Inspector', async (previous) => {
        // The Inspector reads the latest full-suite output from a results file the harness writes before it runs.
        harness('Writing the test results for the Inspector');
        writeFile(join(repoDir, TEST_RESULTS_FILE), latestResults);
        const inspected = await callAgent(adapter, repoDir, buildQaLoopPrompt(next, previous, ...contextFor(next, { repoDir, specPath, readFile }), [...projectFiles], items.filter((i) => !i.checked && i.id !== next.id)), log, 'bosh/inspector', 'inspector');
        if (inspected.violations.length) return describeViolations('inspector', inspected.violations);
        verdict = parseVerdict(inspected.reply);
        return verdict.approved || verdict.feedback ? '' : 'End your reply with APPROVED (and a VERIFIED: line) or with a line starting with FEEDBACK: describing what must change.';
      });
      if (qaFailure) return fail(qaFailure, 'Inspector');
      if (verdict.approved) {
        if (specPath) spec = tickSpecs(specPath, readFile, writeFile, verdict.verified.filter((id) => next.specs.includes(id)));
        break;
      }
      inspection = verdict.feedback;
      harness('The Inspector has feedback, sending it back to the Builder');
      log('bosh/harness', `Inspector sent feedback (round ${++inspectionRounds} of ${MAX_INSPECTION_ROUNDS}):\n${inspection}`);
      if (inspectionRounds >= MAX_INSPECTION_ROUNDS) return fail(`The Inspector still had feedback after ${MAX_INSPECTION_ROUNDS} rounds: ${inspection}`, 'Inspector');
    }

    markProcessed(planPath, readFile, writeFile, next.lineIndex);
    processed++;
    const [name, ...detail] = next.task.split(' - ');
    harness('Committing');
    commit([`bosh: ${subject(name)}`, detail.join(' - '), next.specs.length ? `Specification items: ${next.specs.join(', ')}` : '', spec ? `Specification status: ${spec.verified.length} verified, ${spec.uncovered.length} not yet verified` : ''].filter(Boolean).join('\n\n'));
  }
}
