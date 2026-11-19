import { cn } from "@/lib/utils";
import type { Mode } from "../../../shared/restrictions-types";

export const field = "w-full rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus:border-foreground/30";
export const chip = "max-w-48 shrink-0 truncate rounded bg-muted px-1.5 text-[11px] text-muted-foreground";

type ModeLook = { mode: Mode; label: string; on: string; dot: string; legendLine: string; whatItDoesTo: (noun: string) => string };

export const MODE_LOOK: Record<Mode, ModeLook> = {
  allow: { mode: "allow", label: "Allow", on: "bg-ok/10 text-ok", dot: "bg-ok", legendLine: "Goes ahead on its own", whatItDoesTo: () => "The agent goes ahead on its own." },
  ask: { mode: "ask", label: "Ask me", on: "bg-warn-soft text-warn", dot: "bg-warn", legendLine: "Stops and asks you first", whatItDoesTo: noun => `The agent asks you in its thread first; your yes lets that one ${noun} through.` },
  deny: { mode: "deny", label: "Block", on: "bg-destructive/10 text-destructive", dot: "bg-destructive", legendLine: "Is told no", whatItDoesTo: () => "The agent is told no, and doesn't do it." },
};
export const MODES = [MODE_LOOK.allow, MODE_LOOK.ask, MODE_LOOK.deny];

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ModeToggle({ mode, isInherited = false, onChange }: { mode: Mode; isInherited?: boolean; onChange: (m: Mode) => void }) {
  return (
    <div role="radiogroup" className="flex shrink-0 rounded-md border p-0.5 text-xs">
      {MODES.map(m => (
        <button
          key={m.mode}
          role="radio"
          aria-checked={mode === m.mode}
          onClick={() => {
            if (isInherited || mode !== m.mode) onChange(m.mode);
          }}
          className={cn("w-14 rounded py-0.5 text-center font-medium", mode === m.mode ? cn(m.on, isInherited && "opacity-45") : "text-muted-foreground hover:text-foreground")}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
