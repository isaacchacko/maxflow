import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar";
import { Terminal, type TerminalHandle } from "@/components/terminal";
import { GraphView } from "@/components/graph";
import { ResumeDialog } from "@/components/resume-dialog";
import { QuestionsPanel } from "@/components/questions";
import { TasksBoard } from "@/components/tasks";
import { api, isSentry, store, type Question, type Session, type Task } from "@/lib/api";
import { cn } from "@/lib/utils";

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => store.get("mf.collapsed") === "1");
  const [graphing, setGraphing] = useState(false);
  const [hideArchived, setHideArchived] = useState(() => store.get("mf.hideArchived") === "1");
  const [resuming, setResuming] = useState(location.hash === "#resume");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [asking, setAsking] = useState(location.hash === "#questions");
  const [tasking, setTasking] = useState(location.hash === "#tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
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
    const refreshTasks = () => api.tasks().then(setTasks, () => {});
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
  const open = (id: string) => (setGraphing(false), attach(id), requestAnimationFrame(() => term.current?.focus()));

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
      if (e.metaKey && !e.ctrlKey && plain && e.key === "g") setGraphing((g) => !g);
      else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "b") toggleSidebar();
      else if (e.metaKey && !e.ctrlKey && plain && e.key === "k") setTasking((t) => !t);
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
          graphing={graphing}
          onToggle={toggleSidebar}
          onGraph={() => setGraphing((g) => !g)}
          onResume={() => setResuming(true)}
          questions={waiting}
          onQuestions={() => setAsking((a) => !a)}
          onNew={newShell}
          onOpen={open}
          onKill={kill}
          onArchive={archive}
          hideArchived={hideArchived}
          onToggleArchived={toggleArchived}
          onRename={async (id, name) => (await api.rename(id, name), refresh())}
        />
        <main className="relative min-h-0 min-w-0">
          <div className={cn("absolute inset-0 py-2 pl-3 pr-1", graphing && "hidden")}>{current && <Terminal key={current} id={current} handle={term} onClose={refresh} />}</div>
          <GraphView
            sessions={sessions}
            visible={graphing}
            current={current}
            hideArchived={hideArchived}
            onOpen={open}
            onCreated={refresh}
            onArchive={archive}
            onArchiveLinks={archiveLinks}
            onToggleArchived={toggleArchived}
          />
          {tasking && <TasksBoard tasks={tasks} sessions={sessions} onOpen={open} onClose={() => setTasking(false)} />}
          {asking && <QuestionsPanel questions={questions} onOpen={open} onSettled={refreshQuestions} onClose={() => setAsking(false)} />}
          {loaded && !sessions.length && !graphing && (
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
