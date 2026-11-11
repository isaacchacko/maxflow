#!/usr/bin/env bun
// maxflow new [--name N] [--cwd DIR] [-- cmd ...] | maxflow ls | maxflow resume <claude-session-id>
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
const [verb, ...rest] = process.argv.slice(2);

async function create(body: { name?: string; cmd?: string[]; cwd?: string }) {
  const res = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify(body) });
  const s = await res.json();
  console.log(`${base}/s/${s.id}`);
}

if (verb === "ls") {
  for (const s of await (await fetch(`${base}/api/sessions`)).json()) console.log(`${s.id}  ${s.running ? "run " : "exit"}  ${s.name}  ${base}/s/${s.id}`);
} else if (verb === "resume" && rest[0]) {
  await create({ name: `claude ${rest[0].slice(0, 8)}`, cmd: ["claude", "--resume", rest[0], ...rest.slice(1)], cwd: process.cwd() });
} else if (verb === "new") {
  const dash = rest.indexOf("--");
  const flags = dash === -1 ? rest : rest.slice(0, dash);
  const flag = (k: string) => (flags.includes(k) ? flags[flags.indexOf(k) + 1] : undefined);
  await create({ name: flag("--name"), cwd: flag("--cwd") ?? process.cwd(), cmd: dash === -1 ? undefined : rest.slice(dash + 1) });
} else {
  console.log("usage: maxflow ls | maxflow new [--name N] [--cwd DIR] [-- cmd ...] | maxflow resume <claude-session-id> [claude flags]");
  process.exit(1);
}
