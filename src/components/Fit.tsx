import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

const STEPS = ["full", "short", "glyph"] as const;

function fitFullestStep(row: HTMLElement) {
  for (const step of STEPS) {
    row.setAttribute("data-fit", step);
    if (row.scrollWidth <= row.clientWidth) return;
  }
}

function refitOnResizeOrChange(row: HTMLElement | null) {
  if (!row) return;
  fitFullestStep(row);
  const resized = new ResizeObserver(() => fitFullestStep(row));
  resized.observe(row);
  const changed = new MutationObserver(() => fitFullestStep(row));
  changed.observe(row, { childList: true, subtree: true, characterData: true });
  return () => {
    resized.disconnect();
    changed.disconnect();
  };
}

export function FitRow({ className, ...props }: Omit<ComponentProps<"header">, "ref">) {
  return <header ref={refitOnResizeOrChange} className={cn("group/fit flex min-w-0 flex-nowrap overflow-hidden", className)} {...props} />;
}

export function FitLabel({ full, short, glyph }: { full: ReactNode; short?: ReactNode; glyph?: ReactNode }) {
  const hasShort = short !== undefined;
  const hasGlyph = glyph !== undefined;
  return (
    <>
      <span className={cn("whitespace-nowrap", hasShort && "group-data-[fit=short]/fit:hidden", (hasShort || hasGlyph) && "group-data-[fit=glyph]/fit:hidden")}>{full}</span>
      {hasShort && <span className={cn("hidden whitespace-nowrap group-data-[fit=short]/fit:inline", !hasGlyph && "group-data-[fit=glyph]/fit:inline")}>{short}</span>}
      {hasGlyph && glyph !== false && <span className="hidden whitespace-nowrap tabular-nums group-data-[fit=glyph]/fit:inline">{glyph}</span>}
    </>
  );
}
