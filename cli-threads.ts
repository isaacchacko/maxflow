import { argAt, call, fail, flag, hasArg, isTruthy, listAt, localTime, positional, post, replies, replyOf, str, withImages, withoutImages, type Reply, type Verb } from "./cli-shared";

async function listThreads() {
  const threads = replies(await call("/api/threads"));
  for (const t of threads) console.log(`${str(t, "id")}  ${str(t, "objective")}  ${str(t, "title")}  (${listAt(t, "messages").length} messages)`);
}

async function newSubthread(args: string[]) {
  const [thread, message] = (flag(args, "--parent") ?? "").split(":", 2);
  const text = await withImages(positional(args.slice(1), ["--parent", "--image"]).join(" "), args);
  const t = replyOf(await post("/api/threads", { parent: { thread, message }, text }));
  console.log(t["id"]);
}

async function newThread(args: string[]) {
  const title = positional(args.slice(1), ["--objective", "--image"]).join(" ");
  const t = replyOf(await post("/api/threads", { title, objective: flag(args, "--objective") }));
  if (args.includes("--image")) await post(`/api/threads/${str(t, "id")}/messages`, { text: await withImages("", args) });
  console.log(t["id"]);
}

function followMerges(all: Reply[], id: string) {
  let t = all.find((x) => x["id"] === id);
  while (isTruthy(t?.["mergedInto"])) {
    const into = t?.["mergedInto"];
    t = all.find((x) => x["id"] === into);
  }
  return t;
}

const onObjective = (t: Reply) => (isTruthy(t["objective"]) ? ` on ${str(t, "objective")}` : "");

function threadHeading(t: Reply, shown: number) {
  const parent = replyOf(t["parent"]);
  const subthread = isTruthy(t["parent"]) ? `, a subthread of ${str(parent, "thread")} under ${str(parent, "message")}` : "";
  const total = listAt(t, "messages").length;
  return `${str(t, "id")} "${str(t, "title")}"${onObjective(t)}${subthread}: ${total} messages${shown < total ? `, the last ${shown} below` : ""}`;
}

async function readThread(args: string[]) {
  const asked = argAt(args, 1);
  const t = followMerges(replies(await call("/api/threads")), asked);
  if (!t) fail(`no thread ${asked}`);
  if (t["id"] !== asked) console.log(`${asked} was merged into ${str(t, "id")} "${str(t, "title")}"${onObjective(t)}; its messages are there now, so that thread is below.\n`);
  const sessions = replies(await call("/api/sessions"));
  const names = new Map(sessions.flatMap((s): [unknown, string][] => (typeof s["name"] === "string" ? [[s["id"], s["name"]]] : [])));
  const last = Number(flag(args, "--last") ?? 0);
  const messages = replies(t["messages"]);
  const shown = last > 0 ? messages.slice(-last) : messages;
  console.log(threadHeading(t, shown.length));
  for (const m of shown) console.log(`\n${str(m, "id")}  ${localTime(m["at"])}  ${m["from"] === "isaac" ? "Isaac" : (names.get(m["from"]) ?? str(m, "from"))}\n${str(m, "text")}`);
}

async function postToThread(args: string[]) {
  const words = withoutImages(args.slice(2)).join(" ");
  await post(`/api/threads/${argAt(args, 1)}/messages`, { text: await withImages(words, args) });
}

async function mergeThread(args: string[]) {
  const t = replyOf(await post(`/api/threads/${argAt(args, 1)}/merge`, { into: argAt(args, 2) }));
  console.log(`${argAt(args, 1)} merged into ${str(t, "id")} (${listAt(t, "messages").length} messages)`);
}

async function moveThread(args: string[]) {
  const r = replyOf(await post(`/api/threads/${argAt(args, 1)}/objective`, { objective: argAt(args, 2) }));
  const handed = Array.isArray(r["handed"]) && r["handed"].length > 0 ? `; handed them his unanswered ${listAt(r, "handed").join(" ")}` : "";
  console.log(`moved ${listAt(r, "threads").join(" ")} to ${str(r, "objective")} (routers ${listAt(r, "routers").join(" ") || "none"})${handed}`);
}

export const threadVerbs: Verb[] = [
  { matches: (verb) => verb === "threads", run: listThreads },
  { matches: (verb, args) => verb === "thread" && args[0] === "new" && isTruthy(flag(args, "--parent")), run: newSubthread },
  { matches: (verb, args) => verb === "thread" && args[0] === "new" && hasArg(args, 1), run: newThread },
  { matches: (verb, args) => verb === "thread" && args[0] === "read" && hasArg(args, 1), run: readThread },
  { matches: (verb, args) => verb === "thread" && (args[0] === "post" || args[0] === "done") && hasArg(args, 2), run: postToThread },
  { matches: (verb, args) => verb === "thread" && args[0] === "merge" && hasArg(args, 2), run: mergeThread },
  { matches: (verb, args) => verb === "thread" && args[0] === "move" && hasArg(args, 2), run: moveThread },
  {
    matches: (verb, args) => verb === "thread" && args[0] === "status" && hasArg(args, 2),
    run: async (args) => {
      await post(`/api/threads/${argAt(args, 1)}/status`, { text: args.slice(2).join(" ") });
    },
  },
];
