import { isRecord } from "./shared/guards";

export const LONG_WINDOW = 1_000_000;
const SHORT_WINDOW = 200_000;
// constraint: transcripts drop the [1m] suffix, and Claude 5 models run 1M windows here (Claude Code auto-compacts them at ~960k)
const LONG_WINDOW_MODEL = /\[1m\]|-(opus|sonnet|haiku|fable|mythos)-5/;

export type Fill = { tokens: number; window: number; model: string; at: number };

const count = (value: unknown) => (typeof value === "number" ? value : 0);

export const windowOf = (model: string, tokens: number) => (LONG_WINDOW_MODEL.test(model) || tokens > SHORT_WINDOW ? LONG_WINDOW : SHORT_WINDOW);

function fillOf(line: string): Fill | undefined {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry["type"] !== "assistant" || entry["isSidechain"] === true || !isRecord(entry["message"])) return undefined;
  const { model, usage } = entry["message"];
  if (typeof model !== "string" || model === "<synthetic>" || !isRecord(usage)) return undefined;
  const tokens = count(usage["input_tokens"]) + count(usage["cache_creation_input_tokens"]) + count(usage["cache_read_input_tokens"]);
  return { tokens, window: windowOf(model, tokens), model, at: Date.parse(typeof entry["timestamp"] === "string" ? entry["timestamp"] : "") };
}

export function lastFill(lines: string[]): Fill | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const fill = fillOf(lines[i] ?? "");
    if (fill) return fill;
  }
  return undefined;
}

export const percent = (f: Pick<Fill, "tokens" | "window">) => Math.round((f.tokens / f.window) * 100);
