import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { commitAll, isGitRepo, subject } from '../../src/shared/git-commit.js';
import { freshDir, initGitRepo } from '../support/project.js';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

test('commitAll commits everything except the git-ignored harness folder, and reports false when there is nothing to commit', () => {
  const dir = initGitRepo(freshDir('gc-'));
  mkdirSync(join(dir, '.bish-bash-bosh'));
  writeFileSync(join(dir, '.bish-bash-bosh', 'lock'), '1\n');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  assert.equal(commitAll(dir, 'first\n\nbody'), true);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'first');
  assert.equal(git(dir, 'ls-files'), '.gitignore\na.txt');
  assert.equal(commitAll(dir, 'again'), false);
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1');
});

test('isGitRepo tells a repo from a plain folder, and subject keeps a commit subject to one short line', () => {
  assert.equal(isGitRepo(initGitRepo(freshDir('gc-'))), true);
  assert.equal(isGitRepo(freshDir('gc-')), false);
  assert.equal(subject('a\n  b'), 'a b');
  assert.ok(subject('x'.repeat(300)).length <= 100);
});

test('ignoreHarness stops tracking a harness folder an earlier version committed, and commitAll then commits the removal', () => {
  const dir = initGitRepo(freshDir('gc-'));
  mkdirSync(join(dir, '.bish-bash-bosh'));
  writeFileSync(join(dir, '.bish-bash-bosh', 'plan.md'), 'x\n');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'old');
  assert.equal(commitAll(dir, 'new'), true);
  assert.equal(git(dir, 'ls-files'), '.gitignore\na.txt');
});
