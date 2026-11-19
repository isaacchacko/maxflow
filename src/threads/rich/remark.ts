import { hasText } from "@/lib/utils";
import { taskStore } from "@/store";

export const LINEAR = "https://linear.app/dryftai/issue";
export const REPO = "dryft-ai/app";

const NAMED = /(?<![\w/&#-])(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d{3,})|((?:PRO|DRY|TI)-\d+)|(th-[0-9a-f]{6})|(t\d+))\b/g;

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

const isUnknownTask = (id: string | undefined) => hasText(id) && taskStore.get().every(t => t.id !== id);

function chipUrl(m: RegExpExecArray) {
  const [, repo, prNumber, bareNumber, issue, thread, task] = m;
  if (hasText(thread)) return `ref:thread/${thread}`;
  if (hasText(task)) return `ref:task/${task}`;
  if (hasText(issue)) return `linear:${issue}`;
  return `pr:${(repo ?? REPO).toLowerCase()}/${prNumber ?? bareNumber ?? ""}`;
}

function chipsInText(value: string) {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(NAMED)) {
    if (isUnknownTask(m[6])) continue;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({ type: "link", url: chipUrl(m), children: [{ type: "text", value: m[0] }] });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function chipNamed(node: MdNode) {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap(child => {
    if (child.type === "text") return chipsInText(child.value ?? "");
    chipNamed(child);
    return [child];
  });
}

export const remarkChips = () => chipNamed;

function typedLineBreaks(value: string) {
  return value.split("\n").flatMap((line, i) => (i === 0 ? { type: "text", value: line } : [{ type: "break" }, { type: "text", value: line }]));
}

function keepTypedLineBreaks(node: MdNode) {
  if (!node.children) return;
  node.children = node.children.flatMap(child => {
    if (child.type === "text") return typedLineBreaks(child.value ?? "");
    keepTypedLineBreaks(child);
    return [child];
  });
}

export const remarkBreaks = () => keepTypedLineBreaks;
