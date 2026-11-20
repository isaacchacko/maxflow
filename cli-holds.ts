import { argAt, fail, hasArg, mySession, type Verb } from "./cli-shared";
import { didUnhold, hold, holds, prKeyOf } from "./holds";

function repoHere() {
  const r = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { stderr: "pipe" });
  if (r.exitCode !== 0) fail("a bare PR number needs a GitHub repo checked out here; pass owner/repo#n or the PR's url");
  return r.stdout.toString().trim();
}

function keyOf(ref: string) {
  return prKeyOf(ref, repoHere) ?? fail(`not a PR: ${ref} (pass a url, owner/repo#n, or a number in its repo's checkout)`);
}

function holdPr(args: string[]) {
  const key = keyOf(argAt(args, 0));
  const why = args.slice(1).join(" ");
  const by = mySession();
  hold(key, by === undefined || by === "" ? "isaac" : by, why);
  console.log(`held ${key}: the review and approval sentries leave it alone until \`maxflow unhold ${key}\``);
}

function unholdPr(args: string[]) {
  const key = keyOf(argAt(args, 0));
  console.log(didUnhold(key) ? `unheld ${key}` : `${key} wasn't held`);
}

function listHolds() {
  for (const [key, h] of Object.entries(holds())) console.log(`${key}  since ${new Date(h.at).toLocaleString()}  by ${h.by}${h.why === "" ? "" : `  ${h.why}`}`);
}

export const holdVerbs: Verb[] = [
  { matches: (verb, args) => verb === "hold" && hasArg(args, 0), run: holdPr },
  { matches: (verb, args) => verb === "unhold" && hasArg(args, 0), run: unholdPr },
  { matches: (verb) => verb === "holds", run: listHolds },
];
