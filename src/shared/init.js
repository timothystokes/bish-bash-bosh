import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { validateConfig } from './config.js';
import { CONFIG_FILE } from './project-config.js';
import { ignoreHarness } from './git-commit.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// The config lives in the git-ignored harness folder, so there is nothing of it to commit. Reverse engineering
// requires a clean baseline, so the `.gitignore` entry that ignores the folder is committed when possible;
// otherwise the caller tells the owner to commit it by hand.
function commitConfig(dir, configPath) {
  try {
    git(dir, 'rev-parse', '--is-inside-work-tree');
  } catch {
    return false;
  }
  try {
    if (!ignoreHarness(dir)) return false;
    git(dir, 'add', '--', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'bish: ignore the harness folder', '--only', '--', '.gitignore');
    return true;
  } catch {
    return false;
  }
}

// Suggested picks shown by `bish`'s first-run setup (src/bish/bish.js). This is a
// convenience catalog only, not enforced anywhere: any adapter/model string still works (see
// src/adapters/index.js's registry and specs/adapters.md's documented exception for this list).
// It goes stale as vendors release models; update it by hand when that happens.
export const ADAPTER_CHOICES = ['copilot', 'claude-code', 'codex', 'openai-http'];
export const MODEL_CHOICES = {
  copilot: ['auto'], // the real list is fetched live, see listModels
  'claude-code': ['claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929'],
  codex: ['gpt-5-codex', 'gpt-5'],
  // openai-http hits an arbitrary /chat/completions endpoint: no catalog, type the model directly.
};

// Copilot's own model list for this account, fetched live from the same service the Copilot CLI uses
// (only chat models the picker offers, labelled with the picker's cost tier since the API gives no price), so it is never stale. Returns null on any failure (no token,
// offline, unexpected response) and the caller falls back to MODEL_CHOICES.
async function fetchCopilotModels({ fetchFn = fetch, getToken = defaultToken, timeoutMs = 8000 } = {}) {
  try {
    const token = getToken();
    if (!token) return null;
    const res = await fetchFn('https://api.githubcopilot.com/models', {
      headers: { Authorization: `Bearer ${token}`, 'Copilot-Integration-Id': 'copilot-developer-cli' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    const TIER = { lightweight: 'low cost', versatile: 'medium cost', powerful: 'high cost' };
    const models = data
      .filter((m) => m.model_picker_enabled && (m.capabilities?.type ?? 'chat') === 'chat')
      .map((m) => ({ value: m.id, label: TIER[m.model_picker_category] ? `${m.id}  (${TIER[m.model_picker_category]})` : m.id }));
    return models.length ? ['auto', ...models] : null;
  } catch {
    return null;
  }
}

function defaultToken() {
  const env = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

// The model pick-list for an adapter: live where the vendor offers a list (copilot), otherwise the
// static suggestions, or undefined for free-text entry.
export async function listModels(adapter, opts) {
  if (adapter === 'copilot') return (await fetchCopilotModels(opts)) ?? MODEL_CHOICES.copilot;
  return MODEL_CHOICES[adapter];
}

// `bish` setup: writes <dir>/.bish-bash-bosh/config.yml (default dir: cwd) with the single
// adapter/model the owner picked. Refuses if a config already exists.
// There is no sandbox to scaffold: no target repo, no runtime copy, no launcher scripts.
export function initProject({ dir, adapter, model }) {
  if (!adapter || !model) return { ok: false, reason: 'adapter and model are required' };
  const projectDir = resolve(dir ?? '.');
  const configPath = join(projectDir, CONFIG_FILE);
  if (existsSync(configPath)) return { ok: false, reason: `${configPath} already exists` };
  const cfg = {
    adapter,
    model,
  };
  const valid = validateConfig(cfg);
  if (!valid.ok) return { ok: false, reason: `invalid config: ${valid.errors.join('; ')}` };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringifyYaml(cfg));
  const committed = commitConfig(projectDir, configPath);
  return { ok: true, dir: projectDir, config: configPath, committed };
}
