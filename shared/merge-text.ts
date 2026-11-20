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

type Step = { kind: "same" | "drop" | "add"; token: string };

function stepsOf(a: string[], b: string[]): Step[] {
  const table = lcsTable(a, b);
  const steps: Step[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    const kept = a[i];
    const added = b[j];
    if (kept !== undefined && kept === added) steps.push({ kind: "same", token: kept });
    else if (kept !== undefined && (added === undefined || (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))) steps.push({ kind: "drop", token: kept });
    else steps.push({ kind: "add", token: added ?? "" });
    const step = steps.at(-1);
    if (step?.kind !== "add") i += 1;
    if (step?.kind !== "drop") j += 1;
  }
  return steps;
}

// the spans of base that changed, in base's character offsets, from a token-level longest common subsequence
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
// two inserts at one spot don't clash: his typing goes first, the other edit after it
const clashes = (x: Hunk, y: Hunk) => (x.start < y.end && y.start < x.end) || (x.start === y.start && x.end > x.start && y.end > y.start);

function ordered(hunks: Hunk[]) {
  return hunks.toSorted((x, y) => x.start - y.start || Number(x.end > x.start) - Number(y.end > y.start) || Number(y.isMine) - Number(x.isMine));
}

// three-way merge of two edits to one box's text; undefined when both changed the same words
export function mergeText(base: string, mine: string, theirs: string): string | undefined {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const ours = hunksOf(base, mine, true);
  const others = hunksOf(base, theirs, false).filter((t) => !ours.some((m) => isSameHunk(m, t)));
  if (ours.some((m) => others.some((t) => clashes(m, t)))) return undefined;
  let merged = "";
  let at = 0;
  for (const h of ordered([...ours, ...others])) {
    merged += base.slice(at, h.start) + h.text;
    at = Math.max(at, h.end);
  }
  return merged + base.slice(at);
}
