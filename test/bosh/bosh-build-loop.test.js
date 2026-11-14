import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parsePlanItems, nextPlanItem, runBuildLoop, buildTestLoopPrompt, buildBuildLoopPrompt, buildQaLoopPrompt, testFileFor, TEST_RESULTS_FILE, MAX_ATTEMPTS } from '../../src/bosh/bosh-build-loop.js';

// What each persona's prompt opens with.
const head = (mode) => ({ 'test-writer': 'You are a Test Writer', builder: 'You are a software Builder', inspector: 'You are a Quality Inspector' })[mode];

const sample = [
  '# Plan',
  '',
  '1. [ ] T: Establish architectural constraints',
  '2. [ ] T: Implement the login screen',
  '3. [x] T: Already implemented',
  '',
].join('\n');

test('parsePlanItems reads each numbered `N. [ ] T: <name> - <detail> S: <ids>` line', () => {
  const items = parsePlanItems(sample);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { id: 1, checked: false, task: 'Establish architectural constraints', specs: [], lineIndex: 2 });
  assert.equal(items[1].task, 'Implement the login screen');
  assert.equal(items[2].checked, true);
  assert.deepEqual(parsePlanItems('1. [ ] T: Make the board - detail. S: 1, 12\n2. [x] T: Pick moves').map((i) => [i.id, i.checked, i.task, i.specs]), [
    [1, false, 'Make the board - detail.', [1, 12]],
    [2, true, 'Pick moves', []],
  ]);
});

test('nextPlanItem is the first item not yet checked, in file order', () => {
  assert.equal(nextPlanItem(parsePlanItems(sample))?.id, 1);
  assert.equal(nextPlanItem(parsePlanItems(sample.replace('1. [ ]', '1. [x]')))?.id, 2);
  assert.equal(nextPlanItem(parsePlanItems('1. [x] T: a\n')), null);
});

function makeFile(text = sample) {
  const dir = mkdtempSync(join(tmpdir(), 'bosh-build-loop-'));
  const path = join(dir, 'plan.md');
  writeFileSync(path, text);
  return { path, dir };
}

const io = () => ({ readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); } });

/**
 * @param {{ exitStatus: number, transcript: string, changedFiles: string[] }
 *   | ((req: any, callIndex: number) => object)} [result]
 */
function fakeAdapter(result = { exitStatus: 0, transcript: '', changedFiles: [] }) {
  const calls = [];
  return {
    calls,
    run: async (req) => {
      calls.push(req);
      const r = typeof result === 'function' ? result(req, calls.length) : result;
      // The Builder leaves a project file behind and the Inspector approves, unless a test says otherwise.
      if (req.prompt.includes('You are a software Builder')) writeFileSync(join(req.cwd, 'built.js'), `// ${calls.length}\n`);
      const merged = { exitStatus: 0, transcript: '', changedFiles: [], ...r };
      return !merged.transcript && req.prompt.includes('You are a Quality Inspector') ? { ...merged, transcript: 'APPROVED' } : merged;
    },
  };
}

// Fake harness: every listTests call reports a changed test file (as if the agent wrote one), a run of
// only the touched files is red, and a full run is green, unless overridden.
function harness(over = {}) {
  let stamp = 0;
  return {
    listTests: () => new Map([['/t/a.test.js', String(stamp++)]]),
    runTests: ({ files }) => (files ? { ok: false, output: 'red' } : { ok: true, output: '' }),
    ...over,
  };
}

const run = (planPath, dir, adapter, extra = {}) =>
  runBuildLoop({ planPath, ...io(), say: () => {}, adapter, repoDir: dir, ...harness(), ...extra });

test('runBuildLoop builds items in plan order and ticks only the checkbox', async () => {
  const { path, dir } = makeFile('1. [ ] T: first\n2. [ ] T: second\n');
  const adapter = fakeAdapter();
  const res = await run(path, dir, adapter);
  assert.equal(res.status, 'ok');
  assert.match(adapter.calls[0].prompt, /first/, 'the first line is built first');
  assert.equal(readFileSync(path, 'utf8'), '1. [x] T: first\n2. [x] T: second\n');
});

for (const [name, build, mode] of [
  ['buildTestLoopPrompt', buildTestLoopPrompt, 'test-writer'],
  ['buildBuildLoopPrompt', buildBuildLoopPrompt, 'builder'],
  ['buildQaLoopPrompt', buildQaLoopPrompt, 'inspector'],
]) {
  test(`${name} prefaces its mode prompt onto the item's task, and tail-truncates a long previous failure`, () => {
    const p = build({ task: 'Implement the login screen.' });
    assert.ok(p.trimStart().startsWith(head(mode)));
    assert.match(p, /Implement the login screen\./);
    assert.doesNotMatch(p, /# Feedback/);
    const long = build({ task: 'T' }, `${'x'.repeat(10000)}END`);
    assert.match(long, /xEND\n/);
    assert.ok(long.length < p.length + 4200);
  });
}

test('each item runs three fresh-context steps in order: write tests, implement, verify; then ticks, for every item', async () => {
  const { path, dir } = makeFile();
  const adapter = fakeAdapter();
  const res = await run(path, dir, adapter);
  assert.equal(res.status, 'ok');
  assert.equal(res.processed, 2);
  const after = parsePlanItems(readFileSync(path, 'utf8'));
  assert.ok(after.every((i) => i.checked));
  assert.equal(adapter.calls.length, 6, 'three agent calls per item, two items');
  assert.ok(adapter.calls[0].prompt.trimStart().startsWith(head('test-writer')));
  assert.ok(adapter.calls[1].prompt.trimStart().startsWith(head('builder')));
  assert.ok(adapter.calls[2].prompt.trimStart().startsWith(head('inspector')));
  assert.match(adapter.calls[0].prompt, /Establish architectural constraints/);
  assert.equal(adapter.calls[0].cwd, dir);
  for (const call of adapter.calls) assert.ok(!Object.hasOwn(call, 'session'), 'no call opts into session tracking');
});

test('the red check runs only the new or changed test files; the green check runs the full suite', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  const runs = [];
  await run(path, dir, fakeAdapter(), { runTests: (o) => { runs.push(o.files); return o.files ? { ok: false, output: 'red' } : { ok: true, output: '' }; } });
  assert.deepEqual(runs, [['/t/a.test.js'], undefined]);
});

test('a test step that adds or changes no test file is retried with that feedback, and the item fails after the cap', async () => {
  const { path, dir } = makeFile();
  const adapter = fakeAdapter();
  const res = await run(path, dir, adapter, { listTests: () => new Map([['/t/a.test.js', '1']]) });
  assert.equal(res.status, 'failed');
  assert.match(res.output, /No test file .* was added or changed/);
  assert.equal(adapter.calls.length, MAX_ATTEMPTS, 'only the test step ran, retried up to the cap');
  assert.match(adapter.calls[1].prompt, /No test file/);
  assert.equal(parsePlanItems(readFileSync(path, 'utf8'))[0].checked, false);
});

test('new tests that already pass are rejected (must be red before implementing), then accepted on a retry that makes them fail', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  let reds = 0;
  const adapter = fakeAdapter();
  const res = await run(path, dir, adapter, {
    runTests: ({ files }) => (files ? (++reds === 1 ? { ok: true, output: 'all green' } : { ok: false, output: 'red' }) : { ok: true, output: '' }),
  });
  assert.equal(res.status, 'ok');
  assert.ok(adapter.calls[1].prompt.trimStart().startsWith(head('test-writer')), 'the test step is retried');
  assert.match(adapter.calls[1].prompt, /The new tests .* already pass before any implementation[\s\S]*all green/);
  assert.ok(adapter.calls[2].prompt.trimStart().startsWith(head('builder')), 'only then does the implement step start');
});

test('a red implement step is retried with the failing output, then the item fails after the cap and QA never runs', async () => {
  const { path, dir } = makeFile();
  const adapter = fakeAdapter();
  let full = 0;
  const res = await run(path, dir, adapter, {
    runTests: ({ files }) => (files ? { ok: false, output: 'red' } : { ok: false, output: `boom ${++full}` }),
  });
  assert.equal(res.status, 'failed');
  assert.equal(res.output, `boom ${MAX_ATTEMPTS}`);
  assert.equal(adapter.calls.length, 1 + MAX_ATTEMPTS);
  assert.match(adapter.calls[2].prompt, /boom 1/);
  assert.ok(adapter.calls.every((c, i) => i === 0 || c.prompt.trimStart().startsWith(head('builder'))));
  assert.equal(parsePlanItems(readFileSync(path, 'utf8'))[0].checked, false);
});

test('a verify call that throws is retried with the error in its prompt, and the item is ticked once a retry succeeds', async () => {
  const { path, dir } = makeFile();
  const adapter = fakeAdapter((req, n) => {
    if (n === 3) throw new Error('adapter exploded');
    return {};
  });
  const res = await run(path, dir, adapter);
  assert.equal(res.status, 'ok');
  assert.equal(res.processed, 2);
  assert.match(adapter.calls[3].prompt, /Inspector threw an error: adapter exploded/);
  assert.ok(adapter.calls[3].prompt.trimStart().startsWith(head('inspector')));
});

test('the Inspector approves, or sends feedback to the Builder (not the Test Writer), who builds again before the Inspector looks once more', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  let inspections = 0;
  const adapter = fakeAdapter((req) => (req.prompt.includes('Quality Inspector') ? { transcript: ++inspections === 1 ? 'Close.\nFEEDBACK: the page has no title' : 'APPROVED' } : {}));
  const res = await run(path, dir, adapter);
  assert.equal(res.status, 'ok');
  const who = adapter.calls.map((c) => /You are (?:the|a) (?:Quality |software )?(Test Writer|Builder|Inspector)/.exec(c.prompt)[1]);
  assert.deepEqual(who, ['Test Writer', 'Builder', 'Inspector', 'Builder', 'Inspector']);
  assert.match(adapter.calls[3].prompt, /on behalf of the user[^]*the page has no title/);
  assert.doesNotMatch(adapter.calls[1].prompt, /on behalf of the user/);
});

test('an Inspector that never approves fails the item after the cap, and one with no verdict is asked for one', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  const res = await run(path, dir, fakeAdapter((req) => (req.prompt.includes('Quality Inspector') ? { transcript: 'FEEDBACK: still wrong' } : {})));
  assert.equal(res.status, 'failed');
  assert.equal(res.persona, 'Inspector');
  assert.match(res.output, /still wrong/);
  let asked = 0;
  const adapter = fakeAdapter((req) => (req.prompt.includes('Quality Inspector') ? { transcript: ++asked === 1 ? 'Looks fine to me.' : 'APPROVED' } : {}));
  const again = await run(path, dir, adapter);
  assert.equal(again.status, 'ok');
  assert.match(adapter.calls.at(-1).prompt, /End your reply with APPROVED/);
});

test('each role may only change its own files: anything else is reverted and sent back as feedback', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  const wrote = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  wrote('keep.txt', 'original');

  const tester = await run(path, dir, fakeAdapter((req) => (req.prompt.includes('Test Writer') ? wrote('sneaky.js', 'x') : {})));
  assert.equal(tester.status, 'failed');
  assert.equal(tester.persona, 'Test Writer');
  assert.match(tester.output, /sneaky\.js/);
  assert.equal(existsSync(join(dir, 'sneaky.js')), false, 'the Test Writer\'s project file is reverted');

  let tampered = false;
  const builder = fakeAdapter((req) => {
    if (req.prompt.includes('software Builder') && !tampered) { tampered = true; wrote('.bish-bash-bosh/specification.md', 'tampered'); }
    return {};
  });
  assert.equal((await run(path, dir, builder)).status, 'ok');
  assert.equal(existsSync(join(dir, '.bish-bash-bosh', 'specification.md')), false, 'the Builder cannot write under .bish-bash-bosh/');
  assert.match(builder.calls.filter((c) => c.prompt.includes('software Builder'))[1].prompt, /have been reverted: \.bish-bash-bosh\/specification\.md/);

  let edited = false;
  const inspector = fakeAdapter((req) => {
    if (req.prompt.includes('Quality Inspector') && !edited) { edited = true; wrote('keep.txt', 'changed by inspector'); }
    return {};
  });
  assert.equal((await run(path, dir, inspector)).status, 'ok');
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'original', 'the Inspector is read-only');
});

test('an item cannot pass when the Builder changed none of the project\'s own files', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  const idle = { calls: [], run: async (req) => ({ exitStatus: 0, transcript: req.prompt.includes('Quality Inspector') ? 'APPROVED' : '', changedFiles: [] }) };
  const { path: p2, dir: d2 } = makeFile('1. [ ] T: a\n');
  const failed = await run(p2, d2, idle);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.persona, 'Builder');
  assert.match(failed.output, /project's own files/);
});

test('shows each item in colour with a grey status line before each step', async () => {
  const { path, dir } = makeFile();
  const said = [];
  await run(path, dir, fakeAdapter(), { say: (s) => said.push(s) });
  assert.match(said[0], /\x1b\[1;36mEstablish architectural constraints\x1b\[0m/);
  const lines = said.slice(0, 9).map((l) => l.replace(/\x1b\[\d+(;\d+)?m/g, '').trim());
  assert.deepEqual(lines.slice(1), [
    'Harness: Preparing the test file...',
    'Test Writer...',
    'Harness: Testing the new tests, expecting them to fail...',
    'Builder...',
    'Harness: Testing the whole suite...',
    'Inspector...',
    'Harness: Writing the test results for the Inspector...',
    'Harness: Committing...',
  ]);
  assert.match(said[1], /^\x1b\[90mHarness: /, 'harness steps are grey like the agent steps');
});

test('once every item is processed, a further call reports ok with nothing left to hand to the agent; a failed item is retried from its first step next run', async () => {
  const { path, dir } = makeFile();
  await run(path, dir, fakeAdapter(), { runTests: () => ({ ok: false, output: 'boom' }) });
  const adapter = fakeAdapter();
  const res = await run(path, dir, adapter);
  assert.equal(res.processed, 2);
  assert.match(adapter.calls[0].prompt, /Establish architectural constraints/);
  assert.ok(adapter.calls[0].prompt.trimStart().startsWith(head('test-writer')));
  const again = fakeAdapter();
  assert.deepEqual(await run(path, dir, again), { status: 'ok', processed: 0, total: 3, spec: undefined });
  assert.equal(again.calls.length, 0);
});

test('log gets each full prompt (\'bosh\'), streamed reasoning (\'agent\') only when streamed, and failure output when a gate fails', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  const logged = [];
  await run(path, dir, fakeAdapter((req) => { req.onReasoning?.('step one, '); req.onReasoning?.('step two'); return {}; }), { log: (s, t) => logged.push([s, t]) });
  assert.equal(logged[0][0], 'bosh/test-writer prompt');
  assert.ok(logged[0][1].trimStart().startsWith(head('test-writer')));
  assert.deepEqual(logged[1], ['bosh/test-writer response', 'step one, step two']);
  assert.deepEqual(logged.filter((l) => l[0].endsWith('prompt')).map((l) => l[0]), ['bosh/test-writer prompt', 'bosh/builder prompt', 'bosh/inspector prompt'], 'each fresh-context step is logged under its own persona');
  const quiet = [];
  await run(path, dir, fakeAdapter(), { log: (s, t) => quiet.push([s, t]) });
  assert.ok(!quiet.some((l) => l[0].endsWith('response')));
  const failing = [];
  const { path: p2, dir: d2 } = makeFile();
  await run(p2, d2, fakeAdapter(), { runTests: () => ({ ok: false, output: 'boom' }), log: (s, t) => failing.push([s, t]) });
  assert.ok(failing.some((l) => l[0] === 'bosh/harness' && l[1].includes('boom')));
});

test('tests that still pass on the retry are accepted (the item was implemented by an earlier interrupted run) and the loop carries on', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  const adapter = fakeAdapter();
  const res = await run(path, dir, adapter, { runTests: () => ({ ok: true, output: 'all green' }) });
  assert.equal(res.status, 'ok');
  assert.equal(adapter.calls.filter((c) => c.prompt.trimStart().startsWith(head('test-writer'))).length, 2);
  assert.ok(adapter.calls.some((c) => c.prompt.trimStart().startsWith(head('builder'))));
});

test('a Test Writer reply ending ALREADY IMPLEMENTED: is accepted on the first attempt, and the Inspector is told which plan items are still to come', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n2. [ ] T: later work\n');
  const adapter = fakeAdapter((req) => (req.prompt.includes('You are a Test Writer') ? { transcript: 'ALREADY IMPLEMENTED: index.html' } : {}));
  const res = await run(path, dir, adapter, { runTests: () => ({ ok: true, output: 'all green' }) });
  assert.equal(res.status, 'ok');
  assert.equal(adapter.calls.filter((c) => c.prompt.trimStart().startsWith(head('test-writer'))).length, 2, 'one Test Writer call per item, no retry');
  const inspector = adapter.calls.find((c) => c.prompt.trimStart().startsWith(head('inspector')));
  assert.match(inspector.prompt, /still to come[\s\S]*- 2\. later work/);
});

test('the Inspector\'s VERIFIED line ticks only the item\'s own specification items', async () => {
  const { path, dir } = makeFile('1. [ ] T: a S: 1, 2\n');
  const specPath = join(dir, 'specification.md');
  writeFileSync(specPath, '1. [ ] C: one. B: x\n2. [ ] C: two. B: y\n3. [ ] C: three. B: z\n');
  const adapter = fakeAdapter((req) => (req.prompt.includes('Quality Inspector') ? { transcript: 'Good work.\nAPPROVED\nVERIFIED: S1, S3' } : {}));
  const res = await run(path, dir, adapter, { specPath });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.spec, { verified: [1], uncovered: [2, 3] });
  assert.equal(readFileSync(specPath, 'utf8'), '1. [x] C: one. B: x\n2. [ ] C: two. B: y\n3. [ ] C: three. B: z\n');
});

test('the harness commits once per completed item, with the task and its specification ids as the message', async () => {
  const { path, dir } = makeFile('1. [ ] T: Create index.html - the page shell S: 2, 3\n2. [ ] T: Style the grid\n');
  const messages = [];
  await run(path, dir, fakeAdapter(), { commit: (m) => messages.push(m) });
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^bosh: Create index\.html\n\nthe page shell\n\nSpecification items: 2, 3/);
  assert.match(messages[1], /^bosh: Style the grid/);
  const failed = [];
  await run(path, dir, fakeAdapter(), { runTests: () => ({ ok: false, output: 'x' }), commit: (m) => failed.push(m) });
  assert.deepEqual(failed, [], 'nothing is committed for an item that did not pass');
});


test('classifyFailures separates failed assertions from tests that error or whose probe died', async () => {
  const { classifyFailures, describeTestErrors } = await import('../../src/bosh/bosh-test-runner.js');
  const out = [
    'test at t.test.js:1:1', '✖ [S1] asserts (3ms)', '  AssertionError [ERR_ASSERTION]: 1 !== 2', '',
    'test at t.test.js:5:1', '✖ [S1] throws (3ms)', '  TypeError: x is not a function', '',
    'test at t.test.js:9:1', '✖ [S2] probe (3ms)', '  AssertionError [ERR_ASSERTION]: evalmachine.<anonymous>:34', '  ReferenceError: board is not defined', '  1 !== 0',
  ].join('\n');
  const { assertions, errors } = classifyFailures(out);
  assert.deepEqual(assertions.map((a) => a.name), ['[S1] asserts']);
  assert.deepEqual(errors.map((e) => e.name), ['[S1] throws', '[S2] probe']);
  assert.match(describeTestErrors(out), /board is not defined/);
  assert.equal(describeTestErrors('test at t:1:1\n✖ a (1ms)\n  AssertionError [ERR_ASSERTION]: no'), '');
});

test('a Builder TEST FEEDBACK reply goes back to the Test Writer, then the Builder runs again', async () => {
  const { path, dir } = makeFile();
  const prompts = [];
  let builds = 0;
  const adapter = {
    async run(req) {
      prompts.push(req.prompt);
      if (req.prompt.includes('You are a software Builder')) {
        writeFileSync(join(req.cwd, 'built.js'), String(prompts.length));
        return { transcript: ++builds === 1 ? 'The probe is broken.\nTEST FEEDBACK: t.test.js: board is not defined' : 'done' };
      }
      return { transcript: req.prompt.includes('Quality Inspector') ? 'APPROVED' : '' };
    },
  };
  let stamp = 0;
  const res = await run(path, dir, adapter, { listTests: () => new Map([['t.test.js', String(stamp++)]]) });
  assert.equal(res.status, 'ok');
  const who = prompts.map((p) => /You are (?:the|a) (?:Quality |software )?(Test Writer|Builder|Inspector)/.exec(p)[1]);
  assert.deepEqual(who.slice(0, 4), ['Test Writer', 'Builder', 'Test Writer', 'Builder']);
  assert.match(prompts[2], /t\.test\.js: board is not defined/);
});

test('testFileFor names the test file from its number, task and specification ids', () => {
  assert.equal(testFileFor({ id: 7, task: 'Create index.html - one page', specs: [1, 11] }), '.bish-bash-bosh/tests/07-create-index-html.s1-s11.test.js');
  assert.equal(testFileFor({ id: 12, task: 'Wire it!', specs: [] }), '.bish-bash-bosh/tests/12-wire-it.test.js');
});

test('every build persona is handed the item and the item\'s test file', () => {
  const item = { id: 3, task: 'Define winningLine - pure', specs: [3, 5] };
  for (const build of [buildTestLoopPrompt, buildBuildLoopPrompt, buildQaLoopPrompt]) {
    const p = build(item, 'boom');
    assert.match(p, /03-define-winningline\.s3-s5\.test\.js/);
    assert.match(p, /boom/);
  }
});

test('the Inspector is pointed at a results file holding the latest full-suite output', async () => {
  const { path, dir } = makeFile('1. [ ] T: a\n');
  const adapter = fakeAdapter();
  const out = await run(path, dir, adapter, { runTests: ({ files }) => (files ? { ok: false, output: 'red' } : { ok: true, output: 'SUITE OUTPUT' }) });
  assert.equal(out.status, 'ok');
  assert.ok(adapter.calls.at(-1).prompt.includes(TEST_RESULTS_FILE));
  assert.equal(readFileSync(join(dir, TEST_RESULTS_FILE), 'utf8'), 'SUITE OUTPUT');
});

test('each item gets a starter test file with the harness import, unless one already exists', async () => {
  const { path, dir } = makeFile('1. [ ] T: a - detail S: 3\n');
  const item = parsePlanItems(readFileSync(path, 'utf8'))[0];
  let seen = '';
  const adapter = fakeAdapter((req, n) => {
    if (n === 1) seen = readFileSync(join(dir, testFileFor(item)), 'utf8');
    return {};
  });
  await run(path, dir, adapter);
  assert.match(seen, /from '\.\.\/test-harness\.js'/);
});

test('the Test Writer is given the item\'s specification rows as they appear in specification.md, not just their numbers', async () => {
  const { path, dir } = makeFile('1. [ ] T: a - detail S: 2\n');
  const specPath = join(dir, 'specification.md');
  writeFileSync(specPath, '# Specification\n\n1. [ ] C: One. B: First. Q: TBC\n2. [ ] C: Two. B: Second. Q: TBC\n');
  const adapter = fakeAdapter();
  await run(path, dir, adapter, { specPath });
  assert.match(adapter.calls[0].prompt, /2\. \[ \] C: Two\. B: Second\. Q: TBC/);
  assert.doesNotMatch(adapter.calls[0].prompt, /C: One\./);
});

test('every persona is told the README, the item\'s specification rows and the interview questions behind them', async () => {
  const { path, dir } = makeFile('1. [ ] T: a - detail S: 2\n');
  const specPath = join(dir, 'specification.md');
  writeFileSync(specPath, '# Specification\n\n1. [ ] C: One. B: First. Q: 1\n2. [ ] C: Two. B: Second. Q: 2, 3\n');
  writeFileSync(join(dir, 'README.md'), '# A greeter\n');
  mkdirSync(join(dir, '.bish-bash-bosh'), { recursive: true });
  writeFileSync(join(dir, '.bish-bash-bosh', 'interview.md'), '1. [x] Q: Unrelated? A: x\n2. [x] Q: Who uses it? A: Developers\n3. [x] Q: Where? A: CLI\n');
  const adapter = fakeAdapter();
  await run(path, dir, adapter, { specPath });
  for (const persona of ['test-writer', 'builder', 'inspector']) {
    const p = adapter.calls.find((c) => c.prompt.trimStart().startsWith(head(persona))).prompt;
    assert.match(p, /`README\.md`/, persona);
    assert.match(p, /2\. \[ \] C: Two\. B: Second\. Q: 2, 3/, persona);
    assert.match(p, /2\. \[x\] Q: Who uses it\? A: Developers\n3\. \[x\] Q: Where\? A: CLI/, persona);
    assert.doesNotMatch(p, /Unrelated|C: One\./, persona);
  }
});
