import type { Person } from "./restrictions";
import { shellText } from "./restrictions-shell";
import { isRecord, stringOr } from "./shared/guards";
import { ghStatusTable, peekStateJson, slackMessagesTable } from "./state";
import { parsePr, repoOf } from "./gh";

const ME = "U0B33G87YH4";
const ISAAC: Person = { name: "Isaac", slack: ME, email: "isaac@dryft.ai", team: true };
const DEVICES_RUNNING_HIS_OWN_AGENTS = /^(victoria|macbook|cleopatra|wevawie)$/;
const HIS_PHONE_OR_EVERY_DEVICE = new Set(["umbrella", "all"]);
const TEAM_DOMAIN = "dryft.ai";
const SLACK = /^mcp__claude_ai_Slack__slack_(send_message|schedule_message|send_message_draft)$/;
const MAIL = /^mcp__claude_ai_(Gmail__(send_message|reply|forward|create_draft|update_draft)|Microsoft_365__outlook_\w+)$/;
const TEAMS = /^mcp__claude_ai_Microsoft_365__teams_create_chat$/;
const MAIL_RECIPIENT_FIELDS = ["to", "cc", "bcc", "attendees", "toRecipients", "ccRecipients"];
const MALLORY_SEND = /\bmallory\s+send\b[^;&|\n]*?--to[\s=]+(\S+)/g;
const GH_PR_ON_A_PR = /\bgh\s+pr\s+(?:review|merge|comment|close|edit|ready)\b([^;&|\n]*)/g;
const GH_API_ON_A_PR = /\bgh\s+api\b[^;&|\n]*?repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)/g;
const PR_REF = /^(#?\d+|https:\/\/github\.com\/\S+\/pull\/\d+)$/;
const OWN_BOT_LOGIN = /^dryft-|\[bot\]$|^app\//i;
const TEAM_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"]);

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

function malloryTo(to: string): Person[] {
  if (HIS_PHONE_OR_EVERY_DEVICE.has(to)) return [ISAAC];
  return DEVICES_RUNNING_HIS_OWN_AGENTS.test(to) ? [] : [{ name: to }];
}

const fieldOf = (o: object, key: string): unknown => Reflect.get(o, key);

function recipientPeople(recipient: unknown): Person[] {
  const attendee = typeof recipient === "object" && recipient !== null ? recipient : undefined;
  if (attendee !== undefined && fieldOf(attendee, "type") === "resource") return [];
  const address = attendee === undefined ? recipient : (fieldOf(attendee, "email") ?? fieldOf(attendee, "address") ?? "");
  const email = stringOr(address).trim().toLowerCase();
  if (!email.includes("@")) return [];
  const name = attendee === undefined ? undefined : fieldOf(attendee, "name");
  return [{ email, team: email.endsWith(`@${TEAM_DOMAIN}`), ...(typeof name === "string" && name !== "" && { name }) }];
}

const isFalsy = (value: unknown) => value === undefined || value === null || value === false || value === 0 || value === "" || Number.isNaN(value);

const listOf = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  return isFalsy(value) ? [] : [value];
};

const teamsMember = (member: unknown): Person[] => {
  const text = stringOr(member);
  return text.includes("@") ? recipientPeople(member) : [{ name: text }];
};

export function peopleOf(tool: string, input: Record<string, unknown>, cwd: string): Person[] {
  if (SLACK.test(tool)) return slackPeople(stringOr(input["channel_id"]));
  if (MAIL.test(tool)) return MAIL_RECIPIENT_FIELDS.flatMap((k) => listOf(input[k]).flatMap((r) => recipientPeople(r)));
  if (TEAMS.test(tool)) return listOf(input["members"]).flatMap((m) => teamsMember(m));
  if (tool === "Bash") return bashPeople(shellText(stringOr(input["command"])), cwd);
  return [];
}

function dmPartnerName(channel: string): string | undefined {
  const state = peekStateJson("slack-state.json");
  const dms = isRecord(state) ? state["dms"] : undefined;
  const dm = isRecord(dms) ? dms[channel] : undefined;
  const who = isRecord(dm) ? dm["who"] : undefined;
  return typeof who === "string" ? who : undefined;
}

function slackPeople(channel: string): Person[] {
  if (channel.startsWith("U")) return channel === ME ? [] : [{ slack: channel }];
  if (!channel.startsWith("D")) return [];
  const msgs = slackMessagesTable.get(channel)?.msgs ?? [];
  const uid = msgs.find((m) => isSet(m.uid) && m.uid !== ME)?.uid;
  const name = dmPartnerName(channel);
  if (!isSet(uid) && !isSet(name)) return [];
  return [{ ...(isSet(uid) && { slack: uid }), ...(isSet(name) && { name }) }];
}

type PrSeen = { headRefName: string | undefined; login: string | undefined; authorType: unknown; association: string | undefined };
const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

function prSeen(entry: unknown): PrSeen | undefined {
  const pr = isRecord(entry) ? entry["pr"] : undefined;
  if (!isRecord(pr)) return;
  const author = isRecord(pr["author"]) ? pr["author"] : {};
  return { headRefName: optionalString(pr["headRefName"]), login: optionalString(author["login"]), authorType: author["__typename"], association: optionalString(pr["authorAssociation"]) };
}

function malloryPeople(command: string): Person[] {
  return command.matchAll(MALLORY_SEND).flatMap((m) => malloryTo((m[1] ?? "").split("/", 1)[0] ?? "")).toArray();
}

function currentBranchPrKey(repo: string | undefined, cwd: string, prs: Record<string, unknown>): string | null {
  const branch = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"]).stdout.toString().trim();
  const own = repo ?? repoOf(cwd);
  return Object.keys(prs).find((k) => branch !== "" && k.startsWith(`${own}#`) && prSeen(prs[k])?.headRefName === branch) ?? null;
}

function ghPrKey(args: string[], cwd: string, prs: Record<string, unknown>): string | null {
  const repo = args.find((_, i) => args[i - 1] === "-R" || args[i - 1] === "--repo")?.toLowerCase();
  const ref = args.find((a) => PR_REF.test(a));
  if (ref === undefined) return currentBranchPrKey(repo, cwd, prs);
  return isSet(repo) && /^#?\d+$/.test(ref) ? `${repo}#${ref.replace("#", "")}` : parsePr(ref, cwd);
}

function prKeyOf(match: RegExpExecArray, cwd: string, prs: Record<string, unknown>): string | null {
  const [, repoOrArgs = "", number] = match;
  if (isSet(number)) return `${repoOrArgs.toLowerCase()}#${number}`;
  return ghPrKey(repoOrArgs.trim().split(/\s+/), cwd, prs);
}

const isOwnBot = (pr: PrSeen, login: string) => pr.authorType === "Bot" || OWN_BOT_LOGIN.test(login);

function isTeammateAuthor(pr: PrSeen, login: string): boolean | undefined {
  if (isOwnBot(pr, login)) return true;
  return isSet(pr.association) ? TEAM_ASSOCIATIONS.has(pr.association) : undefined;
}

function prAuthor(pr: PrSeen | undefined): Person[] {
  const login = pr?.login;
  if (pr === undefined || !isSet(login)) return [];
  const isTeammate = isTeammateAuthor(pr, login);
  return [{ github: login.toLowerCase(), ...(isTeammate !== undefined && { team: isTeammate }) }];
}

function bashPeople(command: string, cwd: string): Person[] {
  const people = malloryPeople(command);
  const onPrs = [...command.matchAll(GH_PR_ON_A_PR), ...command.matchAll(GH_API_ON_A_PR)];
  if (onPrs.length === 0) return people;
  const prs: Record<string, unknown> = ghStatusTable.all();
  for (const match of onPrs) {
    const key = prKeyOf(match, cwd, prs);
    people.push(...prAuthor(key === null || key === "" ? undefined : prSeen(prs[key])));
  }
  return people;
}
