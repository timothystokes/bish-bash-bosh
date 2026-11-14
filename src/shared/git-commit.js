// The harness (never the agents) owns git: the project must be a git repo, and each loop's completed unit of work is
// committed here (never pushed). The harness's own folder is git-ignored entirely: it is the means to the end,
// never part of the solution being committed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HARNESS_DIR = '.bish-bash-bosh';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function isGitRepo(dir) {
  try {
    return git(dir, 'rev-parse', '--is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
}

// Collapses a commit subject to one line of at most 100 characters.
export function subject(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 100 ? `${one.slice(0, 99).trimEnd()}…` : one;
}

// Makes sure `.gitignore` ignores the whole harness folder, and stops tracking anything of it that an earlier
// version committed (the removal is staged for the next commit). Returns true when `.gitignore` had to change.
export function ignoreHarness(dir) {
  const path = join(dir, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const listed = text.split(/\r?\n/).some((line) => ['', '/'].some((lead) => ['', '/'].some((tail) => line.trim() === `${lead}${HARNESS_DIR}${tail}`)));
  if (!listed) writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${HARNESS_DIR}/\n`);
  git(dir, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', HARNESS_DIR);
  return !listed;
}

// Stages everything under `dir` (the harness folder is ignored) and commits it. Returns false when there was nothing to
// commit; throws with git's own message when the commit fails (for example no user.name/user.email configured).
export function commitAll(dir, message) {
  try {
    ignoreHarness(dir);
    git(dir, 'add', '-A', '--', '.');
    if (git(dir, 'diff', '--cached', '--name-only').trim() === '') return false;
    git(dir, 'commit', '-q', '-m', message);
    return true;
  } catch (e) {
    throw new Error(`git commit failed: ${(e.stderr?.toString() || e.message).trim()}`);
  }
}
