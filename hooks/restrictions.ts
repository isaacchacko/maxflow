#!/usr/bin/env bun
// Claude Code hook: PreToolUse for every tool, enforcing the restrictions Isaac sets on the Restrictions page. A call that no
// asking or blocking restriction matches passes without a word to the server; one that does goes to the server, which knows
// the session's objective and holds the asks and the one-time passes. With the server down it fails open, keeping only blocks.
import { loadRestrictions, matches, resolve } from "../restrictions";

if (!process.env.MAXFLOW_SESSION) process.exit(0);
const input = JSON.parse(await Bun.stdin.text());
const call = { session: process.env.MAXFLOW_SESSION, tool: String(input.tool_name ?? ""), input: input.tool_input ?? {}, cwd: String(input.cwd ?? process.cwd()) };

const list = (() => { try { return loadRestrictions(); } catch { return []; } })();
// Whatever the scope, a call that only allow restrictions match is allowed.
if (!list.some((r) => r.mode !== "allow" && matches(r, call, list))) process.exit(0);
// Who it reaches, for restrictions scoped to people.
const people = await import("../restrictions-people").then((m) => m.peopleOf(call.tool, call.input, call.cwd), () => []);
Object.assign(call, { people });

const res = await fetch(`http://localhost:${process.env.MAXFLOW_PORT ?? 4949}/api/restrictions/enforce`, {
  method: "POST",
  headers: { "x-maxflow-from": call.session },
  body: JSON.stringify(call),
  signal: AbortSignal.timeout(3_000),
}).catch(() => null);
const verdict: { decision: string; reason?: string } = res?.ok
  ? await res.json()
  : resolve(list, call).mode === "deny"
    ? { decision: "deny", reason: `Blocked by a maxflow restriction (${resolve(list, call).restriction?.label}), which Isaac set to block.` }
    : { decision: "allow" };
if (verdict.decision === "deny")
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } }));
