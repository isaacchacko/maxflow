// One chokepoint for every message: Isaac's chats, GitHub and Slack notices, the server's own, and one agent writing another
// all become a signal on the bus, then go to the sessions named, else to the routers of the objective, else to the funnel.
export type Source = "isaac" | "gh" | "slack" | "agent" | "sentry" | "maxflow";
// An external message (see externalSignal) also carries who wrote it, where, a link to it, its thread or PR's link (on, which its board
// task links), the bus event it came on and when that was.
// own: his own post (on Slack, or on GitHub as himself or through an agent).
export type Signal = { source: Source; from?: string; target: string; text: string; routedTo: string[]; objective?: string; who?: string; where?: string; link?: string; on?: string; event?: number; at?: number; own?: boolean };

// Objectives own the work: each has one or more routers, each router a scope of it and its workers. Isaac sees them as rows.
export type Block = { id: string; kind: string; w: number; h: number; [k: string]: unknown };
// mergedInto: closed by merging it into another objective, which now owns its agents, threads, tasks and signals.
export type Objective = { id: string; title: string; cwd: string; at: number; page: Block[]; closed?: boolean; mergedInto?: string };

// Threads are the routers' running notes to Isaac on an objective; his reply in one goes to its routers like any message.
// signal: an inbox thread Isaac started, waiting on the funnel to route that signal to an objective.
// resolved: Isaac marked it done, from the browser only; his next message in it reopens it.
// paused: he put it away until a time (until), from the browser only, saying when in his words (said); count is how many messages
// it had then, posts how many agents added since, which leave it paused. At until it comes back as resurfaced, unread from count.
// His own message in it unpauses it at once. wake: what he wrote to be sent when it comes back, posted then as his message, so its
// routers take it up as if he had typed it; unpaused early (by hand, or by his own post) it isn't sent. An open ask in a paused (or
// resolved) thread is kept but not drawn as needing him, and its default waits; it is his again when the thread comes back. Only a
// new ask brings a paused thread back.
type Paused = { until: number; at: number; said: string; count: number; posts?: number; wake?: string };
// pending: his last message was handed to these routers, and none has answered yet; status is the line a router set on it.
export type Pending = { routers: string[]; since: number; status?: string };
// asks: an agent asked him here and waits on his reply (see ask); default: its recommendation, taken after DEFAULT_AFTER_MS.
// shown: when his inbox first drew it flagged; the default's clock runs from then, never from before he could see it.
type Ask = { session: string; since: number; default?: string; shown?: number };
// feed: started by maxflow itself from his event feed (a Slack DM or mention, a PR comment, a CI failure nobody owned), not by him;
// source is the sentry's kind of item, task the board task it is on, which goes to the agent the funnel routes it to.
export type Feed = { source: string; who: string; link: string; task?: number };
// task: the board task a feed thread is on.
// parent: a subthread hangs off a message in another thread, which is its root; its messages are that message's replies, and
// any of them can have a subthread of its own. A top thread's root is its first message, so replying to that posts in it.
// nudge: he asked for the answer to this message in a subthread of its own. wake: his message the end of a pause sent, as he wrote it then.
// A message someone wrote on Slack or GitHub, posted by the feed as that person: user is a Slack user id or a GitHub login; context marks
// one from before the new ones in its conversation, shown muted; own marks his own post there.
type External = { source: "slack" | "github"; name: string; user?: string; link: string; where?: string; context?: true; own?: true };
export type Message = { id: string; from: string; at: number; text: string; nudge?: "subthread"; wake?: true; ext?: External };
// members: agents he @-mentioned in it, who hear his later replies there as its routers do.
export type Thread = { id: string; title: string; objective: string; routers: string[]; members?: string[]; messages: Message[]; parent?: { thread: string; message: string }; signal?: number; pending?: Pending; task?: number; resolved?: { at: number }; paused?: Paused; pinned?: { at: number; order: number }; resurfaced?: { at: number; from: number }; asks?: Ask; q?: number; mergedInto?: string; moved?: { at: number }; feed?: Feed; feedSaid?: string[] };
// What the feed stores for one hand-off: a message per Slack or GitHub message, as its author, or the hand-off's text when it sent none.
// Agents are handed that text either way (thread.feedSaid).
export type FeedPost = { text: string; at?: number; ext: External };
// The user's own PR comments, which the board shows until they're resolved. The gh sentry's `who` tells his comments from the ones
// agents post as him; the bus keeps only its last few thousand events, so the comments are kept here, seeded from it on boot.
export type UserComment = { id: string; pr: string; kind: "comment" | "thread"; url: string; body: string; path?: string; at: number };

// A wait until a shell concludes: a command the server runs in a tmux session of its own (so it outlives the agent's turn), another
// maxflow session (--pane), or any process (--pid). The agent names it in words, the UI draws that as the condition, and its end
// wakes the agent with the exit code and the output's last lines. A command's pane stays up an hour after it exits, to be read.
export type Shell = { id: string; desc: string; owner: string; kind: "cmd" | "pane" | "pid"; cmd?: string; cwd?: string; pid?: number; file?: string; at: number; end?: { at: number; code: number | null; tail: string } };

// The open PRs gh sentry ties each session to, from its edges and its last poll.
type GhComment = { id: string; author: { login: string } | null };
export type GhPr = { state: string; title: string; comments: { nodes: GhComment[] }; reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: GhComment[] } }[] } };

// The user's task board: the server opens a task for each request the funnel routes, and sentry:assistant keeps the rest; he never writes to it himself.
export const TASK_STATUSES = ["todo", "doing", "you", "waiting", "blocked", "done", "dropped"] as const;
export type Task = {
  id: number;
  title: string;
  kind: "task" | "question";
  status: (typeof TASK_STATUSES)[number];
  answer?: string;
  sessions: string[];
  links: string[];
  at: number;
  updated: number;
  timeline: { at: number; text: string; session?: string }[];
  // The title is still Isaac's words cut short, waiting for the funnel to name the root.
  drafted?: boolean;
  // The status its agents' waits last settled; a hand move sticks until they settle a different one.
  derived?: (typeof TASK_STATUSES)[number];
  objective?: string;
  page?: Block[];
};
export type TaskEdit = Partial<Pick<Task, "title" | "kind" | "status" | "answer" | "objective">> & { session?: string; link?: string; event?: string; at?: number };

// His own todo list, each todo on a day (YYYY-MM-DD, his local day as the browser sends it); nothing else reads or writes it.
// state: clicking a todo's box steps it todo → doing → done → cancelled → todo.
export const TODO_STATES = ["todo", "doing", "done", "cancelled"] as const;
// threadIds: the threads tagged on it, by him from the page or by agents with `maxflow todo tag`, in the order they were tagged.
export type Todo = { id: string; text: string; day: string; state: (typeof TODO_STATES)[number]; at: string; threadIds: string[] };
