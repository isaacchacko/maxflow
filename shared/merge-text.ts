type Hunk = { start: number; end: number; text: string; isMine: boolean };

const MAX_TABLE = 4_000_000;
const tokensOf = (text: string) => text.match(/\s+|\w+|[^\s\w]/g) ?? [];

function lcsTable(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i] ?? new Uint32Array();
    const below = table[i + 1] ?? new Uint32Array();
    for (let j = b.length - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
  }
  return table;
}

export type Step = { kind: "same" | "drop" | "add"; token: string };

type Table = Uint32Array[];
const scoreAt = (table: Table, i: number, j: number) => table[i]?.[j] ?? 0;

function stepAt(a: string[], b: string[], table: Table, { i, j }: { i: number; j: number }): Step {
  const kept = a[i];
  const added = b[j];
  if (kept !== undefined && kept === added) return { kind: "same", token: kept };
  const isDrop = kept !== undefined && (added === undefined || scoreAt(table, i + 1, j) >= scoreAt(table, i, j + 1));
  return isDrop ? { kind: "drop", token: kept } : { kind: "add", token: added ?? "" };
}

function stepsOf(a: string[], b: string[]): Step[] {
  const table = lcsTable(a, b);
  const steps: Step[] = [];
  const at = { i: 0, j: 0 };
  while (at.i < a.length || at.j < b.length) {
    const step = stepAt(a, b, table, at);
    steps.push(step);
    if (step.kind !== "add") at.i += 1;
    if (step.kind !== "drop") at.j += 1;
  }
  return steps;
}

function hunksOf(base: string, changed: string, isMine: boolean): Hunk[] {
  const [a, b] = [tokensOf(base), tokensOf(changed)];
  if (a.length * b.length > MAX_TABLE) return [{ start: 0, end: base.length, text: changed, isMine }];
  const hunks: Hunk[] = [];
  let at = 0;
  let open: Hunk | undefined;
  for (const step of stepsOf(a, b)) {
    if (step.kind === "same") {
      open = undefined;
      at += step.token.length;
      continue;
    }
    if (!open) {
      open = { start: at, end: at, text: "", isMine };
      hunks.push(open);
    }
    if (step.kind === "add") open.text += step.token;
    else {
      at += step.token.length;
      open.end = at;
    }
  }
  return hunks;
}

const isSameHunk = (x: Hunk, y: Hunk) => x.start === y.start && x.end === y.end && x.text === y.text;
const isReplace = (h: Hunk) => h.end > h.start;
const isClash = (x: Hunk, y: Hunk) => (x.start < y.end && y.start < x.end) || (x.start === y.start && isReplace(x) && isReplace(y));

function insertsFirstMineFirst(x: Hunk, y: Hunk) {
  if (x.start !== y.start) return x.start - y.start;
  if (isReplace(x) !== isReplace(y)) return isReplace(x) ? 1 : -1;
  if (x.isMine === y.isMine) return 0;
  return x.isMine ? -1 : 1;
}

export function mergeText(base: string, mine: string, theirs: string): string | undefined {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const ours = hunksOf(base, mine, true);
  const others = hunksOf(base, theirs, false).filter((t) => ours.every((m) => !isSameHunk(m, t)));
  if (ours.some((m) => others.some((t) => isClash(m, t)))) return;
  const hunks = [...ours, ...others].toSorted(insertsFirstMineFirst);
  let merged = "";
  let at = 0;
  for (const h of hunks) {
    merged += base.slice(at, h.start) + h.text;
    at = Math.max(at, h.end);
  }
  return merged + base.slice(at);
}

export function tokenDiff(base: string, changed: string): Step[] {
  const [a, b] = [tokensOf(base), tokensOf(changed)];
  if (a.length * b.length > MAX_TABLE) return [{ kind: "drop", token: base }, { kind: "add", token: changed }];
  return stepsOf(a, b);
}
