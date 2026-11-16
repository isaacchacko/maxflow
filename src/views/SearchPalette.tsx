import { Bot, GitPullRequest, Hash, MessagesSquare, Network, Radar, Search, User, Waypoints, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type Kind = "event" | "objective" | "router" | "agent" | "thread";
export type ChipKey = "is" | "from" | "state" | "status" | "in";
export type Chip = { key: ChipKey; value: string };
export type Filter = { chips: Chip[]; text: string };

export type NodeMeta = {
  id: string;
  kind: Kind;
  label: string;
  detail: string;
  text: string;
  source?: string;
  state?: string;
  status?: string;
  objectives: string[];
};

const fixedValues: Record<Exclude<ChipKey, "in">, string[]> = {
  is: ["event", "objective", "router", "agent", "thread"],
  from: ["you", "gh", "slack"],
  state: ["working", "waiting", "idle", "asleep"],
  status: ["todo", "doing", "review", "done"],
};

const chipKeys = Object.keys(fixedValues).concat("in") as ChipKey[];

const kindIcon: Record<Kind, typeof User> = { event: Hash, objective: Waypoints, router: Network, agent: User, thread: MessagesSquare };
const sourceIcon: Record<string, typeof User> = { isaac: User, gh: GitPullRequest, slack: Hash, agent: Bot, sentry: Radar, maxflow: Waypoints };

function valuesFor(key: ChipKey, objectiveIds: string[]) {
  return key === "in" ? objectiveIds : fixedValues[key];
}

function chipFrom(token: string, objectiveIds: string[]): Chip | undefined {
  const m = token.match(/^(\w+):(\S+)$/);
  if (!m) return;
  const key = m[1] as ChipKey;
  if (!chipKeys.includes(key)) return;
  const value = m[2]!.toLowerCase();
  const known = valuesFor(key, objectiveIds);
  const exact = known.find(v => v === value) ?? (key === "in" ? known.find(v => v.includes(value)) : undefined);
  return exact ? { key, value: exact } : undefined;
}

function textMatches(hay: string, text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const h = hay.toLowerCase();
  return words.every(w => h.includes(w));
}

/** Chips of the same key widen the search (OR); different keys narrow it (AND); free text must all appear. */
export function hits(nodes: NodeMeta[], { chips, text }: Filter) {
  const byKey = new Map<ChipKey, string[]>();
  for (const c of chips) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c.value]);
  const source = (v: string) => (v === "you" ? "isaac" : v);
  return nodes.filter(n => {
    for (const [key, values] of byKey) {
      if (key === "is" && !values.includes(n.kind)) return false;
      if (key === "from" && !values.some(v => n.source === source(v))) return false;
      if (key === "state" && !values.includes(n.state ?? "")) return false;
      if (key === "status" && !values.includes(n.status ?? "")) return false;
      if (key === "in" && !values.some(v => n.objectives.includes(v))) return false;
    }
    return textMatches(n.text, text);
  });
}

export const isActive = (f: Filter) => f.chips.length > 0 || f.text.trim().length > 0;

export function ChipView({ chip, onRemove }: { chip: Chip; onRemove?: () => void }) {
  return (
    <Badge variant="secondary" className="gap-1 font-mono text-[11px]">
      <span className="text-muted-foreground">{chip.key}:</span>
      {chip.value}
      {onRemove && (
        <button
          onClick={e => {
            e.stopPropagation();
            onRemove();
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </Badge>
  );
}

export function SearchPalette({
  open,
  onOpenChange,
  nodes,
  objectiveIds,
  filter,
  onFilter,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: NodeMeta[];
  objectiveIds: string[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  onPick: (node: NodeMeta) => void;
}) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { chips, text } = filter;

  const results = isActive(filter) ? hits(nodes, filter).slice(0, 50) : [];
  const token = text.split(" ").at(-1) ?? "";
  const [tokenKey, tokenValue] = token.includes(":") ? token.split(":") : [undefined, undefined];
  const suggestions: string[] = tokenKey
    ? chipKeys.includes(tokenKey as ChipKey)
      ? valuesFor(tokenKey as ChipKey, objectiveIds)
          .filter(v => v.startsWith(tokenValue ?? "") || (tokenKey === "in" && v.includes(tokenValue ?? "")))
          .map(v => `${tokenKey}:${v}`)
      : []
    : token
      ? chipKeys.filter(k => k.startsWith(token)).map(k => `${k}:`)
      : text
        ? []
        : chipKeys.map(k => `${k}:`);

  useEffect(() => setActive(0), [text, chips.length]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const setText = (next: string) => {
    const parts = next.split(" ");
    const finished = parts.length > 1 ? parts.at(-2)! : "";
    const chip = next.endsWith(" ") && chipFrom(finished, objectiveIds);
    if (chip) {
      onFilter({ chips: [...chips, chip], text: parts.slice(0, -2).join(" ") });
      return;
    }
    onFilter({ chips, text: next });
  };

  const accept = (suggestion: string) => {
    const rest = text.split(" ").slice(0, -1);
    if (suggestion.endsWith(":")) {
      onFilter({ chips, text: [...rest, suggestion].join(" ") });
      return;
    }
    const chip = chipFrom(suggestion, objectiveIds)!;
    onFilter({ chips: [...chips, chip], text: rest.join(" ") });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !text && chips.length) {
      onFilter({ chips: chips.slice(0, -1), text });
      return;
    }
    if (e.key === "Tab" && suggestions[0]) {
      e.preventDefault();
      accept(suggestions[0]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(i => Math.min(results.length - 1, i + 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(i => Math.max(0, i - 1));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const chip = chipFrom(token, objectiveIds);
      if (chip) {
        onFilter({ chips: [...chips, chip], text: text.split(" ").slice(0, -1).join(" ") });
        return;
      }
      const pick = results[active];
      if (pick) onPick(pick);
      else onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-24 max-w-xl translate-y-0 gap-0 p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          {chips.map((c, i) => (
            <ChipView key={`${c.key}:${c.value}:${i}`} chip={c} onRemove={() => onFilter({ chips: chips.filter((_, j) => j !== i), text })} />
          ))}
          <input
            autoFocus
            data-agent="palette"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search"
            className="min-w-40 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
            {suggestions.slice(0, 12).map(s => (
              <button key={s} onClick={() => accept(s)} className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-ring hover:text-foreground">
                {s}
              </button>
            ))}
          </div>
        )}

        <div ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {isActive(filter) && results.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results</p>}
          {results.map((n, i) => {
            const Icon = (n.source && sourceIcon[n.source]) || kindIcon[n.kind];
            return (
              <button
                key={n.id}
                data-index={i}
                onMouseMove={() => setActive(i)}
                onClick={() => onPick(n)}
                className={cn("flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm", i === active && "bg-muted")}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="w-16 shrink-0 text-xs text-muted-foreground">{n.kind}</span>
                <span className="shrink-0 font-mono text-xs">{n.label}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{n.detail}</span>
              </button>
            );
          })}
        </div>

      </DialogContent>
    </Dialog>
  );
}
