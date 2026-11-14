import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { initProject } from '../../src/shared/init.js';
import { validateConfig } from '../../src/shared/config.js';
import { main, helpText } from '../../src/cli/cli.js';
import { freshDir, initGitRepo, withCwd } from '../support/project.js';


function proj() {
  const dir = freshDir('init-');
  writeFileSync(join(dir, 'README.md'), '# target\n');
  return initGitRepo(dir);
}

// An agent that does the bootstrap step: replaces both seeded templates, as src/bish/prompts/bish-analyst-init.js asks.
const drafting = () => ({
  async run(req) {
    // Only the bootstrap call drafts; the interview that follows in the same run gets an agent that does nothing.
    if (!req.prompt.startsWith('# Initial Specification')) return { exitStatus: 0, transcript: '', changedFiles: [] };
    writeFileSync(join(req.cwd, '.bish-bash-bosh', 'specification.md'), '# Specification\n\n1. [ ] C: Greet. B: Friendly.\n');
    writeFileSync(join(req.cwd, '.bish-bash-bosh', 'interview.md'), '# Interview\n\n1. [ ] Q: Who uses it? A: Developers\n');
    return { exitStatus: 0, transcript: '', changedFiles: [] };
  },
});
const draftingRegistry = { copilot: drafting, 'agent-x': drafting };

test('writes .bish-bash-bosh/config.yml with a single adapter/model', () => {
  const dir = freshDir('init-');
  const res = initProject({ dir, adapter: 'agent-x', model: 'model-y' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.dir, dir);
  assert.equal(res.config, join(dir, '.bish-bash-bosh', 'config.yml'));
  const cfg = parseYaml(readFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'utf8'));
  assert.deepEqual(validateConfig(cfg), { ok: true, errors: [] });
  assert.equal(cfg.adapter, 'agent-x');
  assert.equal(cfg.model, 'model-y');
  assert.ok(!('allowedPaths' in cfg), 'allowedPaths is gone: the agent may write any path');
  assert.ok(!('requireTestPlan' in cfg), 'requireTestPlan is gone: the test plan is always part of the build loop');
  assert.ok(!('roles' in cfg), 'roles is gone: there is a single adapter/model, not one per role');
  assert.ok(!('targetRepo' in cfg), 'targetRepo is gone: there is no separate target dir');
  assert.ok(!('bish-bash-bosh' in cfg), 'bish-bash-bosh (runtime-copy path) is gone: there is no runtime copy');
  assert.equal(res.committed, false, 'no git repo here, so nothing to commit');
});

test('ignores the harness folder and commits that .gitignore when run inside a git repo (so the tree is clean for bish/bosh)', () => {
  const dir = freshDir('init-');
  initGitRepo(dir);
  const res = initProject({ dir, adapter: 'agent-x', model: 'model-y' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.committed, true);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.bish-bash-bosh/\n');
  assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
});

test('automatic setup makes its own commit of only .gitignore, and the git-ignored harness folder is never committed', async () => {
  const dir = proj();
  initGitRepo(dir);
  writeFileSync(join(dir, 'owner-work.txt'), 'unfinished owner work\n');
  execFileSync('git', ['-C', dir, 'add', 'owner-work.txt']);
  const r = await withCwd(dir, () => run(['bish'], ['agent-x', 'model-y'], { registry: draftingRegistry }));
  assert.equal(r.code, 1, r.err); // the interview then pauses at its first unanswered question
  const root = execFileSync('git', ['-C', dir, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim();
  const committed = execFileSync('git', ['-C', dir, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', root], { encoding: 'utf8' }).trim();
  assert.equal(committed, '.gitignore');
  const tracked = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' });
  assert.doesNotMatch(tracked, /\.bish-bash-bosh/);
});

test('refuses to run if .bish-bash-bosh/config.yml already exists (no silent overwrite)', () => {
  const dir = freshDir('init-');
  mkdirSync(join(dir, '.bish-bash-bosh'), { recursive: true });
  writeFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'adapter: x\n');
  const res = initProject({ dir, adapter: 'agent-x', model: 'model-y' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /already exists/);
  assert.equal(readFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'utf8'), 'adapter: x\n');
});

test('requires an adapter and model', () => {
  const dir = freshDir('init-');
  assert.equal(initProject({ dir, adapter: '', model: 'm' }).ok, false);
  assert.equal(initProject({ dir, adapter: 'a', model: '' }).ok, false);
  assert.equal(initProject({ dir, adapter: undefined, model: 'm' }).ok, false);
  assert.equal(initProject({ dir, adapter: 'a', model: undefined }).ok, false);
});

test('no scaffolding: no target repo, no runtime copy, no launcher scripts', () => {
  const dir = freshDir('init-');
  initProject({ dir, adapter: 'agent-x', model: 'model-y' });
  for (const f of ['target', 'bish', 'bosh']) assert.ok(!existsSync(join(dir, f)), f);
});

test('help describes automatic setup in bish, not a separate init command', () => {
  assert.match(helpText(), /bish.*adapter.*model/s);
  assert.doesNotMatch(helpText(), /bish-bash-bosh init|^ {2}init /m);
});

async function run(args, lines = [], deps = {}) {
  const outs = [];
  const errs = [];
  const code = await main(args, { listModels: async () => undefined, ...deps, stdout: (s) => outs.push(s), stderr: (s) => errs.push(s), input: Readable.from(lines.map((l) => `${l}\n`)) });
  return { code, out: outs.join(''), err: errs.join('') };
}

test('first bish asks for a single adapter/model, ignores the harness folder, seeds and drafts the interview files from README.md', async () => {
  const dir = proj();
  initGitRepo(dir);
  const r = await withCwd(dir, () => run(['bish'], ['copilot', 'm1'], { registry: draftingRegistry }));
  assert.equal(r.code, 1, r.err); // the interview then pauses at its first unanswered question
  assert.match(r.out, /adapter.*model/s, 'prompts are shown');
  assert.doesNotMatch(r.out, /interview adapter|reverse adapter|build adapter|qa adapter/, 'one prompt, not one per role');
  assert.match(r.out, /Wrote \.bish-bash-bosh\/config\.yml \(adapter: copilot, model: m1\)\. The harness folder is git-ignored \(\.gitignore committed\)/);
  const cfg = parseYaml(readFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'utf8'));
  assert.equal(cfg.adapter, 'copilot');
  assert.equal(cfg.model, 'm1');
  for (const file of ['interview.md', 'specification.md', 'bish-log.md']) {
    assert.ok(existsSync(join(dir, '.bish-bash-bosh', file)), file);
  }
  assert.match(r.out, /Starting the interview/);
  assert.doesNotMatch(execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }), /\.bish-bash-bosh/, 'the harness folder is git-ignored');
});

test('every command refuses a project that is not a git repository', async () => {
  for (const cmd of ['bish', 'bash', 'bosh']) {
    const dir = freshDir('nogit-');
    writeFileSync(join(dir, 'README.md'), '# target\n');
    const r = await withCwd(dir, () => run([cmd], []));
    assert.equal(r.code, 2, cmd);
    assert.match(r.err, /must be a git repository/, cmd);
    assert.ok(!existsSync(join(dir, '.bish-bash-bosh')), cmd);
  }
});

test('first bish picks adapter/model by number from the suggested list', async () => {
  const dir = proj();
  const r = await withCwd(dir, () => run(['bish'], ['1', '2'], { registry: draftingRegistry, listModels: async () => ['auto', { value: 'live-1', label: 'live-1  (low cost)' }] }));
  assert.equal(r.code, 1, r.err); // the interview then pauses at its first unanswered question
  const cfg = parseYaml(readFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'utf8'));
  assert.equal(cfg.adapter, 'copilot');
  assert.equal(cfg.model, 'live-1');
});

test('bish rejects an invalid existing config without prompting or overwriting it', async () => {
  const dir = proj();
  mkdirSync(join(dir, '.bish-bash-bosh'), { recursive: true });
  writeFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'adapter: x\n');
  const r = await withCwd(dir, () => run(['bish'], []));
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid config/);
  assert.doesNotMatch(r.out, /adapter \(1-/);
  assert.equal(readFileSync(join(dir, '.bish-bash-bosh', 'config.yml'), 'utf8'), 'adapter: x\n');
});

test('first bish aborts without writing config or templates if no adapter or model is given', async () => {
  const dir1 = proj();
  const r1 = await withCwd(dir1, () => run(['bish'], ['']));
  assert.equal(r1.code, 2);
  assert.match(r1.err, /no adapter given/);
  const dir2 = proj();
  const r2 = await withCwd(dir2, () => run(['bish'], ['copilot', '']));
  assert.equal(r2.code, 2);
  assert.match(r2.err, /no model given/);
  for (const dir of [dir1, dir2]) assert.ok(!existsSync(join(dir, '.bish-bash-bosh')));
});

test('bish validates arguments before starting setup', async () => {
  const dir = proj();
  const r = await withCwd(dir, () => run(['bish', '--bogus', 'x'], []));
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown argument/);
  assert.ok(!existsSync(join(dir, '.bish-bash-bosh')));
});

test('the separate init command is removed', async () => {
  const r = await run(['init']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command 'init'/);
});

test('bish uses an existing valid config without prompting or rewriting it', async () => {
  const dir = proj();
  initProject({ dir, adapter: 'agent-x', model: 'model-y' });
  const path = join(dir, '.bish-bash-bosh', 'config.yml');
  const original = readFileSync(path, 'utf8');
  const r = await withCwd(dir, () => run(['bish'], [], { registry: draftingRegistry }));
  assert.equal(r.code, 1, r.err); // the interview then pauses at its first unanswered question
  assert.doesNotMatch(r.out, /adapter \(1-/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.ok(existsSync(join(dir, '.bish-bash-bosh', 'interview.md')));
});

test('bish --help does not start setup', async () => {
  const dir = proj();
  const r = await withCwd(dir, () => run(['bish', '--help']));
  assert.equal(r.code, 0);
  assert.ok(!existsSync(join(dir, '.bish-bash-bosh')));
});

test('bish --reverse also offers setup when config is missing', async () => {
  const dir = proj();
  const r = await withCwd(dir, () => run(['bish', '--reverse'], []));
  assert.equal(r.code, 2);
  assert.match(r.err, /no adapter given/);
  assert.ok(!existsSync(join(dir, '.bish-bash-bosh', 'interview.md')));
});

test('setup preserves an existing interview and shares buffered input with its next round', async () => {
  const dir = proj();
  const store = join(dir, '.bish-bash-bosh', 'interview.md');
  mkdirSync(join(dir, '.bish-bash-bosh'));
  writeFileSync(store, '# Interview\n\n1. [ ] Q: What shall we build? A: \n');
  const prompts = [];
  const registry = {
    'agent-x': () => ({
      async run(req) {
        prompts.push(req.prompt);
        return { exitStatus: 0, transcript: '', changedFiles: [] };
      },
    }),
  };
  const r = await withCwd(dir, () => run(['bish'], ['agent-x', 'model-y', 'A greeter'], { registry }));
  assert.equal(r.code, 0, r.err);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /A greeter/);
  assert.match(readFileSync(store, 'utf8'), /1\. \[x\] Q: What shall we build\? A: A greeter/);
  assert.ok(existsSync(join(dir, '.bish-bash-bosh', 'specification.md')));
});

test('setup reports filesystem errors instead of claiming success', async () => {
  const dir = proj();
  writeFileSync(join(dir, '.bish-bash-bosh'), 'not a directory');
  const r = await withCwd(dir, () => run(['bish'], ['agent-x', 'model-y'], { registry: draftingRegistry }));
  assert.equal(r.code, 2);
  assert.match(r.err, /bish:.*EEXIST/);
  assert.doesNotMatch(r.out, /Wrote/);
});

test('bish rejects malformed YAML without prompting or overwriting it', async () => {
  const dir = proj();
  mkdirSync(join(dir, '.bish-bash-bosh'));
  const path = join(dir, '.bish-bash-bosh', 'config.yml');
  writeFileSync(path, 'adapter: [\n');
  const r = await withCwd(dir, () => run(['bish']));
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid YAML/);
  assert.doesNotMatch(r.out, /adapter \(1-/);
  assert.equal(readFileSync(path, 'utf8'), 'adapter: [\n');
});

test('listModels fetches Copilot\'s own model list live (chat models the picker offers, after auto) and falls back to the static list on any failure', async () => {
  const { listModels, MODEL_CHOICES } = await import('../../src/shared/init.js');
  const data = [
    { id: 'm-a', model_picker_enabled: true, model_picker_category: 'powerful', capabilities: { type: 'chat' } },
    { id: 'hidden', model_picker_enabled: false },
    { id: 'embed', model_picker_enabled: true, capabilities: { type: 'embeddings' } },
    { id: 'm-b', model_picker_enabled: true },
  ];
  const ok = { fetchFn: async () => ({ ok: true, json: async () => ({ data }) }), getToken: () => 't' };
  assert.deepEqual(await listModels('copilot', ok), ['auto', { value: 'm-a', label: 'm-a  (high cost)' }, { value: 'm-b', label: 'm-b' }]);
  assert.deepEqual(await listModels('copilot', { ...ok, getToken: () => '' }), MODEL_CHOICES.copilot, 'no token');
  assert.deepEqual(await listModels('copilot', { ...ok, fetchFn: async () => { throw new Error('offline'); } }), MODEL_CHOICES.copilot);
  assert.deepEqual(await listModels('copilot', { ...ok, fetchFn: async () => ({ ok: false }) }), MODEL_CHOICES.copilot);
  assert.equal(await listModels('openai-http'), undefined, 'free-text adapters have no list');
});
