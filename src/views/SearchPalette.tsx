import { Bot, GitPullRequest, Hash, MessagesSquare, Network, Radar, Search, User, Waypoints, X } from "lucide-react";
import { useKeyedState } from "@/lib/useKeyedState";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn, hasText, scrollIntoReach } from "@/lib/utils";

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
  source?: string | undefined;
  state?: string | undefined;
  status?: string | undefined;
  objectives: string[];
};

const fixedValues: Record<Exclude<ChipKey, "in">, string[]> = {
  is: ["event", "objective", "router", "agent", "thread"],
  from: ["you", "gh", "slack"],
  state: ["working", "waiting", "idle", "asleep"],
  status: ["todo", "doing", "review", "done"],
};

const chipKeys: ChipKey[] = ["is", "from", "state", "status", "in"];
const isChipKey = (key: string | undefined): key is ChipKey => chipKeys.some(k => k === key);

const kindIcon: Record<Kind, typeof User> = { event: Hash, objective: Waypoints, router: Network, agent: User, thread: MessagesSquare };
const sourceIcon: Record<string, typeof User> = { isaac: User, gh: GitPullRequest, slack: Hash, agent: Bot, sentry: Radar, yarn: Waypoints };

function valuesFor(key: ChipKey, objectiveIds: string[]) {
  return key === "in" ? objectiveIds : fixedValues[key];
}

function chipFrom(token: string, objectiveIds: string[]): Chip | undefined {
  const m = /^(\w+):(\S+)$/.exec(token);
  if (!m) return;
  const [, key, typed] = m;
  if (typed === undefined || !isChipKey(key)) return;
  const value = typed.toLowerCase();
  const known = valuesFor(key, objectiveIds);
  const exact = known.find(v => v === value) ?? (key === "in" ? known.find(v => v.includes(value)) : undefined);
  return hasText(exact) ? { key, value: exact } : undefined;
}

function hasEveryWord(hay: string, text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const h = hay.toLowerCase();
  return words.every(w => h.includes(w));
}

const sourceOf = (v: string) => (v === "you" ? "isaac" : v);

function doesMatchAnyValue(n: NodeMeta, key: ChipKey, values: string[]) {
  switch (key) {
    case "is": {
      return values.includes(n.kind);
    }
    case "from": {
      return values.some(v => n.source === sourceOf(v));
    }
    case "state": {
      return values.includes(n.state ?? "");
    }
    case "status": {
      return values.includes(n.status ?? "");
    }
    case "in": {
      return values.some(v => n.objectives.includes(v));
    }
  }
}

export function hits(nodes: NodeMeta[], { chips, text }: Filter) {
  const valuesByKey = new Map<ChipKey, string[]>();
  for (const c of chips) valuesByKey.set(c.key, [...(valuesByKey.get(c.key) ?? []), c.value]);
  const keys = [...valuesByKey];
  return nodes.filter(n => keys.every(([key, values]) => doesMatchAnyValue(n, key, values)) && hasEveryWord(n.text, text));
}

export const isActive = (f: Filter) => f.chips.length > 0 || f.text.trim().length > 0;

function suggestionsFor(text: string, token: string, objectiveIds: string[]): string[] {
  const [tokenKey, tokenValue = ""] = token.includes(":") ? token.split(":") : [];
  if (hasText(tokenKey)) {
    if (!isChipKey(tokenKey)) return [];
    return valuesFor(tokenKey, objectiveIds)
      .filter(v => v.startsWith(tokenValue) || (tokenKey === "in" && v.includes(tokenValue)))
      .map(v => `${tokenKey}:${v}`);
  }
  if (token !== "") return chipKeys.filter(k => k.startsWith(token)).map(k => `${k}:`);
  return text === "" ? chipKeys.map(k => `${k}:`) : [];
}

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

function Suggestions({ suggestions, onAccept }: { suggestions: string[]; onAccept: (suggestion: string) => void }) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
      {suggestions.slice(0, 12).map(s => (
        <button key={s} onClick={() => onAccept(s)} className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-ring hover:text-foreground">
          {s}
        </button>
      ))}
    </div>
  );
}

function ResultRow({ n, index, isCurrent, onHover, onPick }: { n: NodeMeta; index: number; isCurrent: boolean; onHover: () => void; onPick: () => void }) {
  const Icon = (hasText(n.source) ? sourceIcon[n.source] : undefined) ?? kindIcon[n.kind];
  return (
    <button
      data-index={index}
      ref={isCurrent ? scrollIntoReach : undefined}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn("flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm", isCurrent && "bg-muted")}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{n.kind}</span>
      <span className="shrink-0 font-mono text-xs">{n.label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{n.detail}</span>
    </button>
  );
}

type PaletteProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  nodes: NodeMeta[];
  objectiveIds: string[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  onPick: (node: NodeMeta) => void;
};

function usePalette({ onOpenChange, nodes, objectiveIds, filter, onFilter, onPick }: PaletteProps) {
  const { chips, text } = filter;
  const [active, setActive] = useKeyedState(`${chips.length}:${text}`, 0);
  const results = isActive(filter) ? hits(nodes, filter).slice(0, 50) : [];
  const token = text.split(" ").at(-1) ?? "";
  const suggestions = suggestionsFor(text, token, objectiveIds);

  const setText = (next: string) => {
    const parts = next.split(" ");
    const chip = next.endsWith(" ") ? chipFrom(parts.at(-2) ?? "", objectiveIds) : undefined;
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
    const chip = chipFrom(suggestion, objectiveIds);
    if (chip) onFilter({ chips: [...chips, chip], text: rest.join(" ") });
  };

  const chipOrPick = () => {
    const chip = chipFrom(token, objectiveIds);
    if (chip) {
      onFilter({ chips: [...chips, chip], text: text.split(" ").slice(0, -1).join(" ") });
      return;
    }
    const pick = results[active];
    if (pick) onPick(pick);
    else onOpenChange(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const [firstSuggestion] = suggestions;
    if (text === "" && e.key === "Backspace" && chips.length > 0) {
      onFilter({ chips: chips.slice(0, -1), text });
      return;
    }
    if (e.key === "Tab" && hasText(firstSuggestion)) {
      e.preventDefault();
      accept(firstSuggestion);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(i => Math.min(results.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(i => Math.max(0, i - 1));
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    chipOrPick();
  };

  return { active, setActive, results, suggestions, setText, accept, onKeyDown };
}

export function SearchPalette(props: PaletteProps) {
  const { isOpen, onOpenChange, filter, onFilter, onPick } = props;
  const { chips, text } = filter;
  const { active, setActive, results, suggestions, setText, accept, onKeyDown } = usePalette(props);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
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

        <Suggestions suggestions={suggestions} onAccept={accept} />

        <div className="max-h-96 overflow-y-auto py-1">
          {isActive(filter) && results.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results</p>}
          {results.map((n, i) => (
            <ResultRow key={n.id} n={n} index={i} isCurrent={i === active} onHover={() => setActive(i)} onPick={() => onPick(n)} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
