import { readRateHistory } from "./gh";
import { DIR } from "./instance";
import { busLog, type BusEvent } from "./stats-sources";
import { DAY_MS, dayKey, lastDays } from "./stats-week";

export type SessionInfo = { id: string; name: string; createdAt: number; running?: boolean; status?: string; archived?: boolean; asleep?: boolean; sentry?: boolean; agent?: boolean; role?: { role: string; objective: string } };

const HEALTH_DAYS = 14;
const REFLOG_UNIX_TIME = /\{(\d+)\}/;

function perDayOf(events: BusEvent[], days: string[], isCounted: (topic: string) => boolean) {
  const counts = new Map<string, number>();
  for (const e of events) if (isCounted(e.topic)) counts.set(dayKey(e.at), (counts.get(dayKey(e.at)) ?? 0) + 1);
  return days.map((d) => counts.get(d) ?? 0);
}

function liveCheckoutFastForwards(since: number) {
  const reflog = Bun.spawnSync(["git", "-C", DIR, "reflog", "--date=unix", "--format=%gd%x09%H%x09%gs", "-n", "300"], { stderr: "pipe" }).stdout.toString();
  const deploys = reflog
    .split("\n")
    .filter((l) => l.includes("Fast-forward"))
    .map((l) => {
      const [ref = "", sha = ""] = l.split("\t", 2);
      return { at: Number(REFLOG_UNIX_TIME.exec(ref)?.[1]) * 1000, sha: sha.slice(0, 7) };
    })
    .filter((d) => d.at > since);
  const subjects = deploys.length > 0 ? Bun.spawnSync(["git", "-C", DIR, "show", "-s", "--format=%h%x09%s", ...deploys.map((d) => d.sha)], { stderr: "pipe" }).stdout.toString() : "";
  const subject = new Map(subjects.split("\n").map((l) => [l.slice(0, 7), l.slice(8)]));
  return deploys.map((d) => ({ ...d, subject: subject.get(d.sha) ?? "" }));
}

function sentryRespawns(events: BusEvent[], since: number) {
  const respawns = new Map<string, number>();
  for (const e of events) {
    const name = String(e.data["name"]);
    if (e.topic === "sentry/start" && e.data["why"] === "respawn" && e.at > since) respawns.set(name, (respawns.get(name) ?? 0) + 1);
  }
  return respawns;
}

function sessionStates(sessions: SessionInfo[]) {
  const agents = sessions.filter((s) => s.agent === true && s.sentry !== true);
  return {
    total: sessions.length,
    working: agents.filter((s) => s.status === "working").length,
    idle: agents.filter((s) => s.running === true && s.archived !== true && s.status !== "working").length,
    asleep: agents.filter((s) => s.archived === true || s.asleep === true).length,
    shells: sessions.filter((s) => s.agent !== true && s.sentry !== true).length,
  };
}

export function health(sessions: SessionInfo[]) {
  const { events, perDay, since } = busLog();
  const daysTheLogCovers = lastDays(HEALTH_DAYS).filter((d) => d >= dayKey(since));
  const starts = events.filter((e) => e.topic === "server/start").map((e) => e.at);
  const respawns = sentryRespawns(events, Date.now() - 7 * DAY_MS);
  return {
    days: daysTheLogCovers,
    server: { upSince: Date.now() - process.uptime() * 1000, rssMb: Math.round(process.memoryUsage().rss / 1e6), starts: starts.filter((at) => at > Date.now() - HEALTH_DAYS * DAY_MS), logSince: starts[0] },
    deploys: liveCheckoutFastForwards(Date.now() - HEALTH_DAYS * DAY_MS),
    sentries: sessions
      .filter((s) => s.sentry === true)
      .map((s) => ({ name: s.name, running: s.running === true, upSince: s.createdAt, respawns: respawns.get(s.name) ?? 0 }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    sessions: sessionStates(sessions),
    events: daysTheLogCovers.map((d) => perDay.get(d) ?? 0),
    ramKills: perDayOf(events, daysTheLogCovers, (t) => t.startsWith("ram/killed")),
    resyncs: perDayOf(events, daysTheLogCovers, (t) => t.startsWith("claude-resync/")),
    sleptWithWorkOpen: perDayOf(events, daysTheLogCovers, (t) => t.startsWith("health/agent/")),
    github: readRateHistory(),
  };
}
