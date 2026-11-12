import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ago, api, home, ltr, store, type Chat, type Session } from "@/lib/api";

export function ResumeDialog({ open, onOpenChange, onResumed }: { open: boolean; onOpenChange: (open: boolean) => void; onResumed: (s: Session) => void }) {
  const [q, setQ] = useState("");
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [bypass, setBypass] = useState(() => store.get("mf.bypass") !== "0");
  const [fork, setFork] = useState<Chat | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => api.chats(q).then(setChats), q ? 150 : 0);
    return () => clearTimeout(t);
  }, [q, open]);
  useEffect(() => {
    if (open) (setQ(""), setChats(null));
  }, [open]);

  async function resume(c: Chat, force = false) {
    const res = await api.resume(c.id, bypass, force);
    if (res.status === 409) return setFork(c);
    if (!res.ok) return void toast.error(await res.text());
    onOpenChange(false);
    onResumed(await res.json());
  }

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false} title="Resume a Claude chat" description="Search chats by title, prompt, folder or id" className="top-[12vh] translate-y-0 sm:max-w-3xl">
        <CommandInput value={q} onValueChange={setQ} placeholder="Search chats by title, prompt, folder, id" />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>{chats ? "No chats match." : "Loading…"}</CommandEmpty>
          {chats?.map((c) => (
            <CommandItem key={c.id} value={c.id} onSelect={() => resume(c)} title={c.prompt} className="flex-col items-stretch gap-1 py-2">
              <span className="truncate">{c.title}</span>
              <span className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
                <span className="flex-1 truncate [direction:rtl] text-left">{ltr(home(c.cwd))}</span>
                {c.session ? <Badge variant="outline" className="h-4 border-primary/40 px-1 text-[10px] text-primary">open in maxflow</Badge> : c.live && <Badge variant="outline" className="h-4 border-yellow-500/40 px-1 text-[10px] text-yellow-400">open elsewhere</Badge>}
                <span>{ago(c.mtime)}</span>
              </span>
            </CommandItem>
          ))}
        </CommandList>
        <label className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <Checkbox checked={bypass} onCheckedChange={(v) => (setBypass(!!v), store.set("mf.bypass", v ? "1" : "0"))} />
          Bypass permissions
        </label>
      </CommandDialog>
      <AlertDialog open={!!fork} onOpenChange={(o) => !o && setFork(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chat is open elsewhere</AlertDialogTitle>
            <AlertDialogDescription>"{fork?.title}" is already open in another claude process. Resuming it here too will fork the transcript.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => fork && resume(fork, true)}>Resume anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
