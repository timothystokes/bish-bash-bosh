import { Readable } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../../src/shared/config.js';
import { main } from '../../src/cli/cli.js';
import { draftingAdapter, freshDir, seedObjectiveProject, withCwd, writeProjectConfig } from '../support/project.js';

const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const buildConfig = {
  adapter: 'agent-x',
  model: 'model-y',
};
const identity = { root: '/nonexistent/bish-bash-bosh', remotes: [] };

// Seeds a project fixture (plan.md + package.json + .bish-bash-bosh/config.yml), committed clean. No kit is
// scaffolded any more: the interview store self-bootstraps on the first `bish` round.
function sandbox() {
  const dir = freshDir('objseed-');
  seedObjectiveProject(dir);
  writeProjectConfig(dir, buildConfig);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return { dir, repo: dir, config: buildConfig };
}

test('objective seed has no kit to copy: nothing under .bish-bash-bosh until bish bootstraps it', () => {
  const { repo } = sandbox();
  assert.ok(!existsSync(join(repo, '.bish-bash-bosh', 'interview.md')), 'no question until bish bootstraps the objective');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(repo, 'specs')), 'specs come from the conversation, not the seed');
});

test('config has a single adapter/model', () => {
  const { config } = sandbox();
  assert.deepEqual(validateConfig(config), { ok: true, errors: [] });
  assert.equal(config.adapter, 'agent-x');
  assert.equal(config.model, 'model-y');
});

test('bish has no --objective option (the objective is gathered interactively)', async () => {
  /** @type {string[]} */
  const errs = [];
  const code = await main(['bish', '--objective', 'x'], { stdout: () => {}, stderr: (s) => errs.push(s) });
  assert.equal(code, 2);
  assert.match(errs.join(''), /unknown argument '--objective'/);
});

test('bish on a fresh project seeds interview.md, then the Interview Loop asks its first question from stdin and hands the round to the agent', async () => {
  const { repo } = sandbox();
  // first run seeds .bish-bash-bosh/interview.md from the template and has the agent draft it from README.md
  let seed = '';
  const seedCode = await withCwd(repo, () =>
    main(['bish'], { registry: { 'agent-x': draftingAdapter }, input: Readable.from([]), stdout: (s) => (seed += s), stderr: () => {} }));
  assert.equal(seedCode, 1, seed);
  assert.equal(git(repo, 'ls-files', '.bish-bash-bosh'), '', 'the harness folder is git-ignored, so the draft is not committed');
  let out = '';
  /** @type {string[]} */
  const prompts = [];
  const code = await withCwd(repo, () =>
    main(['bish'], {
      registry: { 'agent-x': () => ({ run: async (req) => { prompts.push(req.prompt); return { exitStatus: 0, transcript: '', changedFiles: [] }; } }) },
      input: Readable.from(['\n']),
      stdout: (s) => (out += s),
      stderr: () => {},
    }),
  );
  assert.equal(code, 0, out);
  assert.match(out, /What is the objective\?/);
  assert.match(out, /Interview complete: 1 question answered this run\./);
  assert.equal(prompts.length, 1, 'the one question answered this run was handed to the agent');
  const afterLoop = readFileSync(join(repo, '.bish-bash-bosh', 'interview.md'), 'utf8');
  assert.match(afterLoop, /1\. \[x\] Q: What is the objective\? A: Unknown\./m, 'Enter alone accepted the pre-filled default, and the line is checked once handed to and processed by the agent');
});

test('objective seed package.json has a test script so the tests gate can run', () => {
  const { repo } = sandbox();
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
});
