import { homedir } from "node:os";
import { sessions } from "./sessions";

const gitRoots = new Map<string, string | null>();
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : Number(a > b));

function gitRootOf(cwd: string): string | null {
  const known = gitRoots.get(cwd);
  if (known !== undefined) return known;
  const root = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stderr: "ignore" }).stdout.toString().trim();
  const found = root === "" ? null : root;
  gitRoots.set(cwd, found);
  return found;
}

export function restrictionRepos() {
  const roots = new Set<string>();
  for (const s of sessions.values()) {
    const root = gitRootOf(s.cwd);
    if (root !== null) roots.add(root);
  }
  return [...roots].toSorted(byCodeUnit).map((path) => ({ path: path.replace(homedir(), "~"), name: path.split("/").at(-1) ?? path }));
}
