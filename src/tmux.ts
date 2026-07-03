import { spawnSync } from 'node:child_process';

/**
 * All orc tmux state lives on a dedicated socket so it never collides with the
 * user's normal tmux server, and we can set root key-bindings freely.
 *
 * Overridable via $ORC_SOCKET so destructive tooling (stage-test, which calls
 * kill-server) can run on a throwaway socket and NEVER touch a live `orc`
 * dashboard + its hosted sessions. Production always uses the default 'orc'.
 */
export const SOCKET = process.env.ORC_SOCKET || 'orc';
export const DASH_SESSION = 'orc';
export const SESSION_PREFIX = 'orc-';

// Pane identity is carried in a pane-scoped tmux user option `@orc` (NOT the
// pane title — Claude Code sets its own title and would clobber it). The option
// travels with the pane across swap-pane and is invisible to the app.
export const DASH_TAG = '__dash__';
export const PLACEHOLDER_TAG = '__placeholder__';
const SESSION_TAG_PREFIX = 's|'; // s|<resumeId>|<label>

function tmux(args: string[]) {
  const r = spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout ?? '').replace(/\n$/, ''),
    stderr: r.stderr ?? '',
  };
}

export function tmuxAvailable(): boolean {
  const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  return (r.status ?? 1) === 0;
}

export function hasSession(name: string): boolean {
  return tmux(['has-session', '-t', name]).code === 0;
}

// ---------------------------------------------------------------------------
// Pane queries
// ---------------------------------------------------------------------------

export interface PaneInfo {
  session: string;
  windowId: string;
  paneId: string;
  tag: string; // our @orc identity option
  cmd: string;
  cwd: string;
  dead: boolean; // process exited but pane kept (remain-on-exit)
  born: string; // @orc_born: ms timestamp the pane was created (or '' if unset)
}

const PANE_FMT = [
  '#{session_name}',
  '#{window_id}',
  '#{pane_id}',
  '#{@orc}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_dead}',
  '#{@orc_born}',
].join('\t');

export function listPanes(): PaneInfo[] {
  const r = tmux(['list-panes', '-a', '-F', PANE_FMT]);
  if (r.code !== 0 || !r.stdout) return [];
  const out: PaneInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const [session, windowId, paneId, tag, cmd, cwd, dead, born] = line.split('\t');
    out.push({ session, windowId, paneId, tag: tag ?? '', cmd, cwd, dead: dead === '1', born: born ?? '' });
  }
  return out;
}

export function paneByTag(tag: string): PaneInfo | undefined {
  return listPanes().find((p) => p.tag === tag);
}

/** The pane this process is running in. Uses $TMUX_PANE (set by tmux in every
 *  pane) so it resolves even when no client is attached. */
export function selfPaneId(): string {
  return process.env.TMUX_PANE ?? tmux(['display-message', '-p', '#{pane_id}']).stdout;
}

export function selfWindowId(): string {
  const pane = process.env.TMUX_PANE;
  const args = pane
    ? ['display-message', '-p', '-t', pane, '#{window_id}']
    : ['display-message', '-p', '#{window_id}'];
  return tmux(args).stdout;
}

// ---------------------------------------------------------------------------
// Pane operations
// ---------------------------------------------------------------------------

/** Tag a pane with our identity option (survives Claude renaming the title). */
export function setPaneTag(paneId: string, tag: string): void {
  tmux(['set-option', '-p', '-t', paneId, '@orc', tag]);
}

export function setPaneOption(paneId: string, opt: string, val: string): void {
  tmux(['set-option', '-p', '-t', paneId, opt, val]);
}

/** Restart a pane's command in place (keeps the pane id, tag, and options). */
export function respawnPane(paneId: string, command: string): void {
  tmux(['respawn-pane', '-k', '-t', paneId, command]);
}

export function capturePane(paneId: string): string {
  const r = tmux(['capture-pane', '-t', paneId, '-p']);
  return r.code === 0 ? r.stdout : '';
}

export function selectPane(paneId: string): void {
  tmux(['select-pane', '-t', paneId]);
}

/** Bring `src` into `dst`'s position; `dst` is sent to `src`'s old position. */
export function swapPane(srcPaneId: string, dstPaneId: string): void {
  tmux(['swap-pane', '-s', srcPaneId, '-t', dstPaneId]);
}

export function killPane(paneId: string): void {
  tmux(['kill-pane', '-t', paneId]);
}

export function detachClient(): void {
  tmux(['detach-client']);
}

/** Tear down the entire orc server: dashboard + every hosted session. */
export function killServer(): void {
  tmux(['kill-server']);
}

// ---------------------------------------------------------------------------
// Dashboard bootstrap helpers
// ---------------------------------------------------------------------------

export function newDashboard(cols: number, rows: number, command: string): void {
  tmux(['new-session', '-d', '-s', DASH_SESSION, '-x', String(cols), '-y', String(rows), command]);
}

export function splitRight(targetPaneId: string, command: string): void {
  tmux(['split-window', '-h', '-t', targetPaneId, command]);
}

export function resizePaneWidth(paneId: string, cols: number): void {
  tmux(['resize-pane', '-t', paneId, '-x', String(cols)]);
}

export function bindRootKey(key: string, ...cmd: string[]): void {
  tmux(['bind-key', '-n', key, ...cmd]);
}

/** Remove a root-table binding (e.g. one leaked in from the user's tmux.conf). */
export function unbindRootKey(key: string): void {
  tmux(['unbind-key', '-n', key]);
}

/** Bind a key/event within a specific tmux key table (e.g. 'copy-mode-vi'). */
export function bindKeyInTable(table: string, key: string, ...cmd: string[]): void {
  tmux(['bind-key', '-T', table, key, ...cmd]);
}

export function setGlobalOption(opt: string, val: string): void {
  tmux(['set-option', '-g', opt, val]);
}

export function setWindowOption(opt: string, val: string): void {
  tmux(['set-window-option', '-g', opt, val]);
}

export function setHook(hook: string, command: string): void {
  tmux(['set-hook', '-g', hook, command]);
}

export function selectLayout(name: string): void {
  tmux(['select-layout', name]);
}

/** Attach to the dashboard, blocking until the client detaches. */
export function attachBlocking(): number {
  const env = { ...process.env };
  delete env.TMUX; // allow attaching even when launched from inside another tmux
  const r = spawnSync('tmux', ['-L', SOCKET, 'attach-session', '-t', DASH_SESSION], {
    stdio: 'inherit',
    env,
  });
  return r.status ?? 0;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Status = 'running' | 'ready' | 'dead';

// Claude's live-status indicator only ever lives in the BOTTOM CHROME — the
// `⏵⏵ … esc to interrupt …` mode line, and the dim status slot just above the
// input box. It is NEVER in the scrollback. We must scope the scan to the last
// few lines: the same phrases ("esc to interrupt", "… to finish") routinely
// appear in the *conversation itself* (a chat about Claude's own UI is the
// cautionary example), and a whole-pane scan matches that prose and pins the
// session to "running" forever. Verify these against a real session if status
// starts misreporting — they're coupled to Claude Code's wording.

// The interruptible-turn hint, shown in the bottom `⏵⏵` mode line only while a
// turn is actively working: "… (shift+tab to cycle) · esc to interrupt · …".
// Absent when idle. Scanned in the bottom few lines (chrome), never the body.
const WORKING_MODE_LINE = /\besc to interrupt\b/i;
// The background-wait status line: shown when the main turn has ENDED but a
// dynamic workflow / background agents (ultracode) are still running — there is
// no "esc to interrupt" then. Real form: "✻ Waiting for 1 dynamic workflow to
// finish". Anchored to a whole line — leading spinner glyph + spaces allowed,
// then it must START with "Waiting for N" and END with "to finish" — so the
// phrase embedded in a transcript sentence ("…the 'Waiting for … to finish'
// footer…") can't trigger it (that line starts with other words).
const BG_WAIT_FOOTER = /^[^\w\n]*waiting for \d+\b.*\bto finish[^\S\n]*$/im;
// Commands that mean "claude is still the foreground process in this pane".
const CLAUDE_CMDS = new Set(['claude', 'node', 'bun', 'deno']);

/** Last `n` lines of `text` (trailing blanks trimmed first), as one string. */
function tailLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/** Pure classifier — `cmd` is the pane's foreground command, `text` its screen. */
export function classifyCapture(cmd: string, text: string): Status {
  if (!CLAUDE_CMDS.has(cmd)) return 'dead'; // dropped back to a shell
  // Mode line sits in the last ~5 lines (input box + mode/context chrome).
  if (WORKING_MODE_LINE.test(tailLines(text, 5))) return 'running';
  // The bg-wait status slot sits just above the input box; allow more headroom.
  if (BG_WAIT_FOOTER.test(tailLines(text, 10))) return 'running';
  return 'ready';
}

export function statusOfPane(pane: PaneInfo): Status {
  return classifyCapture(pane.cmd, capturePane(pane.paneId));
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface LiveSession {
  paneId: string;
  tmuxSession: string;
  windowId: string;
  resumeId: string; // claude session id this was started from, or 'new'
  label: string;
  cwd: string;
  status: Status;
  born: number; // ms timestamp the pane was created (0 if pre-dates this field)
}

function parseSessionTag(tag: string): { resumeId: string; label: string } | null {
  if (!tag.startsWith(SESSION_TAG_PREFIX)) return null;
  const rest = tag.slice(SESSION_TAG_PREFIX.length);
  const sep = rest.indexOf('|');
  if (sep < 0) return { resumeId: rest, label: '' };
  return { resumeId: rest.slice(0, sep), label: rest.slice(sep + 1) };
}

/** All claude sessions orc is hosting (identified by the @orc pane option). */
export function liveSessions(): LiveSession[] {
  const out: LiveSession[] = [];
  for (const p of listPanes()) {
    const parsed = parseSessionTag(p.tag);
    if (!parsed) continue;
    out.push({
      paneId: p.paneId,
      tmuxSession: p.session,
      windowId: p.windowId,
      resumeId: parsed.resumeId,
      label: parsed.label,
      cwd: p.cwd,
      status: statusOfPane(p),
      born: Number(p.born) || 0,
    });
  }
  return out;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let counter = 0;

export interface CreateOpts {
  label: string;
  cwd: string;
  resumeId?: string;
}

/**
 * Start a new background claude session (detached). Always skips permissions.
 * Returns the new pane, or null if tmux refused.
 */
export function createSession(opts: CreateOpts): PaneInfo | null {
  const name = `${SESSION_PREFIX}${Date.now().toString(36)}${(counter++).toString(36)}`;
  const argv = ['claude', '--dangerously-skip-permissions'];
  if (opts.resumeId && opts.resumeId !== 'new') argv.push('--resume', opts.resumeId);
  const cmd = argv.map(shellQuote).join(' ');

  const r = tmux(['new-session', '-d', '-s', name, '-c', opts.cwd, cmd]);
  if (r.code !== 0) return null;

  const pane = listPanes().find((p) => p.session === name);
  if (!pane) return null;

  const tag = `${SESSION_TAG_PREFIX}${opts.resumeId ?? 'new'}|${opts.label}`;
  setPaneTag(pane.paneId, tag);
  // Birth timestamp: lets the UI tell a brand-new session's own transcript
  // (written once the user sends a message) from pre-existing ones in the cwd.
  setPaneOption(pane.paneId, '@orc_born', String(Date.now()));
  return { ...pane, tag, born: String(Date.now()) };
}
