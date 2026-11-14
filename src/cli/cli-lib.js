import { createInterface } from 'node:readline';
import { loadProjectConfig, CONFIG_FILE } from '../shared/project-config.js';
import { isGitRepo } from '../shared/git-commit.js';

export const LOGO = [
  ' \x1b[0;31m╷  .   ╷  \x1b[0m \x1b[0;32m╷        ╷  \x1b[0m \x1b[0;34m╷        ╷  \x1b[0m',
  ' \x1b[0;31m├─╮╷╭─╮├─╮\x1b[0m \x1b[0;32m├─╮╭─╮╭─╮├─╮\x1b[0m \x1b[0;34m├─╮╭─╮╭─╮├─╮\x1b[0m',
  '-\x1b[0;31m│ ││╰─╮│ │\x1b[0m-\x1b[0;32m│ │╭─┤╰─╮│ │\x1b[0m-\x1b[0;34m│ ││ │╰─╮│ │\x1b[0m',
  ' \x1b[0;31m└─╯╵╰─╯╵ ╵\x1b[0m \x1b[0;32m└─╯╰─╯╰─╯╵ ╵\x1b[0m \x1b[0;34m└─╯╰─╯╰─╯╵ ╵\x1b[0m'
].join('\n');

export function helpText() {
  return [
    '',
    '-bish-bash-bosh: harness for loop engineering software delivery.',
    '',
    'Commands:',
    '',
    '  -bish [Interview & Specification]',
    '    Usage: -bish [--reverse] [--debug]',
    '    Requires README.md in the project root. If config is missing, asks for the adapter/model and writes `.bish-bash-bosh/config.yml` (the whole folder is git-ignored); blank input or EOF aborts without writing config. Existing invalid config is an error, not a reason to reset setup.',
    '    The very first run writes `.bish-bash-bosh/interview.md` and `.bish-bash-bosh/specification.md` from their templates, has the agent draft both from README.md (baseline specification and initial questions), and exits for review.',
    '    Run again to start the Interview Loop: it finds the first unanswered question in `interview.md`, shows it in colour, reads your answer from stdin (Enter alone keeps any existing default text), hands the round to the agent, marks its answered checkbox, and repeats; Ctrl-D (EOF) pauses and a rerun resumes.',
    '    With --reverse it instead reverse-engineers `.bish-bash-bosh/specification.md` from existing code (commits only if nothing else changed and the specification has well-formed items).',
    '    Exit 0 only when ok (or, without --reverse, once every question is answered).',
    '',
    '  -bash [Solution Design & Implementation Plan]',
    '    Usage: -bash [--debug]',
    '    Refuses to run until `.bish-bash-bosh/specification.md` exists (run `-bish` first). The very first run writes `.bish-bash-bosh/plan.md` from its template, then makes one agent call that studies the whole specification and the existing code and writes a prioritised checklist of build tasks into plan.md (re-run to re-plan).',
    '    Prints a plain summary of items processed; exit 0 only when ok.',
    '',
    '  -bosh [Build/Test & Verify]',
    '    Usage: -bosh [--debug]',
    '    Refuses to run until `.bish-bash-bosh/plan.md` exists (run `-bash` first). The Build Loop hands each unprocessed plan.md item to the agent in turn, writing the actual files and configuration for it in the project root, until every item is processed.',
    '    Prints a plain summary of items processed; exit 0 only when ok.',
    '',
    'All commands:',
    '  Operate on the current project (cwd); there is no sandbox dir and no `--dir` flag. Config lives in `./.bish-bash-bosh/config.yml`, written by `-bish` when missing, validated and reused, never overwritten; there is no separate setup command.',
    '  Hold a single-run lock (.bish-bash-bosh/lock, PID; stale locks are cleared) and refuse to start while another live run holds the project.',
    '  --debug: log to stdout the agent prompt, the agent process raw stdout/stderr live, each call\'s exit status, changed files and parsed transcript, and stack traces. The transcript is agent output, not the environment, but it may contain whatever the agent printed: do not share debug logs unreviewed.',
    '',
  ].join('\n');
}

// helpText() without its leading LOGO + blank line: used where the logo is already printed separately
// (the unknown-command error on stderr, alongside the unconditional per-invocation logo).
export function usageText() {
  return helpText().replace(`${LOGO}\n\n`, '');
}

// The one fixed internal run slot under `.bish-bash-bosh/runs/`; never user-selectable.
export const RUN_ID = 'default';

// Every command works on the current project directory: the config and repo all live in
// `./.bish-bash-bosh/config.yml`. The commands take no flags beyond `--reverse` and `--debug`, which
// parseRunArgs strips first, so anything left over is an error.
export function parseStepArgs(args) {
  if (args.length > 0) return { ok: false, error: `unknown argument '${args[0]}'` };
  return { ok: true, runId: RUN_ID };
}

// In debug mode, print to stdout the agent process raw stdout/stderr live, then each call's exit status, changed files and parsed transcript.
export function debugAdapter(adapter, label, debug, out) {
  if (!debug) return adapter;
  return {
    run: async (req) => {
      const limitsText = Object.entries(req.limits ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(', ');
      out(`[debug] ${label}: agent start (cwd ${req.cwd}${limitsText ? `, ${limitsText}` : ''})\n[debug] ${label}: prompt begin\n${req.prompt}\n[debug] ${label}: prompt end\n`);
      const res = await adapter.run({ ...req, onOutput: (stream, chunk) => out(stream === 'stdout' ? chunk : `[${label} stderr] ${chunk}`) });
      out(`\n[debug] ${label}: exit ${res.exitStatus}, changed: ${res.changedFiles.length === 0 ? 'none' : res.changedFiles.join(', ')}\n`);
      out(`[debug] ${label}: transcript begin\n${res.transcript}\n[debug] ${label}: transcript end\n`);
      return res;
    },
  };
}

// On a real terminal, readline must own the tty (raw mode, \r as Enter); otherwise a previous child
// process can leave the tty in a state where Enter never submits the line. `output` defaults to
// process.stdout but is overridable (tests inject a capturing stream to assert the exact bytes a
// real terminal would receive).
/**
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} input
 * @param {NodeJS.WritableStream} [output]
 */
export function readlineOptions(input, output = process.stdout) {
  return input.isTTY ? { input, output, terminal: true } : { input };
}

// Undo terminal modes a child process may have left on: kitty keyboard protocol, modifyOtherKeys, bracketed paste;
// and put the tty back into raw mode so readline sees Enter.
export function resetTty(input) {
  process.stdout.write('\x1b[<u\x1b[>4;0m\x1b[?2004l');
  input.setRawMode?.(false);
  input.resume();
}

const GREY = '\x1b[90m';

// The last SGR (color) escape sequence appearing anywhere in `prompt` — i.e. whatever color is
// still active once the prompt's own text has been printed, so the grey default and the owner's
// own typing can both be returned to it.
function lastColor(prompt) {
  const matches = [...prompt.matchAll(/\x1b\[[0-9;]*m/g)];
  return matches.length ? matches[matches.length - 1][0] : '';
}

// One reader for `bish`'s setup and interview prompts, including buffered piped answers.
// Piped input must keep one reader (a second one would lose buffered lines); a tty gets a fresh reader
// per question so tty state left by a child process (cooked mode, keyboard protocols) cannot break Enter.
// On a real terminal, `defaultValue` is shown in grey as a suggestion ahead of the cursor, in the
// prompt's own color otherwise (so typed text matches it) — not actually in the editable line, since an
// owner must be able to erase the whole thing in a single Backspace/Delete, not character by character.
// The first keypress other than Enter clears that suggestion and marks the line "touched" (an arrow, Home or End
// instead turns it into real editable text, so a nearly right default can be adjusted); Enter with
// no other keypress first submits the suggestion verbatim, exactly as if the owner had typed it —
// recoloring the grey suggestion to the prompt's own color as it is accepted, so it no longer reads as
// a mere suggestion. Piped input has no such line to edit, so `defaultValue` is ignored there — the
// "Enter alone accepts the default" fallback piped callers rely on lives in `runInterviewLoop` instead.
/**
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} input
 * @param {(s: string) => void} out
 * @param {NodeJS.WritableStream} [output]
 */
export function createAsker(input, out, output = process.stdout) {
  const tty = input.isTTY === true;
  const shared = tty ? undefined : createInterface(readlineOptions(input));
  const sharedLines = shared?.[Symbol.asyncIterator]();
  const ask = async (prompt, defaultValue) => {
    if (sharedLines) {
      out(prompt);
      const next = await sharedLines.next();
      return next.done ? null : next.value;
    }
    resetTty(input);
    const rl = createInterface(readlineOptions(input, output));
    rl.setPrompt(prompt);
    rl.prompt();
    if (!defaultValue) {
      try {
        for await (const line of rl) return line;
        return null;
      } finally {
        rl.close();
      }
    }
    let touched = false;
    let settled = false;
    // The suggestion can wrap over several rows on a narrow terminal, so working out where it started, and
    // clearing all of it, must allow for that rather than assume one row.
    const cols = output.columns || Infinity;
    const promptLen = prompt.replace(/\x1b\[[0-9;]*m/g, '').length;
    const total = promptLen + defaultValue.length;
    const wraps = total > cols;
    const backToStart = wraps
      ? `${Math.floor((total - 1) / cols) - Math.floor(promptLen / cols) > 0 ? `\x1b[${Math.floor((total - 1) / cols) - Math.floor(promptLen / cols)}A` : ''}\x1b[${(promptLen % cols) + 1}G`
      : `\x1b[${defaultValue.length}D`;
    const clearSuggestion = wraps ? '\x1b[0J' : '\x1b[0K';
    output.write(`${GREY}${defaultValue}${lastColor(prompt)}`);
    output.write(backToStart);
    const editKeys = new Set(['left', 'right', 'home', 'end']);
    const onKeypress = (_ch, key) => {
      if (touched || settled) return;
      if (key && (key.name === 'return' || key.name === 'enter')) {
        // Accepting the grey suggestion as-is: recolor it to match the prompt's own color (the
        // cursor is still sitting in front of it, unmoved since it was first drawn), so it reads
        // exactly as if it had been typed, rather than staying visibly grey once accepted.
        settled = true;
        output.write(clearSuggestion);
        output.write(`${lastColor(prompt)}${defaultValue}`);
        return;
      }
      touched = true;
      output.write(clearSuggestion);
      // An arrow, Home or End first means the owner wants to adjust the suggestion rather than replace it, so it
      // becomes real editable text (readline then applies the key to it); any other first key types over it.
      if (key && (editKeys.has(key.name) || (key.ctrl && (key.name === 'a' || key.name === 'e')))) rl.write(defaultValue);
    };
    input.prependListener('keypress', onKeypress);
    try {
      for await (const line of rl) return touched ? line : (line === '' ? defaultValue : line);
      return null;
    } finally {
      input.removeListener('keypress', onKeypress);
      rl.close();
    }
  };
  return { ask, close: () => shared?.close() };
}

// Prompt with a numbered list of suggested choices (e.g. `bish`'s adapter/model picker): prints the
// list, then accepts either the choice's number or any typed value (so a value outside the list, or
// scripted stdin, still works). Returns the chosen string, or '' if the answer is blank.
export async function askChoice(ask, out, label, choices) {
  const value = (c) => (typeof c === 'string' ? c : c.value);
  for (const [i, choice] of choices.entries()) out(`  ${i + 1}) ${typeof choice === 'string' ? choice : choice.label}\n`);
  const answer = await ask(`${label} (1-${choices.length}, or type your own): `);
  if (!answer) return '';
  const n = Number(answer);
  return Number.isInteger(n) && n >= 1 && n <= choices.length ? value(choices[n - 1]) : answer;
}

// Shared argument shape for bish/bash/bosh: the display label for error messages, whether
// `bish --reverse` was passed, debug mode, and the parsed remaining arguments.
export function parseRunArgs(cmd, argv) {
  const label = cmd;
  const reverse = cmd === 'bish' && argv.includes('--reverse');
  const debug = argv.includes('--debug');
  const parsed = parseStepArgs(argv.slice(1).filter((a) => !(reverse && a === '--reverse') && a !== '--debug'));
  return { label, reverse, debug, parsed };
}

// Loads the project config, writing a labelled error (and returning null) on failure.
// Every command needs the project to be a git repo, since the harness commits each loop's work.
export function requireGitRepo(label, err) {
  if (isGitRepo('.')) return true;
  err(`${label}: the project must be a git repository (run \`git init\`): the harness commits each loop's work.\n`);
  return false;
}

export function loadRunProject(label, err) {
  const project = loadProjectConfig('.');
  if (!project.ok) {
    err(`${label}: ${project.error}\n`);
    return null;
  }
  return project;
}

export { CONFIG_FILE };
