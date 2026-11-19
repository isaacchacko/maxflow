import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./instance";
import type { Person } from "./restrictions";
import { shellText } from "./restrictions-shell";
import { ghStatusTable, slackMessagesTable } from "./state";
import { parsePr, repoOf } from "./gh";

// Who a tool call reaches or acts on, for restrictions scoped to people: a Slack DM's other member, each email recipient, a
// Teams chat's members, the author of the PR a gh command reviews or merges, a mallory target. Read from what the sentries
// keep on disk, never a live Slack or GitHub call. team is set only when it is known: true for a dryft.ai address or a PR
// author who is a member or collaborator of its repo or one of Dryft's bots, false for any other address or PR author. A channel post reaches no one
// person, so it has none.
const ME = "U0B33G87YH4";
// mallory's devices: umbrella is his phone, which he reads himself; the others run his own agents, so a message to one reaches no person.
const ISAAC: Person = { name: "Isaac", slack: ME, email: "isaac@dryft.ai", team: true };
const DEVICES = /^(victoria|macbook|cleopatra|wevawie)$/;
const malloryTo = (to: string): Person[] => (to === "umbrella" || to === "all" ? [ISAAC] : DEVICES.test(to) ? [] : [{ name: to }]);
const TEAM_DOMAIN = "dryft.ai";
const SLACK = /^mcp__claude_ai_Slack__slack_(send_message|schedule_message|send_message_draft)$/;
const MAIL = /^mcp__claude_ai_(Gmail__(send_message|reply|forward|create_draft|update_draft)|Microsoft_365__outlook_\w+)$/;
const TEAMS = /^mcp__claude_ai_Microsoft_365__teams_create_chat$/;

const read = (file: string, dir: string) => { try { return JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { return undefined; } };
// A recipient: an address, or a calendar attendee {email, name}; a room booked as a resource is no one.
const email = (a: unknown): Person[] => {
  const o = typeof a === "object" && a ? (a as { email?: string; address?: string; name?: string; type?: string }) : undefined;
  if (o?.type === "resource") return [];
  const e = String(o ? (o.email ?? o.address ?? "") : a).trim().toLowerCase();
  return /@/.test(e) ? [{ email: e, team: e.endsWith(`@${TEAM_DOMAIN}`), ...(o?.name && { name: o.name }) }] : [];
};
const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []);

export function peopleOf(tool: string, input: Record<string, unknown>, cwd: string, dir = STATE_DIR): Person[] {
  if (SLACK.test(tool)) return slackPeople(String(input.channel_id ?? ""), dir);
  if (MAIL.test(tool)) return ["to", "cc", "bcc", "attendees", "toRecipients", "ccRecipients"].flatMap((k) => list(input[k]).flatMap(email));
  if (TEAMS.test(tool)) return list(input.members).flatMap((m) => (/@/.test(String(m)) ? email(m) : [{ name: String(m) }]));
  if (tool === "Bash") return bashPeople(shellText(String(input.command ?? "")), cwd, dir);
  return [];
}

// A user id is a DM to that user; a DM channel's other member is whoever wrote in it that isn't him.
function slackPeople(channel: string, dir: string): Person[] {
  if (/^U/.test(channel)) return channel === ME ? [] : [{ slack: channel }];
  if (!/^D/.test(channel)) return [];
  const msgs: { uid?: string }[] = slackMessagesTable.get(channel)?.msgs ?? [];
  const uid = msgs.find((m) => m.uid && m.uid !== ME)?.uid;
  const name = read("slack-state.json", dir)?.dms?.[channel]?.who;
  return uid || name ? [{ ...(uid && { slack: uid }), ...(name && { name }) }] : [];
}

// Dryft's own bots are teammates: a dryft- login, or any app, since one authors a PR on a Dryft repo only once the org installed it.
const ownBot = (a: { __typename?: string; login: string }) => a.__typename === "Bot" || /^dryft-|\[bot\]$|^app\//i.test(a.login) || undefined;

function bashPeople(command: string, cwd: string, dir: string): Person[] {
  const people: Person[] = [];
  for (const m of command.matchAll(/\bmallory\s+send\b[^;&|\n]*?--to[\s=]+(\S+)/g)) people.push(...malloryTo(m[1].split("/")[0]));
  const status = [...command.matchAll(/\bgh\s+pr\s+(?:review|merge|comment|close|edit|ready)\b([^;&|\n]*)/g), ...command.matchAll(/\bgh\s+api\b[^;&|\n]*?repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)/g)];
  if (!status.length) return people;
  const prs = ghStatusTable.all();
  for (const m of status) {
    let key: string | null;
    if (m[2]) key = `${m[1].toLowerCase()}#${m[2]}`;
    else {
      const args = m[1].trim().split(/\s+/);
      const repo = args.find((_, i) => args[i - 1] === "-R" || args[i - 1] === "--repo")?.toLowerCase();
      const ref = args.find((a) => /^(#?\d+|https:\/\/github\.com\/\S+\/pull\/\d+)$/.test(a));
      // No PR named: gh means the current branch's.
      if (!ref) {
        const branch = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"]).stdout.toString().trim();
        const own = repo ?? repoOf(cwd);
        key = Object.keys(prs).find((k) => k.startsWith(`${own}#`) && prs[k].pr?.headRefName === branch && branch) ?? null;
      } else key = /^#?\d+$/.test(ref) && repo ? `${repo}#${ref.replace("#", "")}` : parsePr(ref, cwd);
    }
    const pr = key && prs[key]?.pr;
    if (pr?.author?.login) people.push({ github: pr.author.login.toLowerCase(), team: ownBot(pr.author) || (pr.authorAssociation ? ["MEMBER", "OWNER", "COLLABORATOR"].includes(pr.authorAssociation) : undefined) });
  }
  return people;
}
