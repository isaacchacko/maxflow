import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Copy, Plus, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar";
import { Terminal, type TerminalHandle } from "@/components/terminal";
import { GraphView } from "@/components/graph";
import { ResumeDialog } from "@/components/resume-dialog";
import { TasksBoard } from "@/components/tasks";
import { api, isSentry, store, type OpenComment, type QueuedPr, type Question, type Session, type Task, type View } from "@/lib/api";
import { cn } from "@/lib/utils";

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => store.get("mf.collapsed") === "1");
  const [view, setView] = useState<View>(location.hash === "#tasks" || location.hash === "#questions" ? "tasks" : "agent");
  const graphing = view === "graph", tasking = view === "tasks";
  // ⌘G and ⌘K flip between their view and the agent view; the three never stack.
  const flip = (v: View) => setView((cur) => (cur === v ? "agent" : v));
  const [hideArchived, setHideArchived] = useState(() => store.get("mf.hideArchived") === "1");
  const [resuming, setResuming] = useState(location.hash === "#resume");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [prs, setPrs] = useState<QueuedPr[]>([]);
  const [comments, setComments] = useState<OpenComment[]>([]);
  const term = useRef<TerminalHandle | null>(null);

  const refresh = useCallback(() => api.sessions().then((s) => (setSessions(s), setLoaded(true))), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  const refreshQuestions = useCallback(() => api.questions().then(setQuestions, () => {}), []);
  useEffect(() => {
    refreshQuestions();
    const t = setInterval(refreshQuestions, 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!tasking) return;
    const refreshTasks = () => (api.tasks().then(setTasks, () => {}), api.review().then((r) => setPrs(r.queue), () => {}), api.comments().then(setComments, () => {}));
    refreshTasks();
    const t = setInterval(refreshTasks, 3000);
    return () => clearInterval(t);
  }, [tasking]);

  const waiting = questions.filter((q) => q.status === "pending").length;
  useEffect(() => void (document.title = waiting ? `(${waiting}) maxflow` : "maxflow"), [waiting]);

  const attach = (id: string) => {
    setCurrent(id);
    history.replaceState(null, "", `/s/${id}`);
  };
  const open = (id: string) => (setView("agent"), attach(id), requestAnimationFrame(() => term.current?.focus()));

  // Pick a session on first load: the one in the URL, else the first agent.
  useEffect(() => {
    if (current || !sessions.length) return;
    const fromUrl = sessions.find((s) => location.pathname.endsWith(`/s/${s.id}`));
    attach((fromUrl ?? sessions.find((s) => !isSentry(s)) ?? sessions[0]).id);
  }, [sessions, current]);

  const newShell = async () => {
    const s = await api.create("zsh");
    await refresh();
    open(s.id);
  };
  const kill = async (id: string) => {
    await api.kill(id);
    if (id === current) (setCurrent(null), history.replaceState(null, "", "/"));
    refresh();
  };
  const archive = async (id: string, archived: boolean) => (await api.archive(id, archived), refresh());
  const archiveLinks = async (urls: string[], archived: boolean) => (await api.archiveLinks(urls, archived), refresh());
  const toggleArchived = () =>
    setHideArchived((h) => {
      store.set("mf.hideArchived", h ? "0" : "1");
      return !h;
    });
  const toggleSidebar = () =>
    setCollapsed((c) => {
      store.set("mf.collapsed", c ? "0" : "1");
      return !c;
    });

  useEffect(() => {
    if (!graphing && !tasking) requestAnimationFrame(() => (term.current?.fit(), term.current?.focus()));
  }, [graphing, tasking]);
  useEffect(() => void requestAnimationFrame(() => term.current?.fit()), [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const plain = !e.altKey && !e.shiftKey;
      if (e.metaKey && !e.ctrlKey && plain && e.key === "g") flip("graph");
      else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "b") toggleSidebar();
      else if (e.metaKey && !e.ctrlKey && plain && e.key === "k") flip("tasks");
      else if (e.ctrlKey && !e.metaKey && plain && e.key === "t") newShell();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <div className={cn("grid h-full max-sm:grid-cols-1 max-sm:grid-rows-[auto_1fr]", collapsed ? "grid-cols-[52px_1fr]" : "grid-cols-[272px_1fr]")}>
        <Sidebar
          sessions={sessions}
          current={current}
          collapsed={collapsed}
          view={view}
          onToggle={toggleSidebar}
          onView={setView}
          onResume={() => setResuming(true)}
          questions={waiting}
          onNew={newShell}
          onOpen={open}
          onKill={kill}
          onArchive={archive}
          hideArchived={hideArchived}
          onToggleArchived={toggleArchived}
          onRename={async (id, name) => (await api.rename(id, name), refresh())}
        />
        <main className="relative min-h-0 min-w-0">
          <SessionMenu s={sessions.find((s) => s.id === current)} selection={() => term.current?.selection() ?? ""} onArchive={archive} onClosed={() => term.current?.focus()}>
            <div className={cn("absolute inset-0 py-2 pl-3 pr-1", graphing && "hidden")}>{current && <Terminal key={current} id={current} handle={term} onClose={refresh} />}</div>
          </SessionMenu>
          <GraphView
            sessions={sessions}
            questions={questions}
            onQuestions={() => setView("tasks")}
            visible={graphing}
            current={current}
            hideArchived={hideArchived}
            onOpen={open}
            onCreated={refresh}
            onArchive={archive}
            onArchiveLinks={archiveLinks}
            onToggleArchived={toggleArchived}
          />
          {tasking && <TasksBoard tasks={tasks} prs={prs} comments={comments} questions={questions} sessions={sessions} onOpen={open} onSettled={refreshQuestions} onClose={() => setView("agent")} />}
          {loaded && !sessions.length && view === "agent" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground">
              <TerminalSquare className="size-10 opacity-40" />
              <p className="text-sm">No sessions yet.</p>
              <Button variant="outline" onClick={newShell}>
                <Plus /> New shell <Kbd>⌃T</Kbd>
              </Button>
            </div>
          )}
        </main>
      </div>
      <ResumeDialog open={resuming} onOpenChange={setResuming} onResumed={(s) => (refresh(), open(s.id))} />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

// Right-clicking the open chat, so it can be archived or woken without finding it in the sidebar.
function SessionMenu({ s, selection, onArchive, onClosed, children }: {
  s: Session | undefined;
  selection: () => string;
  onArchive: (id: string, archived: boolean) => void;
  onClosed: () => void;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState("");
  if (!s || isSentry(s)) return children;
  return (
    <ContextMenu onOpenChange={(open) => (open ? setCopied(selection()) : onClosed())}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="max-w-64">
        <ContextMenuLabel>{s.name}</ContextMenuLabel>
        <ContextMenuSeparator />
        {copied && (
          <ContextMenuItem onSelect={() => navigator.clipboard.writeText(copied)}>
            <Copy /> Copy selection
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => onArchive(s.id, !s.archived)}>
          {s.archived ? <ArchiveRestore /> : <Archive />} {s.archived ? "Unarchive" : "Archive"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
