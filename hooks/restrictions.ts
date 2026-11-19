#!/usr/bin/env bun
import { type Person, type Restriction, doesMatch, loadRestrictions, resolve } from "../restrictions";

type HookInput = { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
type Verdict = { decision: string; reason?: string };

const session = process.env["MAXFLOW_SESSION"];
if (session === undefined || session === "") process.exit(0);

function hookInput(value: unknown): HookInput {
  return typeof value === "object" && value !== null ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "object" && value !== null && "decision" in value && typeof value.decision === "string";
}

function loadOrNone(): Restriction[] {
  try {
    return loadRestrictions();
  } catch {
    return [];
  }
}

async function loadPeopleOf() {
  try {
    return (await import("../restrictions-people")).peopleOf;
  } catch {
    return null;
  }
}

async function askServerToEnforce(body: { session: string }) {
  try {
    return await fetch(`http://localhost:${process.env["MAXFLOW_PORT"] ?? 4949}/api/restrictions/enforce`, {
      method: "POST",
      headers: { "x-maxflow-from": body.session },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return null;
  }
}

const input = hookInput(JSON.parse(await Bun.stdin.text()));
const call = {
  session,
  tool: typeof input.tool_name === "string" ? input.tool_name : "",
  input: isRecord(input.tool_input) ? input.tool_input : {},
  cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
};

const list = loadOrNone();
const areOnlyAllowRestrictionsMatched = list.every((r) => r.mode === "allow" || !doesMatch(r, call, list));
if (areOnlyAllowRestrictionsMatched) process.exit(0);
const peopleOf = await loadPeopleOf();
const peopleReached: Person[] = peopleOf ? peopleOf(call.tool, call.input, call.cwd) : [];
const callWithPeople = { ...call, people: peopleReached };

function blocksOnlyWithServerDown(): Verdict {
  const { mode, restriction } = resolve(list, callWithPeople);
  return mode === "deny" ? { decision: "deny", reason: `Blocked by a yarn restriction (${String(restriction?.label)}), which Isaac set to block.` } : { decision: "allow" };
}

async function verdictOf(res: Response | null): Promise<Verdict> {
  if (res?.ok !== true) return blocksOnlyWithServerDown();
  const body: unknown = await res.json();
  return isVerdict(body) ? body : { decision: "allow" };
}

const verdict = await verdictOf(await askServerToEnforce(callWithPeople));
if (verdict.decision === "deny")
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } }));
