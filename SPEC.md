# orc — Spec (v2, tmux-backed)

A terminal dashboard for Claude Code sessions. A fixed list of your sessions on
the **left**; the **live session on the right**; pick one and it swaps onto the
stage. Sessions **keep running in the background** whether or not they're on
screen. No git worktrees, no PR machinery — just background sessions + status +
jump in/out.

```
┌───────────────────────┬────────────────────────────────────┐
│ orc · 1 live / 64      │  (the selected session, live)       │
│ ↑↓ · enter · n · x · q │                                     │
│  ▶ ecm-org-setup       │  ❯ …interactive claude, fully       │
│ ❯⠹ api-refactor        │     yours to type into…             │
│  ✓ digest              │                                     │
│  ✓ notes               │  ⏵⏵ bypass permissions on           │
└───────────────────────┴────────────────────────────────────┘
   left = orc (always)       right = "the stage" (swaps)
```

## Model

- **Each session = its own detached tmux session** running
  `claude --dangerously-skip-permissions [--resume <id>]`. It keeps thinking
  whether or not it's the one on the stage.
- **The dashboard = one tmux session** (`orc`) with two panes: left runs the orc
  Ink UI, right is "the stage."
- Everything lives on a **dedicated tmux socket (`-L orc`)** — fully isolated
  from your normal tmux; lets orc set focus keybindings without touching your
  global config.
- **Picking a session** does a single `swap-pane` (by pane-id) against whatever's
  on the stage: the chosen session swaps on, the previous one parks off-stage
  (still running). `swap-pane` conserves pane count, so **no session is ever
  destroyed** by switching.

## Identity (the subtle bit)

Sessions are tracked by a **pane-scoped tmux user option `@orc`**
(`s|<resumeId>|<label>`), *not* the pane title — Claude Code sets its own pane
title and would clobber it. The option travels with the pane across swaps and is
invisible to the app, so identity survives both swapping and Claude's UI.

## Status (3 states + dead)

Read from each session's pane every ~1.5s:

| Icon | State | Detection |
|------|-------|-----------|
| animated spinner (cyan) | **running** | pane shows Claude's working footer (`esc to interrupt`) |
| `▶` (green) | **ready for input** | claude is the foreground process, not currently working |
| `✗` (red) | **dead** | claude exited back to a shell (restartable) |
| `✓` (grey) | **idle** | a historical transcript not currently running (start it to make it live) |

The "running" marker (`esc to interrupt`) is tunable in `src/tmux.ts`
(`WORKING_MARKERS`) — verify against a real working session.

## The list

Merges **live sessions** (running/ready/dead, from tmux) with your **historical
sessions** (idle, from `~/.claude/projects/**/*.jsonl`). Selecting:

- a **live** row → swap it onto the stage + focus it.
- an **idle** historical row → start `claude --resume <id>` in its cwd as a new
  background session, then swap it on.

## Keys

In the orc list (left pane):

| Key | Action |
|-----|--------|
| `↑↓` / `j` `k` | move |
| `Enter` | open selected (start if idle) → stage + focus it |
| `Tab` | focus the stage (session) without changing selection |
| `n` | name/rename the highlighted chat (type new name + Enter; empty = cancel; `Ctrl-U` clears) |
| `N` | new session (in the selected row's cwd, else `~`) |
| `x` | kill selected live session |
| `[` / `]` | shrink / grow the sidebar (resizes our pane + updates the pin hook, so it persists) |
| `/` | filter · `r` refresh |
| `q` / `Ctrl-C` | quit orc + tear down the whole server (dashboard + all sessions), back to a clean terminal |
| `d` | detach only — leave every session running in the background; re-run `orc` to reattach |

Renames persist in `~/.config/orc/names.json`, keyed by the transcript id, and
override the displayed title. Ink's own Ctrl-C handling is disabled
(`exitOnCtrlC: false`) so we control it.

Mouse: tmux `mouse on` is set, so dragging the pane divider resizes too (a later
terminal resize re-pins to the `[`/`]` width). Click-to-select rows is **not**
implemented — Ink has no native mouse support and it conflicts with tmux's mouse
handling; it would need raw SGR mouse parsing as a deliberate follow-up.

Moving focus **back** to the list from a session (root bindings on the orc
socket): `Alt-←` / `Alt-h`. Forward: `Alt-→` / `Alt-l`. Native tmux
`Ctrl-b ←/→` and `Ctrl-b z` (zoom) also work.

## Bootstrap & recovery

`orc` with no args:
- no dashboard session → create it (left pane = `orc __pane`, right =
  `orc __placeholder`, focus keys, status bar off, `remain-on-exit on` on the UI
  pane), then attach.
- dashboard exists + UI pane healthy (`@orc=__dash__`, `cmd=node`, not dead) →
  attach.
- dashboard exists but UI pane **dead/crashed** → `respawn-pane` the UI in place
  (hosted sessions untouched), then attach. **Self-heal: just re-run `orc`.**
- dashboard exists but the tagged UI pane is **gone** (severe crash) → `kill-server`
  and rebuild fresh (sessions resumable from history).

`orc kill` (and the `q` key) tear down the whole server. `d` detaches only (UI
keeps running, instant reattach). The UI pane uses `remain-on-exit on` so a crash
leaves a dead pane to respawn rather than vanishing.

## Verified

- Stage swap conserves panes / keeps off-stage sessions running (`npm run stagetest`).
- Status classifier (running/ready/dead).
- Bootstrap + two-pane layout + Ink UI render (headless `capture-pane`).
- Open historical → real `claude --resume --dangerously-skip-permissions` lands
  on the stage and registers as live.

## Needs a real terminal to confirm (can't be tested headless)

- The attach experience and the **running** spinner against a genuinely working
  session (and that `esc to interrupt` is the right marker).
- Focus toggle (`Tab`, `Alt-←/→`) and `q` detach feel.

## Not in scope (deliberately)

Git worktrees, branch/PR automation, remote access. Each session runs in its real
directory.
