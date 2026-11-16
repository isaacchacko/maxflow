import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Face } from "./AgentFace";
import { act } from "./plan";

type Line = { from: "you" | "agent"; text: string };

export function AgentChat() {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { from: "agent", text: "Tell me what to do. Try \"add a chart to pagination\", \"start the reconciler\" or \"ask isaac about overdue\"." },
  ]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || working) return;
    setInput("");
    setLines(l => [...l, { from: "you", text }]);
    setWorking(true);
    try {
      await act(text, say => setLines(l => [...l, { from: "agent", text: say }]));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="fixed right-5 bottom-5 z-40 flex flex-col items-end gap-3">
      {open && (
        <Card className="h-96 w-80 gap-0 py-0 shadow-2xl animate-in fade-in slide-in-from-bottom-2">
          <CardHeader className="flex items-center gap-2 border-b px-3 py-2 [.border-b]:pb-2">
            <Face working={working} size={24} />
            <CardTitle className="text-sm">maxflow</CardTitle>
            <span className="text-xs text-muted-foreground">{working ? "working…" : "idle"}</span>
            <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={() => setOpen(false)}>
              <X />
            </Button>
          </CardHeader>
          <CardContent ref={listRef} className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
            {lines.map((line, i) => (
              <p
                key={i}
                className={cn(
                  "max-w-[85%] rounded-xl px-3 py-1.5 text-sm",
                  line.from === "you" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted",
                )}
              >
                {line.text}
              </p>
            ))}
          </CardContent>
          <CardFooter className="border-t p-2 [.border-t]:pt-2">
            <form onSubmit={send} className="w-full">
              <Input
                autoFocus
                value={input}
                onChange={e => setInput(e.target.value)}
                disabled={working}
                placeholder={working ? "Working…" : "Ask the agent…"}
              />
            </form>
          </CardFooter>
        </Card>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-agent="face"
            data-face
            onClick={() => setOpen(o => !o)}
            className="rounded-full shadow-lg transition-transform hover:scale-105 active:scale-95"
          >
            <Face working={working} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">maxflow agent</TooltipContent>
      </Tooltip>
    </div>
  );
}
