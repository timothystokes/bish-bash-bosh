import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import analystInitPrompt from '../../src/bish/prompts/bish-analyst-init.js';
import { main } from '../../src/cli/cli.js';
import { writeProjectConfig, commitProjectConfig, withCwd, initGitRepo } from '../support/project.js';

const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'bish-int-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'README.md'), '# target\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const config = (/** @type {{adapter?: string, model?: string}} */ overrides = {}) => ({
  adapter: 'f',
  model: 'm',
  ...overrides,
});

const identity = { root: '/nonexistent/bish-bash-bosh', remotes: [] };

/** @param {Record<string, string>} writes @param {number} [exitStatus] */
const agent = (writes, exitStatus = 0) => {
  /** @type {string[]} */
  const prompts = [];
  return {
    prompts,
    adapter: {
      async run(req) {
        prompts.push(req.prompt);
        const { createFakeAdapter } = await import('../../src/adapters/adapter.js');
        return createFakeAdapter({ exitStatus, transcript: 't', writes }).run(req);
      },
    },
  };
};

test('bish on a fresh repo seeds the stores from their templates, has the agent draft them from README.md, then the Interview Loop asks each unanswered question, hands each round to the agent, and ticks both checkboxes until it pauses or completes', async () => {
  const dir = makeRepo();
  commitProjectConfig(dir, config({ adapter: 'iv' }));
  const seed = agent({
    '.bish-bash-bosh/specification.md': '# Specification\n\n1. [ ] C: Greet the user. B: Friendly.\n',
    '.bish-bash-bosh/interview.md': '# Interview\n\n1. [ ] Q: What is the objective? A: Unknown.\n',
  });
  const a = agent({});
  let built = 0;
  const registry = { iv: () => (built++ === 0 ? seed.adapter : a.adapter) };
  const out = /** @type {string[]} */ ([]);
  // the very first run seeds from the templates and makes one bootstrap agent call: no run folder
  const seedCode = await withCwd(dir, () =>
    main(['bish'], { registry, identity, input: Readable.from([]), stdout: (s) => { out.push(s); }, stderr: () => {} }));
  assert.equal(seedCode, 1, 'the interview carries straight on and pauses at EOF before its first answer');
  assert.equal(seed.prompts.length, 1, 'one bootstrap agent call');
  assert.equal(seed.prompts[0], analystInitPrompt());
  assert.match(out.join(''), /Wrote \.bish-bash-bosh\/specification\.md and \.bish-bash-bosh\/interview\.md from README\.md/);
  assert.match(readFileSync(join(dir, '.bish-bash-bosh', 'specification.md'), 'utf8'), /Greet the user/);
  assert.match(readFileSync(join(dir, '.bish-bash-bosh', 'bish-log.md'), 'utf8'), /bish\/analyst prompt: .*Initial Specification/s, 'the bootstrap prompt is logged');
  assert.ok(!existsSync(join(dir, '.bish-bash-bosh', 'runs')), 'no run folder on the bootstrap run');
  // a second, custom question with a pre-filled default so the loop's resume/default behaviour can be exercised
  writeFileSync(
    join(dir, '.bish-bash-bosh', 'interview.md'),
    `${readFileSync(join(dir, '.bish-bash-bosh', 'interview.md'), 'utf8')}\n2. [ ] Q: Who uses the greeter? A: Developers\n`,
  );
  out.length = 0;
  const paused = await withCwd(dir, () =>
    main(['bish'], { registry, identity, input: Readable.from(['Build a greeter\n']), stdout: (s) => { out.push(s); }, stderr: () => {} }));
  assert.equal(paused, 1, 'paused at EOF, not ok');
  assert.match(out.join(''), /What is the objective\?/);
  assert.match(out.join(''), /Paused after 1 question: 1 question left\. Run `-bish` again to continue\./);
  assert.equal(a.prompts.length, 1, 'one agent round for the one question answered before EOF');
  assert.match(a.prompts[0], /## Question\n\nWhat is the objective\?\n\n## Answer\n\nBuild a greeter/);
  const afterFirst = readFileSync(join(dir, '.bish-bash-bosh', 'interview.md'), 'utf8');
  assert.match(afterFirst, /1\. \[x\] Q: What is the objective\? A: Build a greeter/, 'checked, and the answer is written back, once handed to and processed by the agent');
  assert.match(afterFirst, /2\. \[ \] Q: Who uses the greeter\? A: Developers/, 'the second question is untouched, not yet asked');
  const logAfterFirst = readFileSync(join(dir, '.bish-bash-bosh', 'bish-log.md'), 'utf8');
  assert.match(logAfterFirst, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] bish\/analyst prompt: .*## Answer\n\nBuild a greeter/s, 'the full prompt sent to the agent is logged, plain text with a timestamp');
  out.length = 0;
  const done = await withCwd(dir, () =>
    main(['bish'], { registry, identity, input: Readable.from(['\n']), stdout: (s) => { out.push(s); }, stderr: () => {} }));
  assert.equal(done, 0);
  assert.match(out.join(''), /Who uses the greeter\?/);
  assert.match(out.join(''), /Interview complete: 1 question answered this run\./);
  assert.equal(a.prompts.length, 2, 'the second run handed its round to the agent too');
  const afterSecond = readFileSync(join(dir, '.bish-bash-bosh', 'interview.md'), 'utf8');
  assert.match(afterSecond, /2\. \[x\] Q: Who uses the greeter\? A: Developers/, 'Enter alone accepted the pre-filled default, and the line is checked once handed to and processed by the agent');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# target\n');
});

test('the agent session is persisted in .bish-bash-bosh/config.yml, not a separate file, and carries across bish invocations', async () => {
  const dir = makeRepo();
  commitProjectConfig(dir, config({ adapter: 'sess' }));
  writeFileSync(
    join(dir, '.bish-bash-bosh', 'interview.md'),
    `${readFileSync(join(process.cwd(), 'src', 'bish', 'templates', 'bish-interview.md'), 'utf8')}\n2. [ ] Q: Who uses the greeter? A: Developers\n`,
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed interview store');
  /** @type {object[]} */
  const seen = [];
  const sessioned = {
    run: async (/** @type {any} */ req) => {
      seen.push(req.session);
      return { exitStatus: 0, transcript: '', changedFiles: [], session: `s${seen.length}` };
    },
  };
  const registry = { sess: () => sessioned };
  await withCwd(dir, () => main(['bish'], { registry, identity, input: Readable.from(['Build a greeter\n']), stdout: () => {}, stderr: () => {} }));
  assert.equal(seen[0], undefined, 'no session yet on the very first round');
  let cfg = readFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'utf8');
  assert.match(cfg, /bishSession: s1/);
  assert.ok(!existsSync(join(dir, '.bish-bash-bosh', 'interview-session.json')), 'no separate session file is written');
  await withCwd(dir, () => main(['bish'], { registry, identity, input: Readable.from(['\n']), stdout: () => {}, stderr: () => {} }));
  assert.equal(seen[1], 's1', 'the second round resumes the session the first round returned');
  cfg = readFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'utf8');
  assert.match(cfg, /bishSession: s2/);
});

test('bish usage errors exit 2', async () => {
  const err = /** @type {string[]} */ ([]);
  const e = (/** @type {string} */ s) => { err.push(s); };
  const missing = initGitRepo(mkdtempSync(join(tmpdir(), 'bish-int-missing-')));
  writeFileSync(join(missing, 'README.md'), '# target\n');
  assert.equal(await withCwd(missing, () => main(['bish'], { input: Readable.from([]), stdout: () => {}, stderr: e })), 2);
  assert.match(err.join(''), /no adapter given/);

  const norole = initGitRepo(mkdtempSync(join(tmpdir(), 'bish-int-norole-')));
  writeFileSync(join(norole, 'README.md'), '# target\n');
  writeProjectConfig(norole, config({ adapter: 'missing' }));
  mkdirSync(join(norole, '.bish-bash-bosh'), { recursive: true });
  writeFileSync(join(norole, '.bish-bash-bosh', 'interview.md'), '# Interview\n');
  err.length = 0;
  // the Interview Loop itself never resolves an adapter; only --reverse still does
  assert.equal(await withCwd(norole, () => main(['bish', '--reverse'], { registry: { f: () => agent({}).adapter }, stdout: () => {}, stderr: e })), 2);
  assert.match(err.join(''), /unknown adapter 'missing'/);

  err.length = 0;
  assert.equal(await withCwd(norole, () => main(['bosh', 'step', '--objective', 'x'], { stdout: () => {}, stderr: e })), 2);
});

test('readlineOptions: a TTY input gets terminal mode so Enter submits; piped input stays plain', async () => {
  const { readlineOptions } = await import('../../src/cli/cli.js');
  const tty = Object.assign(new Readable({ read() {} }), { isTTY: true });
  assert.equal(readlineOptions(tty).terminal, true);
  assert.ok(readlineOptions(tty).output);
  assert.equal(readlineOptions(Readable.from([])).terminal, undefined);
});

test("createAsker: on a real terminal, a question's existing default is shown as a grey suggestion ahead of the cursor; any key but Enter clears all of it in one go, and typing afterward inherits the prompt's own color", async () => {
  const { createAsker } = await import('../../src/cli/cli-lib.js');
  /** @type {string[]} */
  let chunks;
  const freshOutput = () => Object.assign(new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } }), { isTTY: true, columns: 80 });

  // Enter alone, default untouched: submits the default verbatim, rendered in grey ahead of the cursor,
  // then recolored to the prompt's own color as it is accepted (so it no longer reads as a suggestion).
  {
    chunks = [];
    const input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const { ask } = createAsker(input, () => {}, freshOutput());
    const reply = ask('\x1b[33mA: ', 'Developers');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(chunks.some((c) => c.includes('\x1b[90mDevelopers')), 'the default is shown in grey');
    assert.ok(chunks.some((c) => c.includes('\x1b[10D')), 'the cursor is moved back before the grey suggestion, not left after it');
    chunks = [];
    input.push('\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(chunks.includes('\x1b[33mDevelopers'), 'accepting via Enter recolors the suggestion to the prompt\'s own color, not left grey');
    assert.equal(await reply, 'Developers');
  }

  // A single Backspace clears the whole default at once (not character by character), and the "A: "
  // label's own color is what the (now empty) line is left in, ready for a fresh answer.
  {
    chunks = [];
    const input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const { ask } = createAsker(input, () => {}, freshOutput());
    const reply = ask('\x1b[33mA: ', 'Developers');
    await new Promise((r) => setTimeout(r, 20));
    chunks = [];
    input.push('\x7f');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(chunks, ['\x1b[0K'], 'one Backspace erases the entire suggestion in a single write, not one character at a time');
    input.push('\r');
    assert.equal(await reply, '', 'the default is fully gone, not merely hidden');
  }

  // Clearing the default and typing something else submits the new text, not the old default.
  {
    chunks = [];
    const input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const { ask } = createAsker(input, () => {}, freshOutput());
    const reply = ask('\x1b[33mA: ', 'Developers');
    await new Promise((r) => setTimeout(r, 20));
    input.push('\x7f');
    input.push('Admins');
    input.push('\r');
    assert.equal(await reply, 'Admins');
  }

  // A key other than Delete/Backspace (e.g. typing straight over the suggestion) clears it the same way.
  {
    chunks = [];
    const input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const { ask } = createAsker(input, () => {}, freshOutput());
    const reply = ask('\x1b[33mA: ', 'Developers');
    await new Promise((r) => setTimeout(r, 20));
    chunks = [];
    input.push('Q');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(chunks.includes('\x1b[0K'), 'the first keypress, even a plain character, clears the suggestion before it is typed over');
    input.push('\r');
    assert.equal(await reply, 'Q');
  }
});

test('createAsker: an arrow key as the first action turns the suggestion into editable text; a suggestion wider than the terminal is cleared and returned to across rows', async () => {
  const { createAsker } = await import('../../src/cli/cli-lib.js');
  let chunks = [];
  const output = (columns) => Object.assign(new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } }), { isTTY: true, columns });
  const wait = () => new Promise((r) => setTimeout(r, 20));

  const input = Object.assign(new Readable({ read() {} }), { isTTY: true });
  const reply = createAsker(input, () => {}, output(80)).ask('\x1b[33mA: ', 'Developers');
  await wait();
  input.push('\x1b[D');
  await wait();
  input.push('X');
  input.push('\r');
  assert.equal(await reply, 'DeveloperXs', 'the default stays, with the cursor one place in from its end');

  chunks = [];
  const narrow = Object.assign(new Readable({ read() {} }), { isTTY: true });
  const wrapped = createAsker(narrow, () => {}, output(10)).ask('\x1b[33mA: ', 'Developers');
  await wait();
  assert.ok(chunks.includes('\x1b[1A\x1b[4G'), 'the cursor goes back up a row to just after the prompt');
  chunks = [];
  narrow.push('Z');
  await wait();
  assert.ok(chunks.includes('\x1b[0J'), 'typing over a wrapped suggestion clears every row of it');
  narrow.push('\r');
  assert.equal(await wrapped, 'Z');
});

test('bish refuses to start without a README.md in the project root, before asking for config or calling the agent', async () => {
  const dir = makeRepo();
  rmSync(join(dir, 'README.md'));
  const a = agent({});
  const err = /** @type {string[]} */ ([]);
  const code = await withCwd(dir, () =>
    main(['bish'], { registry: { f: () => a.adapter }, identity, stdout: () => {}, stderr: (s) => { err.push(s); } }));
  assert.equal(code, 2);
  assert.match(err.join(''), /README\.md not found in the project root/);
  assert.equal(a.prompts.length, 0);
  assert.ok(!existsSync(join(dir, '.bish-bash-bosh')), 'nothing written');
});

test('if the bootstrap agent leaves the templates untouched, bish fails and discards the seeded files so the next run retries', async () => {
  const dir = makeRepo();
  commitProjectConfig(dir, config({ adapter: 'iv' }));
  const a = agent({});
  const err = /** @type {string[]} */ ([]);
  const code = await withCwd(dir, () =>
    main(['bish'], { registry: { iv: () => a.adapter }, identity, stdout: () => {}, stderr: (s) => { err.push(s); } }));
  assert.equal(code, 2);
  assert.match(err.join(''), /specification\.md unchanged/);
  for (const f of ['interview.md', 'specification.md']) assert.ok(!existsSync(join(dir, '.bish-bash-bosh', f)), f);
  assert.match(readFileSync(join(dir, '.bish-bash-bosh', 'bish-log.md'), 'utf8'), /bish\/analyst prompt:/, 'the log is kept so the failed call can be read');
});

test('a failed bootstrap reports the agent\'s exit status and last output so the reason is visible', async () => {
  const dir = makeRepo();
  commitProjectConfig(dir, config({ adapter: 'iv' }));
  const adapter = { run: async () => ({ exitStatus: 1, transcript: 'model not available', changedFiles: [] }) };
  const err = /** @type {string[]} */ ([]);
  const code = await withCwd(dir, () =>
    main(['bish'], { registry: { iv: () => adapter }, identity, stdout: () => {}, stderr: (s) => { err.push(s); } }));
  assert.equal(code, 2);
  assert.match(err.join(''), /\(agent exit status 1\)\nLast agent output:\nmodel not available/);
});
