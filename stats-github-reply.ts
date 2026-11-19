import { isRecord } from "./shared/guards";

export function peek(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function pick(value: unknown, path: string): unknown {
  const found = peek(value, path);
  if (found === undefined) throw new Error(`GitHub's reply has no ${path}`);
  return found;
}

export function pickNumber(value: unknown, path: string): number {
  const found = pick(value, path);
  if (typeof found !== "number") throw new TypeError(`GitHub's reply has no number at ${path}`);
  return found;
}

export function pickString(value: unknown, path: string): string {
  const found = pick(value, path);
  if (typeof found !== "string") throw new TypeError(`GitHub's reply has no string at ${path}`);
  return found;
}

export function pickArray(value: unknown, path: string): unknown[] {
  const found = pick(value, path);
  if (!Array.isArray(found)) throw new TypeError(`GitHub's reply has no list at ${path}`);
  return found;
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
