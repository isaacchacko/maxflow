# yarn cleanup plan: make yarn development agent-friendly

Isaac's ask (th-7d528b): "want to clean up yarn codebase. north star: make yarn development extremely agent friendly." This is the second draft, the planning doc he asked for. He then said "eh ignore the plan first, implement whenever", so it is committed as it stood, unpolished, and the SQLite move (piece 3) is being built now.

**Reference.** "All Code Is Slop (Except Mine)", Lauren Tan, AI Engineer 2026 (https://youtu.be/O_zcc6Xl12g). These notes come from ai.engineer's write-up of the talk; the verbatim transcript would not load. Its central idea is the **inverse trust pyramid**. The most trust goes to decisions made once in code, an API that can't express the mistake. Next come checks (lint, types, tests), then runtime verification. Prose rules are a thin layer kept for judgment calls, and human review is the expensive tip. Agents copy whatever patterns the codebase already has, so its quality compounds in either direction. When an agent repeats a mistake, the order is **rule, then cleanup, then verify**, and only then automation. Pieces marked **[talk]** apply one of these practices.

## Status of the first plan

| Piece | Status |
|---|---|
| Live runs only committed code; `cli.ts deploy` is the one way it changes | Live (e6d5fb4). The edit-live restriction denies Edit and Write in the live checkout. |
| `bun run check` plus CI on every push | Shipped (ad49bb9). |
| Dev instances capped, seeded, inert by default | Shipped (0764d7f). |
| Restrictions match where a command starts | Shipped (038671e). |
| Repo `CLAUDE.md` | Dropped (Isaac: "want the code to be self defining"). Piece 2 replaces it. |
| Split server.ts | Kept as piece 7. |

## The new plan, ranked

| # | Piece | Cost | Buys agents |
|---|---|---|---|
| 1 | Lint layer with guiding diagnostics, and enforced boundaries **[talk]** | S–M | Every later rule becomes a check instead of prose |
| 2 | Self-defining code: each recurring gotcha becomes an API or a check **[talk]** | M | Agents stop relearning the same lessons |
| 3 | State moves from 45 JSON files to SQLite | L | Atomic writes, enforced uniqueness, cheap queries, one place for schema changes |
| 4 | useEffect banned outside a small framework layer **[talk]** | M | Removes the React bug class agents get wrong most |
| 5 | Delete dead workarounds and the comments that justify them **[talk]** | S–M | Agents stop copying workarounds as patterns |
| 6 | Runtime verification: a packaged dev driver that returns screenshot evidence **[talk]** | M | "It works" becomes a picture instead of a claim |
| 7 | Split server.ts into modules the boundary rules check **[talk]** | M | Small files with one job; fewer collisions |
| 8 | Feature map, generated and checked **[talk]** | S | Shared names for requests and the code that serves them |

### 1. Lint layer and enforced boundaries [talk]

yarn has no linter. Its layers depend on each other only by convention:
- `src/` imports a server module directly (`../../restrictions`).
- `slack-messages.json` is read by 7 modules and `gh-status.json` by 5, with no type behind either.
- `STATE_DIR` is imported by 23 files.

Add Biome to `bun run check`. Its `noRestrictedImports` rule takes a custom message per path, so the diagnostic carries the guidance.

Rules:
- `src/` imports only `shared/`.
- Sentries never import `server.ts`.
- Only the state module touches `STATE_DIR`.

Start with today's violations as a frozen baseline that may only shrink. ESLint with `eslint-plugin-boundaries` would also work, but it is a heavier toolchain.

### 2. Self-defining code [talk]

| Gotcha | Evidence | Becomes |
|---|---|---|
| Commits sweep in others' hunks | ee73120, 46b57e1, a1d69cd, 314ecb7, 2d7dbff | **API**: worktrees plus deploy (live) |
| Parse-check hand-built commits | c23d14e, 1745f7d | **Obsolete** with worktrees; CI check |
| cli.ts committed as 644 | 58472b6 | **Check**: executable bits in `check` |
| Push after every commit | memory | **API**: deploy refuses commits origin lacks |
| Deploy = kickstart + count sessions | memory | **API**: `cli.ts deploy` |
| Never pkill by pattern | 2026-11-16 outage | **Check**: restrictions hook (exists) |
| Inert test-agent text | memory, 2026-11-17 | **API**: dev instance default (shipped) |
| notify vs SendMessage | memory contradicts the intro at `server.ts:312` | **Decide one path**; the hook denies the other with guidance |
| Repeated CLI flags keep only the first | memory task-cli-one-flag | **API**: the parser accepts repeats or errors |
| Check for a task before creating one | memory | **API**: idempotent task create |
| Never self-archive | a69af8b | **Already code**; delete the memory |
| Sentries only respawn at boot | memory | **Stale**; delete |
| Two sentry copies double-send | ad28221, bb67d2a | **API**: singleton, then a DB unique claim |
| Sync tmux blocks the event loop | `server.ts:94` | **API**: tmux.ts exports only async to handlers |
| `await` in a non-async arrow | c23d14e | **Check**: `tsc --noEmit` in CI |
| Read-path migrations | 11 sites in server.ts | Piece 3 and piece 5 |
| Funnel routing rules | 5 memories | **Stay prose**: judgment |

### 3. State in SQLite

**Inventory of `~/.maxflow-v2`** (2026-11-18 17:46; writes counted by sampling mtimes every 2s for 2 minutes; the cost columns are measured on copies):

| File | Size | Writer | Readers | Writes / 2 min | Write ms | Read ms |
|---|---|---|---|---|---|---|
| events.jsonl | 43 MB | server (append) | server boot replays it all, stats.ts | append | | |
| threads.json | 1.19 MB (276 threads, 2,113 messages) | server, full rewrite, 200ms debounce | server, stats.ts | 5 | 8.1 | 10.4 |
| gh-status.json | 963 KB | gh sentry, full rewrite | server, approval, restrictions hook | 3 | 16.7 | 12.5 |
| tasks.json | 816 KB (440 tasks) | server, sync full rewrite | server | 4 | 5.1 | 12.6 |
| approval-state.json | 734 KB | approval sentry | approval | 1 | 3.5 | 1.8 |
| inbox-state.json | 375 KB | inbox sentry | inbox | 29 | 1.8 | 2.2 |
| slack-messages.json | 243 KB | slack sentry | 7 modules incl. the hook | 6 | | |
| restrictions.json and -seeded | 13 KB | **every hook process on every tool call** (`loadRestrictions` writes as it loads), and the server | hook, server, cli | **47 each** | | |
| todo-state.json | 3 KB | todo feed | todo | 28 | | |
| 36 more | 62B–92KB | sentries and server | | 0–6 | | |

**Findings.**
- Only 3 of 85 `writeFileSync` calls write a temp file and rename it.
- `sentryFile()` swallows parse errors.
- Every agent's tool call rewrites `restrictions.json`, so a hook that loaded just before Isaac's edit can write the old list back (a lost update, not observed yet).
- A torn read was **not** reproduced: 31,604 reads during 55,074 rewrites of the 13KB file, on APFS. The one proven race is the approval double-send (ad28221), which claim files and a singleton fixed.
- No store is slow at today's sizes. threads.json grows with every message.

**Options.** Atomic JSON fixes torn writes only. bun:sqlite in WAL mode adds `UNIQUE`, row-level writes, indexed hook reads and versioned migrations, with no new dependency. Postgres is overkill for one machine. **Choose bun:sqlite**, at `~/.maxflow-v2/yarn.db`.

**Schema (first pass).** Columns for filters, plus a `data` JSON column:
- `threads`, `messages(thread_id, seq)`
- `tasks`, `task_links UNIQUE(task_id, url)`
- `objectives`, `todos`, `names`, `decisions`
- `prs(url)`, `slack_messages(channel, ts)`, `approval_claims PK(pr, head)`
- `sentry_state(sentry, key)`
- events stays JSONL.

**Migration, per store.** Schema, then a one-time import (the JSON stays as a backup), then readers and writers switched, then verification on `./dev.sh --seed`, then deploy.

### 4. useEffect ban [talk]

There are 64 effects in `src/`:
- **A. Reset state on input change (13)**: derive during render, use a `key`, or set it in the handler.
- **B. Window or DOM event subscriptions (16)**: framework hooks (`useHotkey`, `useOutsideClick`, `useWindowEvent`, `useElementSize`), plus stores read with `useSyncExternalStore`.
- **C. Fetch on mount (8)**: a resource store, or put the data in `/api/world`.
- **D. Debounced queries (2)**: `useDebouncedQuery`.
- **E. Imperative DOM sync (18)**: ref callbacks, `useScrollAnchor`, `useAutosize`, CSS; xterm and AgentFace stay as framework widgets.
- **F. Persist or side-write (7)**: write in the setter or the handler; one shared clock store.

Effects are allowed only in `src/framework/`. Enforced by Biome `noRestrictedImports` with a guiding message, starting from a baseline that may only shrink.

### 5. Delete dead workarounds [talk]

Delete, once each is proven dead:
- the 11 read-path shims in server.ts
- health's `/__down/` routes and the `x-maxflow-down` header
- the v1 backup directory
- the stale dev state dirs
- obsolete memories

Comments go only when a check or a rename replaces them. Comments are 8% of lines (1,577 of 18,821).

### 6. Runtime verification [talk]

`./dev.sh shot <route>`: headless Chrome over CDP against a seeded instance, posting PNGs with `thread post --image`.

### 7. Split server.ts [talk]

Into tmux.ts, intro.ts, waits.ts, threads.ts and world.ts, after piece 3. Each move is pure and checked by piece 1's rules.

### 8. Feature map [talk]

Generated from App.tsx's routes, cli.ts's verbs and the sentry list. `check` fails when one has no entry.

## Order

1 first; then 2, 3 and 4 in parallel, each as rule, then cleanup, then verify; 5 behind each; 6 any time; 7 after 3; 8 any time; automation last.

## Left out on purpose

No frontend rewrite, no router framework, no formal methods.
