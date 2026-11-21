import { ChevronDown, ChevronRight, Folder, Hash, MessagesSquare, Search } from "lucide-react";
import { useState } from "react";
import { useResource, useSettled } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { ago } from "@/threads/Replies";
import { Markdown } from "@/threads/Rich";
import { RefChip } from "@/threads/rich/RefChip";
import { type BoardMessage, CHANNELS_KEY, type Channel, loadChannels, loadThread, loadThreads, postAsHim, showing, threadKey, threadsKey, type ThreadSummary, type Vouched } from "./board/api";

type Node = { name: string; path: string; channel?: Channel; children: Node[] };

const SEARCH_SETTLE_MS = 250;
const PREVIEW_CHARS = 220;
const MESSAGE_PREFIX = "@";
const AGENT_CHANNEL = /^yarn\/agent\/([\w-]+)$/;
const AGENT_PROFILE = /(?:^|\/)yarn-([0-9a-f]{8})$/;

const goTo = (path: string) => `#board/${encodeURI(path)}`;
const goToMessage = (id: string) => goTo(`${MESSAGE_PREFIX}${id}`);
const when = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const lastAt = (s: ThreadSummary) => s.latest?.createdAt ?? s.message.createdAt;
const preview = (text: string) => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text);

function nodeAt(root: Node, path: string): Node {
  let node = root;
  for (const name of path.split("/")) {
    const at = node.path === "" ? name : `${node.path}/${name}`;
    let child = node.children.find(c => c.name === name);
    if (!child) {
      child = { name, path: at, children: [] };
      node.children.push(child);
    }
    node = child;
  }
  return node;
}

function treeOf(channels: Channel[]) {
  const root: Node = { name: "", path: "", children: [] };
  for (const c of channels) nodeAt(root, c.path).channel = c;
  return root;
}

function ChannelName({ node }: { node: Node }) {
  const agent = AGENT_CHANNEL.exec(node.path)?.[1];
  if (agent !== undefined) return <RefChip r={{ kind: "agent", id: agent }} still />;
  return <span className="truncate">{node.name}</span>;
}

function ChannelEntry({ node, depth, selected }: { node: Node; depth: number; selected: string | undefined }) {
  if (!node.channel) return null;
  return (
    <a href={goTo(node.path)} data-agent={`board:channel:${node.path}`} style={{ paddingLeft: depth * 12 + 8 }} className={cn("flex items-center gap-2 rounded-md py-1 pr-2 text-sm hover:bg-muted", selected === node.path && "bg-muted")}>
      <Hash className="size-3.5 shrink-0 text-muted-foreground" />
      <ChannelName node={node} />
      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{node.channel.messages ?? ""}</span>
    </a>
  );
}

function TreeNode({ node, depth, selected }: { node: Node; depth: number; selected: string | undefined }) {
  const [isOpen, setOpen] = useState(node.path !== "yarn/agent" && node.path !== "conformance");
  if (node.children.length === 0) return <ChannelEntry node={node} depth={depth} selected={selected} />;
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <div>
      <ChannelEntry node={node} depth={depth} selected={selected} />
      <button type="button" onClick={() => setOpen(!isOpen)} style={{ paddingLeft: depth * 12 + 4 }} className="flex w-full items-center gap-1.5 rounded-md py-1 text-sm text-muted-foreground hover:bg-muted">
        <Chevron className="size-3.5 shrink-0" />
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}/</span>
      </button>
      {isOpen && node.children.map(c => <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} />)}
    </div>
  );
}

const handleOf = (m: BoardMessage) => m.author?.handle ?? m.by?.actor ?? "?";
const deviceOf = (m: BoardMessage) => m.author?.via?.name ?? handleOf(m).split("/", 1)[0] ?? "";
const agentOf = (m: BoardMessage, vouched: string | undefined) => (vouched === undefined || vouched === "yarn" ? AGENT_PROFILE.exec(handleOf(m))?.[1] : vouched);
const isClaimedName = (m: BoardMessage, agent: string | undefined) => agent !== undefined || m.author?.name === "isaac";

function Unverified() {
  return (
    <span className="rounded border px-1 text-[10px] text-muted-foreground uppercase" title="posted straight onto the board: the name is the poster's own word">
      unverified
    </span>
  );
}

function Author({ m, yarn }: { m: BoardMessage; yarn: Vouched }) {
  const vouched = yarn[m.id];
  if (vouched === "isaac") return <span className="font-semibold text-foreground" title="you, from yarn's Board tab">you</span>;
  const agent = agentOf(m, vouched);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {agent === undefined ? <span className="font-medium text-foreground">{m.author?.name ?? handleOf(m)}</span> : <RefChip r={{ kind: "agent", id: agent }} />}
      <span className="text-xs text-muted-foreground">via {deviceOf(m)}</span>
      {vouched === undefined && isClaimedName(m, agent) && <Unverified />}
    </span>
  );
}

function MessageCard({ m, yarn }: { m: BoardMessage; yarn: Vouched }) {
  return (
    <li className="space-y-1.5 border-b px-4 py-3 last:border-b-0" data-agent={`board:message:${m.id}`}>
      <div className="flex items-baseline gap-3 text-sm">
        <Author m={m} yarn={yarn} />
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(m.createdAt).toLocaleString()}>
          {when(m.createdAt)} · {ago(Date.parse(m.createdAt))} ago · {m.id}
        </span>
      </div>
      {m.deleted === true ? <p className="text-sm text-muted-foreground italic">deleted</p> : <Markdown text={m.text} className="text-sm leading-relaxed" />}
    </li>
  );
}

function Composer({ channel, re, placeholder }: { channel: string; re?: string; placeholder: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ isSending: boolean; error?: string }>({ isSending: false });
  const post = async () => {
    setState({ isSending: true });
    try {
      await postAsHim({ channel, ...(re !== undefined && { re }), text: text.trim() });
      setText("");
      setState({ isSending: false });
    } catch (error) {
      setState({ isSending: false, error: String(error) });
    }
  };
  const send = () => {
    if (text.trim() !== "") void post();
  };
  const label = re === undefined ? "Post" : "Reply";
  return (
    <div className="space-y-1.5 rounded-md border p-2" data-agent="board:composer">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-y bg-transparent text-sm outline-none"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Posts as you (isaac), from this browser only</span>
        {hasText(state.error) && <span className="truncate text-xs text-destructive">{state.error}</span>}
        <button type="button" onClick={send} disabled={state.isSending || text.trim() === ""} className="ml-auto rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50">
          {state.isSending ? "Posting…" : label}
        </button>
      </div>
    </div>
  );
}

function ThreadPane({ id }: { id: string }) {
  showing({ thread: id });
  const loaded = useResource(threadKey(id), async () => loadThread(id));
  const t = loaded.value;
  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4" data-agent="board:thread">
      {loaded.error && <p className="text-sm text-destructive">{loaded.error.message}</p>}
      {t && (
        <>
          <a href={goTo(t.message.channel)} className="font-mono text-sm text-muted-foreground hover:underline">
            #{t.message.channel}
          </a>
          <ol className="rounded-md border">
            {[t.message, ...t.replies].map(m => <MessageCard key={m.id} m={m} yarn={t.yarn} />)}
          </ol>
          <Composer channel={t.message.channel} re={t.message.id} placeholder="Reply in this thread (⌘↩ to send)" />
        </>
      )}
    </div>
  );
}

function ThreadRow({ s, yarn }: { s: ThreadSummary; yarn: Vouched }) {
  const m = s.message;
  return (
    <li className="border-b last:border-b-0">
      <a href={goToMessage(m.id)} className="block space-y-1 px-4 py-2.5 hover:bg-muted" data-agent={`board:thread-row:${m.id}`}>
        <div className="flex items-baseline gap-3 text-sm">
          <Author m={m} yarn={yarn} />
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {(s.replies ?? 0) > 0 && `${String(s.replies)} repl${s.replies === 1 ? "y" : "ies"} · `}
            {ago(Date.parse(lastAt(s)))} ago
          </span>
        </div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{preview(m.text)}</p>
      </a>
    </li>
  );
}

function ThreadsPane({ channel, q }: { channel: string; q: string }) {
  const key = threadsKey(channel, q);
  showing({ threads: key });
  const loaded = useResource(key, async () => loadThreads(channel, q));
  const listed = (loaded.value?.threads ?? []).toSorted((a, b) => Date.parse(lastAt(b)) - Date.parse(lastAt(a)));
  const isAChannel = channel !== "" && !channel.endsWith("/");
  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4" data-agent="board:threads">
      <h1 className="font-mono text-sm">{q === "" ? `#${channel === "" ? "everything" : channel}` : `“${q}”${channel === "" ? "" : ` in #${channel}`}`}</h1>
      {isAChannel && q === "" && <Composer channel={channel} placeholder={`New thread in #${channel} (⌘↩ to send)`} />}
      {loaded.error && <p className="text-sm text-destructive">{loaded.error.message}</p>}
      <ol className="rounded-md border">
        {listed.map(s => <ThreadRow key={s.message.id} s={s} yarn={loaded.value?.yarn ?? {}} />)}
        {loaded.value !== undefined && listed.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">Nothing here yet.</li>}
      </ol>
    </div>
  );
}

function Main({ path, q }: { path: string | undefined; q: string }) {
  if (hasText(path) && path.startsWith(MESSAGE_PREFIX) && q === "") return <ThreadPane key={path} id={path.slice(MESSAGE_PREFIX.length)} />;
  const channel = hasText(path) && !path.startsWith(MESSAGE_PREFIX) ? path : "";
  return <ThreadsPane key={`${channel}:${q}`} channel={channel} q={q} />;
}

export function BoardView({ path }: { path: string | undefined }) {
  const index = useResource(CHANNELS_KEY, loadChannels);
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim(), SEARCH_SETTLE_MS);
  const channels = index.value?.channels ?? [];
  return (
    <div className="flex h-full min-h-0" data-agent="board">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <a href={goTo("")} className="flex items-center gap-2 border-b px-3 py-2.5">
          <MessagesSquare className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Board</span>
          <span className="ml-auto truncate text-xs text-muted-foreground" title="the agent board on cleopatra, over mallory">
            cleopatra · {channels.length}
          </span>
        </a>
        <label className="m-2 flex h-8 items-center gap-2 rounded-md border px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Search messages" data-agent="board:search" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </label>
        <nav className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {index.error && <p className="px-2 text-sm text-destructive">{index.error.message}</p>}
          {treeOf(channels).children.map(n => <TreeNode key={n.path} node={n} depth={0} selected={path} />)}
        </nav>
      </aside>
      <Main path={path} q={q} />
    </div>
  );
}
