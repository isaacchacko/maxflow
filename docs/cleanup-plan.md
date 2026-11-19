# yarn cleanup plan: make yarn development agent-friendly

Isaac's ask (th-7d528b): "want to clean up yarn codebase. north star: make yarn development extremely agent friendly." This is phase 1: a survey and a ranked plan. No code has changed yet.

The plan holds to north star 3 (smallest thing that does the job): no rewrite, and every piece removes a failure we have seen. Most of them make the tooling enforce a rule that agents currently have to remember.

## What makes changing yarn hard today (evidence)

1. **The live service runs from the tree everyone edits.** launchd runs `bun server.ts` with `WorkingDirectory` set to `~/Worktrees/maxflow-v2` (`service.ts` `install()`, `DIR = import.meta.dir`). Every agent edits that same checkout on `feat/v2`. Right now 15 files there hold other agents' uncommitted hunks (`git status`: 13 sentries, `server.ts` and an untracked `sentries/singleton.ts`). The consequences, all from the last three days of `git log`:
   - **Swept-in work.** Commits picked up another agent's half-finished hunks and had to be taken back: `ee73120` (a health.html→panic.html rename swept in by `4eb7b70`), `46b57e1` (`c8df144` imported an uncommitted file, so HEAD didn't build), `a1d69cd` (`1745f7d` carried another agent's feed migration and dropped its own hunk), `314ecb7`, and `2d7dbff` (`de6d58a` committed a stale copy of server.ts that reverted `c9c5565`).
   - **Hand-built commits.** To avoid sweeping, agents build commits from `HEAD` plus their own edits (`git hash-object`, `update-index`). That process has its own failures: `c23d14e` (HEAD's server.ts didn't parse, while the live server ran a tree another agent had already fixed), and `58472b6` (a hand-built blob committed `cli.ts` as 644). The memories [commit-only-paths] and [parse-check-staged-blob] spend about 30 lines on how to do this safely.
   - **Deploys ship other people's work.** A `launchctl kickstart` restarts whatever the tree holds right now, other agents' unfinished edits included, and on 2026-11-16 a `pkill -f "bun server.ts"` took live down ([live-watch-and-pkill]).
   - **The UI rebuilds on every save.** server.ts serves `src/index.html` through Bun's dev server with HMR (`development: { hmr: true }`). Any agent's half-written save in `src/` reaches Isaac's open tabs at once. `sentries/health.ts` even starts a recovery agent when "a frontend build stays broken for 60s", because a few broken seconds are routine.
2. **There are no tests and no CI.** The repo has no `*.test.ts` and no `.github/workflows`, and `package.json` defines only `dev`. A wrong edit is found when it breaks live. Isaac's global rule is that checks run in CI rather than locally, but there is no CI for yarn to run them in.
3. **Trying a change is slow and can hurt live.** `./dev.sh` gives an instance its own port, socket and state dir (`instance.ts`), and it starts empty: there is no seed data, so you can't see a flow without building the state by hand. Nothing limits how many sessions an instance starts. Every instance shares the machine's process table with live, and the 16:16 crash (`ca3633f`) followed a dev instance that had spawned 60+ sessions: a failed fork left a pane at pid -1, and respawning it segfaulted the live tmux server, which killed about 95 agents. `~/.maxflow-v2-*` holds 13 leftover instance dirs, and two of them still hold a `server.pid`.
4. **server.ts is 2836 lines in one file.** It holds tmux control, session adoption, sentry startup, every agent's intro prose, threads, waits, tasks, todos, restrictions, PR state, the world builder and the whole HTTP router (a single `fetch` with an `if (path === ...)` chain). Because so many agents edit this one file, the stale-copy revert in `2d7dbff` happened there, and agents run into each other's hunks there most often. It is also why reading "how waits work" means paging through unrelated code.
5. **Agents keep relearning the same gotchas.** The gotchas live in per-user Claude memory (`~/.claude/projects/-Users-isaac-Programs-maxflow/memory/`, 21 files) and in a 15KB SessionStart intro. No file in the repo tells a new agent how to change yarn: there is no `CLAUDE.md` or `AGENTS.md`, and `docs/reference.md` describes usage, not development. Some of the rules are workarounds for item 1 (commit-only-paths, parse-check-staged-blob, never kickstart without checking), and they disappear once item 1 is fixed.
6. **Guardrails misfire.** The restrictions hook (`restrictions.ts:90`, `\bpkill\b`) blocked this survey's `sed` of a memory file named `live-watch-and-pkill.md`, because `-` is a word boundary. A guard that blocks reads teaches agents to route around guards.

## The plan, ranked

| # | Piece | Size | Parallel? |
|---|-------|------|-----------|
| 1 | Live runs only committed code; agents work in their own worktrees | S–M | first; others build on it |
| 2 | A check script plus CI on push | M | yes, with 3, 5, 6 |
| 3 | Dev instances are capped, seeded and one command | S | yes |
| 4 | Split server.ts along the seams it already has | M | after 1 and 2 |
| 5 | A repo `CLAUDE.md` replaces the scattered gotchas | S | yes; finish after 1 |
| 6 | Restrictions match commands, not substrings | S | yes |

### 1. Live runs only committed code; agents work in their own worktrees (do this first)

**Change.** Treat `~/Worktrees/maxflow-v2` as the live deploy checkout and nothing else: no agent edits it. Every change happens in the agent's own worktree on its own branch (`git worktree add ~/Worktrees/maxflow-<topic> -b <branch> origin/feat/v2`), and lands by rebasing onto `feat/v2` and pushing (or through a PR, auto-merged, per [maxflow-merge-no-approval]). A new `cli.ts deploy` command is the only way live changes. It refuses if the live checkout is dirty, runs `git pull --ff-only`, parse-checks (`bun build --no-bundle` on server.ts, cli.ts and sentries), kickstarts the service, and then checks that the session count matches and that every sentry is running, which the memory says to do by hand today. A new restrictions builtin, "Edit the live yarn checkout", makes the hook deny Edit and Write to paths under the live `DIR` from any session but `deploy`. The hook already exists, so this is one catalog entry.

The live path stays the same, so the CLI path in every pane's environment and intro still works. A one-time cutover comes first: whoever owns the 15 dirty files commits their work or moves it to a branch, so the tree starts clean.

**Why it helps agents.** It closes failure 1 at its source. Commits become an ordinary `git add -A && git commit` in a tree that is the agent's alone. Sweeping and stale copies become impossible, so the hand-built-blob procedure and two memory files can go. A deploy ships exactly the commits on `feat/v2`, and Isaac's UI stops hot-reloading half-saved files. The health sentry's broken-build recovery becomes a rare event instead of routine.

**Size.** S–M: about 40 lines in `cli.ts`, one builtin in `restrictions.ts`, and a doc change. The cutover is mostly coordination.

**Touches.** `cli.ts`, `restrictions.ts`, `docs/`, and the agents with dirty hunks today.

**Parallel.** Do it first. The others don't depend on it to start, but each is easier to land after it.

### 2. A check script plus CI on push

**Change.** Add a `bun run check` script that parse-checks every entry point, bundles `src/index.html` once with `bun build`, and runs `bun test`. Seed the tests with a few cheap unit tests for pure helpers that have broken or misfired before: `shellText` and the restriction matchers, `candidatesIn` (PR and URL extraction), `titleOf`, and wait parsing. Add a smoke test that boots a throwaway instance (`MAXFLOW_INSTANCE=ci`, `MAXFLOW_SENTRIES=0`, a random port), checks that `/api/world` and `/api/sessions` answer, and stops it. A GitHub Actions workflow runs `check` on every push to `feat/v2` and on every PR. `cli.ts deploy` (piece 1) refuses a commit whose CI is red.

**Why it helps agents.** Today the first signal that an edit is wrong is that live breaks. This gives a signal within minutes, and it runs in CI, which matches Isaac's checks-in-CI rule. Every test is also a written example of how the code is meant to behave.

**Size.** M. Most of the effort goes into making the boot path start cleanly with no tmux sessions and no sentries.

**Touches.** `package.json`, a new `test/` directory, `.github/workflows/check.yml`, and possibly small export changes so helpers can be imported without booting the server. Piece 4 makes those exports cleaner.

**Parallel.** Yes.

### 3. Dev instances are capped, seeded and one command

**Change.** Three small additions to `dev.sh` and `createSession`:
- When `!LIVE`, a dev instance refuses to start more than `MAXFLOW_MAX_SESSIONS` sessions (default 10), so it can't exhaust the process table that live shares.
- `./dev.sh --seed` copies a small fixture state (a few threads, objectives and tasks, built from what `src/mock.ts` already describes) into the instance's state dir, so a UI flow can be tried at once.
- `./dev.sh gc` removes `~/.maxflow-v2-*` instance dirs whose pid is dead.

The [inert-test-agent-text] rule becomes the default: a dev instance starts `claude` with `--model haiku` in an empty cwd unless told otherwise.

**Why it helps agents.** "Try it on dev" becomes cheap and safe, so agents stop testing on live, and a runaway instance can no longer take 95 agents down.

**Size.** S.

**Touches.** `dev.sh`, `createSession` in server.ts (one guard), and a fixture directory.

**Parallel.** Yes.

### 4. Split server.ts along the seams it already has

**Change.** A pure move, with no behavior change, one module per commit, done after piece 2 so the smoke test guards each step. The seams are already visible in the function list:
- `tmux.ts`: `tmux`, `respawn`, `scoped`, `paste`, `push`, `attachViewer`, `createSession`, `adoptSessions`.
- `intro.ts`: `intro`, `roleIntro`, `standingDecisions`, `metaLessons`, the sentry blurbs. This is the prose agents edit most often, and it has no logic.
- `waits.ts`: `wake`, `endWait`, `declareWait`, `tellWaiters`, `tellDone`, `alreadyDone`, `prWaitEnds`.
- `threads.ts`: `postIn`, `subthread`, `titleOf`, mentions, `ask`, `answered`.
- `world.ts`: `derive`, `rebuildWorld`, `world`.
- Routes stay in `server.ts`, which ends up holding state, boot and the router.

**Why it helps agents.** An agent fixing waits reads a 200-line file, not 2836 lines. Concurrent edits stop landing in the same file, and the pieces can be imported by tests.

**Size.** M, but mechanical. Each move is its own revertable commit.

**Touches.** server.ts and the new modules.

**Parallel.** No. It needs piece 1 (clean merges) and piece 2 (a safety net), and it should be announced, since it conflicts with any in-flight server.ts work.

### 5. A repo `CLAUDE.md` replaces the scattered gotchas

**Change.** Write `CLAUDE.md` at the repo root (Claude Code loads it automatically), kept to about 40 lines. It covers how to change yarn: worktree, branch, `bun run check`, push, `cli.ts deploy`; how to try a change with `./dev.sh --seed`; where things live; and the handful of rules that remain true after pieces 1–3, such as never pkill by pattern, inert test-agent text and the CLI path. Then delete the memory files that piece 1 makes obsolete, and trim the SessionStart intro's development notes down to a pointer to this file.

**Why it helps agents.** One place, in the repo, versioned with the code, read by every agent on its first turn. Today a gotcha reaches only the agent whose user-level memory happened to save it.

**Size.** S.

**Touches.** `CLAUDE.md`, `docs/reference.md` (link), the memory directory, and `intro()`.

**Parallel.** Yes. Write it now and update it as 1–3 land.

### 6. Restrictions match commands, not substrings

**Change.** Run the Bash matchers only against command words (argv[0] of each pipeline segment, with `shellText` already blanking quoted data), not the whole text. Add the false positive from this survey as a test case in piece 2.

**Why it helps agents.** A guard that blocks `sed` on a file called `…pkill.md` teaches agents that blocks are noise. A precise guard is one they trust and obey.

**Size.** S.

**Touches.** `restrictions-shell.ts`, `restrictions.ts`.

**Parallel.** Yes.

## Reference: "All Code Is Slop (Except Mine)", Lauren Tan

Isaac added this talk (https://youtu.be/O_zcc6Xl12g) as a reference. Its transcript couldn't be fetched: YouTube answered 429 to `yt-dlp --write-auto-subs` three times, twice from victoria four minutes apart and once from cleopatra, which uses the same egress. **No piece above comes from it yet.** Once the transcript is in hand, its concrete practices get folded in here, each one marked with the piece it changes or adds. Nothing in this plan paraphrases the talk from memory.

## Left out on purpose

- **No frontend restructure.** `src/` is about 10k lines in reasonably sized files, and nothing in the history shows it slowing agents down beyond the shared-tree problem that piece 1 fixes.
- **No framework for the HTTP router.** The `if (path === ...)` chain is ugly but easy to read. Piece 4 can move groups of routes next to their module if that helps, and nothing more.
- **Commit message length.** The long story-style subjects are Isaac's convention, so they are not changed here.
