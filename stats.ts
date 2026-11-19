import { DEFAULT_REPO, gh, reposByRecentWork, trend } from "./stats-github";
import { addDays, mondayToSundayWeek } from "./stats-week";
import { yarn } from "./stats-yarn";

export { agents } from "./stats-agents";
export { calendar } from "./stats-github";
export { health } from "./stats-health";

const SEARCHABLE_REPO = /^[\w.-]+\/[\w.-]+$/;

export async function stats(key?: string, repo?: string) {
  const w = mondayToSundayWeek(key);
  const prev = mondayToSundayWeek(addDays(w.key, -7));
  const r = repo !== undefined && SEARCHABLE_REPO.test(repo) ? repo : DEFAULT_REPO;
  const [now, before, list] = await Promise.all([gh(r, w), gh(r, prev), reposByRecentWork()]);
  return { week: w, gh: { repo: r, repos: list.includes(r) ? list : [...list, r], now, before, trend: trend(r, w) }, yarn: yarn(w), yarnBefore: yarn(prev) };
}
