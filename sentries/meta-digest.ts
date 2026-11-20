import { isRecord, stringOr } from "../shared/guards";
import { parseEntry, type TranscriptEntry } from "./transcript-read";

export const SLOW_TURN_MS = Number(process.env["META_SLOW_TURN_MS"] ?? 10 * 60_000);
export const SLOW_TOOL_MS = Number(process.env["META_SLOW_TOOL_MS"] ?? 5 * 60_000);
export const SLOW_MODEL_MS = Number(process.env["META_SLOW_MODEL_MS"] ?? 3 * 60_000);
export const REPEATS = Number(process.env["META_REPEATS"] ?? 4);
const SHORT_CHARS = 400;
const SHORT_HEAD = 220;
const SHORT_TAIL = 160;

type Open = { name: string; what: string; at: number };
export type Mark = { offset: number; tools: Record<string, Open>; turnAt?: number; askedAt?: number; idleAt?: number; blockedAt?: number };
export type Digest = {
  id: string;
  title: string;
  turns: number[];
  toolCalls: number;
  toolMs: number;
  modelMs: number;
  openTurnMs?: number;
  slowTools: { tool: string; what: string; ms: number; running?: boolean }[];
  slowReplies: number[];
  waitingOnModelMs?: number;
  repeated: { what: string; times: number }[];
};

function shortHeadAndTailSinceChainsHideTheHeavyPartAtTheEnd(input: unknown) {
  const fields = isRecord(input) ? input : {};
  const named = fields["command"] ?? fields["description"] ?? fields["file_path"] ?? fields["pattern"] ?? fields["url"];
  const text = (typeof named === "string" ? named : JSON.stringify(input ?? "")).replaceAll(/\s+/g, " ");
  return text.length <= SHORT_CHARS ? text : `${text.slice(0, SHORT_HEAD)} … ${text.slice(-SHORT_TAIL)}`;
}

const isDeclaredWaitRepeatedByDesign = (what: string) => /(?:cli\.ts|\$\{?(?:YARN|MAXFLOW)_CLI\}?|\b(?:yarn|maxflow))["']? wait ["']?([a-z]+:\S+|done)\b/.test(what);
const contentOf = (e: TranscriptEntry) => (isRecord(e["message"]) ? e["message"]["content"] : undefined);
const blocksOf = (content: unknown) => (Array.isArray(content) ? content.filter(isRecord) : []);
const isTurnEnd = (e: TranscriptEntry) => e["type"] === "system" && (e["subtype"] === "stop_hook_summary" || e["subtype"] === "turn_duration");

export class TranscriptWindow {
  private readonly digest: Digest;
  private readonly tools: Map<string, Open>;
  private readonly counts = new Map<string, number>();
  private turnAt: number | undefined;
  private askedAt: number | undefined;

  constructor(
    id: string,
    title: string,
    private readonly mark: Mark,
    private readonly since: number,
  ) {
    this.digest = { id, title, turns: [], toolCalls: 0, toolMs: 0, modelMs: 0, slowTools: [], slowReplies: [], repeated: [] };
    this.tools = new Map(Object.entries(mark.tools));
    this.turnAt = mark.turnAt;
    this.askedAt = mark.askedAt;
  }

  private onEntry(e: TranscriptEntry, at: number) {
    const isRecent = at >= this.since;
    if (isTurnEnd(e)) {
      if (isRecent && this.turnAt !== undefined) this.digest.turns.push(at - this.turnAt);
      this.turnAt = undefined;
    } else if (e["type"] === "api-request" && e["querySource"] === "repl_main_thread") {
      this.askedAt = at;
    } else if (e["type"] === "assistant" && e["isSidechain"] !== true) {
      this.onModelReply(e, at, isRecent);
    } else if (e["type"] === "user" && e["isSidechain"] !== true) {
      this.onUserOrToolResult(e, at, isRecent);
    }
  }

  private onModelReply(e: TranscriptEntry, at: number, isRecent: boolean) {
    if (isRecent && this.askedAt !== undefined) {
      this.digest.modelMs += at - this.askedAt;
      if (at - this.askedAt >= SLOW_MODEL_MS) this.digest.slowReplies.push(at - this.askedAt);
    }
    this.askedAt = undefined;
    const toolCalls = blocksOf(contentOf(e)).filter((block) => block["type"] === "tool_use");
    for (const c of toolCalls) {
      const what = shortHeadAndTailSinceChainsHideTheHeavyPartAtTheEnd(c["input"]);
      const name = stringOr(c["name"]);
      this.tools.set(stringOr(c["id"]), { name, what, at });
      if (isRecent && !isDeclaredWaitRepeatedByDesign(what)) this.counts.set(`${name}: ${what}`, (this.counts.get(`${name}: ${what}`) ?? 0) + 1);
    }
  }

  private onUserOrToolResult(e: TranscriptEntry, at: number, isRecent: boolean) {
    const content = contentOf(e);
    const isTyped = typeof content === "string" || blocksOf(content).some((c) => c["type"] === "text");
    if (isTyped && e["isMeta"] !== true) this.turnAt = at;
    const toolResults = blocksOf(content).filter((block) => block["type"] === "tool_result");
    for (const c of toolResults) {
      const id = stringOr(c["tool_use_id"]);
      const t = this.tools.get(id);
      if (t === undefined) continue;
      this.tools.delete(id);
      if (isRecent) {
        this.digest.toolCalls += 1;
        this.digest.toolMs += at - t.at;
      }
      if (isRecent && at - t.at >= SLOW_TOOL_MS) this.digest.slowTools.push({ tool: t.name, what: t.what, ms: at - t.at });
    }
  }

  read(lines: string[]) {
    for (const line of lines) {
      const e = parseEntry(line);
      const at = Date.parse(stringOr(e?.["timestamp"]));
      if (e !== undefined && at !== 0 && !Number.isNaN(at)) this.onEntry(e, at);
    }
  }

  finish(isWorking: boolean, now: number): { digest: Digest; mark: Mark } {
    if (!isWorking) {
      this.tools.clear();
      this.turnAt = undefined;
      this.askedAt = undefined;
    }
    for (const t of this.tools.values()) if (now - t.at >= SLOW_TOOL_MS) this.digest.slowTools.push({ tool: t.name, what: t.what, ms: now - t.at, running: true });
    if ((this.turnAt ?? 0) !== 0) this.digest.openTurnMs = now - (this.turnAt ?? 0);
    if ((this.askedAt ?? 0) !== 0) this.digest.waitingOnModelMs = now - (this.askedAt ?? 0);
    this.digest.repeated = [...this.counts].filter(([, n]) => n >= REPEATS).map(([what, times]) => ({ what, times }));
    const { turnAt: _turnAt, askedAt: _askedAt, ...rest } = this.mark;
    const mark: Mark = {
      ...rest,
      tools: Object.fromEntries(this.tools),
      ...(this.turnAt !== undefined && { turnAt: this.turnAt }),
      ...(this.askedAt !== undefined && { askedAt: this.askedAt }),
    };
    return { digest: this.digest, mark };
  }
}

export const isSlow = (d: Digest) =>
  d.turns.some((ms) => ms >= SLOW_TURN_MS) ||
  (d.openTurnMs ?? 0) >= SLOW_TURN_MS ||
  d.slowTools.length > 0 ||
  d.slowReplies.length > 0 ||
  (d.waitingOnModelMs ?? 0) >= SLOW_MODEL_MS ||
  d.repeated.length > 0;
