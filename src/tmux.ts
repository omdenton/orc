import { spawnSync } from 'node:child_process';

/**
 * All orc tmux state lives on a dedicated socket so it never collides with the
 * user's normal tmux server, and we can set root key-bindings freely.
 */
export const SOCKET = 'orc';
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
}

const PANE_FMT = [
  '#{session_name}',
  '#{window_id}',
  '#{pane_id}',
  '#{@orc}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_dead}',
].join('\t');

export function listPanes(): PaneInfo[] {
  const r = tmux(['list-panes', '-a', '-F', PANE_FMT]);
  if (r.code !== 0 || !r.stdout) return [];
  const out: PaneInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const [session, windowId, paneId, tag, cmd, cwd, dead] = line.split('\t');
    out.push({ session, windowId, paneId, tag: tag ?? '', cmd, cwd, dead: dead === '1' });
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

// Claude's active-turn footer. Tunable — verify against a real working session.
const WORKING_MARKERS = [/esc to interrupt/i, /\(esc\b/i];
// Commands that mean "claude is still the foreground process in this pane".
const CLAUDE_CMDS = new Set(['claude', 'node', 'bun', 'deno']);

/** Pure classifier — `cmd` is the pane's foreground command, `text` its screen. */
export function classifyCapture(cmd: string, text: string): Status {
  if (!CLAUDE_CMDS.has(cmd)) return 'dead'; // dropped back to a shell
  if (WORKING_MARKERS.some((re) => re.test(text))) return 'running';
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
  return { ...pane, tag };
}
