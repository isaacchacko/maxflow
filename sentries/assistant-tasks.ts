import { BASE as base } from "../instance";
import { isRecord } from "../shared/guards";
import { writeStateJson } from "../state";

const FETCH_MS = 30_000;
const MIN_ASK_KEY = 12;
const ASK_KEY_CHARS = 60;
const ASKED = "asked: ";
const PR_URL = /github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export type Task = { id: number; title: string; status: string; sessions: string[]; links: string[]; timeline: { text: string }[] };
const isTask = (value: unknown): value is Task =>
  isRecord(value) && typeof value["id"] === "number" && typeof value["status"] === "string" && Array.isArray(value["links"]) && Array.isArray(value["timeline"]);

export async function fetchTasks(): Promise<Task[]> {
  const tasks: unknown = await (await fetch(`${base}/api/tasks`, { signal: AbortSignal.timeout(FETCH_MS) })).json();
  return Array.isArray(tasks) ? tasks.filter(isTask) : [];
}

const askKey = (text: string) =>
  text
    .replaceAll(/<\/?pasted_content[^>]*>/g, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/…$/, "")
    .slice(0, ASK_KEY_CHARS)
    .toLowerCase();

const isSameAsk = (key: string, line: { text: string }) => {
  if (!line.text.startsWith(ASKED)) return false;
  const asked = askKey(line.text.slice(ASKED.length));
  return asked.length >= MIN_ASK_KEY && (key.startsWith(asked) || asked.startsWith(key));
};

export function taskTheServerFiledFromAsk(tasks: Task[], text: string): number | undefined {
  const key = askKey(text);
  if (key.length < MIN_ASK_KEY) return;
  return tasks.findLast((t) => t.status !== "dropped" && t.timeline.some((line) => isSameAsk(key, line)))?.id;
}

function prStatesByUrl(urls: string[], data: Record<string, unknown>) {
  return Object.fromEntries(
    urls.flatMap((u, i): [string, string][] => {
      const pr = data[`p${i}`];
      const prState = isRecord(pr) ? pr["state"] : undefined;
      return typeof prState === "string" && prState !== "" ? [[u, prState]] : [];
    }),
  );
}

export async function lookUpPrsOfOpenTasksInOneQuery() {
  const tasks = await fetchTasks();
  const open = tasks.filter((t) => !["done", "dropped"].includes(t.status));
  const urls = [...new Set(open.flatMap((t) => t.links.filter((l) => PR_URL.test(l))))];
  if (urls.length === 0) return;
  const query = `{${urls.map((u, i) => `p${i}: resource(url: ${JSON.stringify(u)}) { ... on PullRequest { state } }`).join(" ")}}`;
  const out = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${query}`]);
  const stdout = out.stdout.toString();
  const reply: unknown = JSON.parse(stdout === "" ? "{}" : stdout);
  const data = isRecord(reply) ? reply["data"] : undefined;
  if (!isRecord(data)) {
    console.error(`PR lookup failed: ${out.stderr.toString().slice(0, 300)}`);
    return;
  }
  writeStateJson("task-prs.json", prStatesByUrl(urls, data));
}
