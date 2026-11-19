import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const scrollIntoReach = (row: Element | null) => row?.scrollIntoView({ block: "nearest" });

export const hasText = (text: string | null | undefined): text is string => text !== undefined && text !== null && text !== "";
