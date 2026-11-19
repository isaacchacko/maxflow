import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A ref for a list's highlighted row: it scrolls the list just enough to show the row each time the highlight moves to it. */
export const scrollIntoReach = (row: Element | null) => row?.scrollIntoView({ block: "nearest" });
