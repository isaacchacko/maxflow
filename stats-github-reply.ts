import { isRecord } from "./shared/guards";

function walk(value: unknown, path: string, onMissing: () => unknown): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isRecord(current) || !(key in current)) return onMissing();
    current = current[key];
  }
  return current;
}

const missing = (path: string) => () => {
  throw new Error(`GitHub's reply has no ${path}`);
};

export const peek = (value: unknown, path: string) => walk(value, path, () => undefined);
export const pick = (value: unknown, path: string) => walk(value, path, missing(path));

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
