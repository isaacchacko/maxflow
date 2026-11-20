import { BASE } from "../instance";
import { loadRestrictions, resolve, type Restriction } from "../restrictions";
import { isRecord } from "../shared/guards";

export type Ci = "green" | "pending" | "failing" | "unknown";
export type Approval = { decision: "allow" | "deny"; reason?: string };

const ENFORCE_TIMEOUT_MS = 30_000;
const PASSING = new Set(["pass", "skipping"]);
const FAILING = new Set(["fail", "cancel"]);
const NO_CHECKS = /no (required )?checks reported/i;

const repoAndNumber = (pr: string) => {
  const [repo = "", n = ""] = pr.split("#", 2);
  return { repo, n };
};

export function ciFrom(buckets: string[]): Ci {
  if (buckets.some((b) => FAILING.has(b))) return "failing";
  return buckets.every((b) => PASSING.has(b)) ? "green" : "pending";
}

export function requiredCi(pr: string): Ci {
  const { repo, n } = repoAndNumber(pr);
  const r = Bun.spawnSync(["gh", "pr", "checks", n, "-R", repo, "--required", "--json", "bucket"], { stderr: "pipe" });
  if (NO_CHECKS.test(r.stderr.toString())) return "green";
  if (r.stdout.toString().trim() === "") return "unknown";
  const parsed: unknown = JSON.parse(r.stdout.toString());
  return Array.isArray(parsed) ? ciFrom(parsed.map((c) => (isRecord(c) ? String(c["bucket"]) : ""))) : "unknown";
}

export const approveCommand = (pr: string) => {
  const { repo, n } = repoAndNumber(pr);
  return `gh pr review ${n} -R ${repo} --approve`;
};

export function mergeHoldWhy(pr: string, list: Restriction[] = loadRestrictions()): string | undefined {
  const { repo, n } = repoAndNumber(pr);
  const { mode, restriction } = resolve(list, { tool: "Bash", input: { command: `gh pr merge ${n} -R ${repo}` } });
  return mode === "allow" ? undefined : `"${restriction?.label ?? "pr-merge"}" is set to ${mode}, so Liudvikas isn't asked to approve it for you; run b yourself once you've looked`;
}

// constraint: the b endpoint approves outside any agent tool call, so the restrictions hook never sees it
export async function mayApprove(pr: string, list: Restriction[] = loadRestrictions()): Promise<Approval> {
  const { mode, restriction } = resolve(list, { tool: "Bash", input: { command: approveCommand(pr) } });
  if (mode === "allow") return { decision: "allow" };
  if (mode === "deny") return { decision: "deny", reason: `"${restriction?.label ?? "pr-approve"}" is set to deny` };
  const session = process.env["MAXFLOW_SESSION"] ?? "";
  if (session === "") return { decision: "deny", reason: "no MAXFLOW_SESSION to ask the restrictions as" };
  try {
    const res = await fetch(`${BASE}/api/restrictions/enforce`, {
      method: "POST", headers: { "x-maxflow-from": session },
      body: JSON.stringify({ tool: "Bash", input: { command: approveCommand(pr) } }),
      signal: AbortSignal.timeout(ENFORCE_TIMEOUT_MS),
    });
    const verdict: unknown = await res.json();
    if (isRecord(verdict) && verdict["decision"] === "allow") return { decision: "allow" };
    return { decision: "deny", reason: isRecord(verdict) ? String(verdict["reason"]) : "no verdict" };
  } catch (error) {
    return { decision: "deny", reason: `restrictions unreachable: ${String(error)}` };
  }
}
