import { sessions } from "./sessions";

const gitRoots = new Map<string, string | null>();
export function restrictionRepos() {
  const roots = new Set<string>();
  for (const s of sessions.values()) {
    if (!gitRoots.has(s.cwd)) gitRoots.set(s.cwd, Bun.spawnSync(["git", "-C", s.cwd, "rev-parse", "--show-toplevel"], { stderr: "ignore" }).stdout.toString().trim() || null);
    const root = gitRoots.get(s.cwd);
    if (root) roots.add(root);
  }
  return [...roots].sort().map((path) => ({ path: path.replace(process.env.HOME!, "~"), name: path.split("/").at(-1)! }));
}
