import { sessions } from "./sessions";
import { judged, prStates } from "./world-session";
import { isRecord } from "./shared/guards";

const PR_STATES_REFRESH_MS = 30_000;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

type ShownPr = { url: string; number: string };

function parsedAnswer(out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

function prStateIn(answer: unknown, alias: string): string | undefined {
  if (!isRecord(answer) || !isRecord(answer["data"]) || !isRecord(answer["data"]["r"])) return undefined;
  const pr = answer["data"]["r"][alias];
  return isRecord(pr) && typeof pr["state"] === "string" ? pr["state"] : undefined;
}

function notFoundPathsIn(answer: unknown): Set<string> {
  const errors: unknown[] = isRecord(answer) && Array.isArray(answer["errors"]) ? answer["errors"] : [];
  const paths: unknown[] = errors.filter(isRecord).filter((e) => e["type"] === "NOT_FOUND").map((e) => e["path"]);
  return new Set(paths.filter((path) => Array.isArray(path)).map((path) => path.join(".")));
}

function shownPrsByRepo(): Map<string, ShownPr[]> {
  const shown = new Set(sessions.values().flatMap((s) => judged(s)));
  const byRepo = new Map<string, ShownPr[]>();
  for (const url of shown) {
    const [, repo, number] = PR_URL.exec(url) ?? [];
    if (repo === undefined || number === undefined) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), { url, number }]);
  }
  return byRepo;
}

async function askGithubForStates(repo: string, prs: ShownPr[]): Promise<unknown> {
  const [owner = "", name = ""] = repo.split("/", 2);
  const q = `query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs.map((pr) => `p${pr.number}: pullRequest(number: ${pr.number}) { state }`).join(" ")} } }`;
  const gh = Bun.spawn(["gh", "api", "graphql", "-f", `query=${q}`], { stdout: "pipe", stderr: "ignore" });
  return parsedAnswer(await new Response(gh.stdout).text());
}

async function refreshPrStates() {
  for (const [repo, prs] of shownPrsByRepo()) {
    const answer = await askGithubForStates(repo, prs);
    const notFound = notFoundPathsIn(answer);
    for (const pr of prs) {
      const state = prStateIn(answer, `p${pr.number}`);
      if (state !== undefined) prStates.set(pr.url, state.toLowerCase());
      else if (notFound.has("r") || notFound.has(`r.p${pr.number}`)) prStates.set(pr.url, "missing");
    }
  }
}

async function refreshPrStatesKeepingThemOnFailure() {
  try {
    await refreshPrStates();
  } catch {
    // constraint: a gh or network failure leaves every shown PR's state as it was
  }
}

export function keepPrStatesFresh() {
  setInterval(() => {
    void refreshPrStatesKeepingThemOnFailure();
  }, PR_STATES_REFRESH_MS);
}
