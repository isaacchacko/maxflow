#!/usr/bin/env bun
import { agentBoardUrl, AGENT_BOARD_CONFIG } from "../agent-board-config";
import { isRecord } from "../shared/guards";
import { readStateJson, stateDisplayPath, writeStateJson } from "../state";
import { dig, log, post, stringField } from "./inbox-board";
import { takeOver } from "./singleton";

const STATE_FILE = "agent-board-cursor.json";
const CHANNELS = "yarn/";
const WAIT_S = 25;
const FETCH_MS = (WAIT_S + 10) * 1000;
const NO_CONFIG_MS = 60_000;
const RETRY_MS = 500;
const FIRST_BACKOFF_MS = 2000;
const LONGEST_BACKOFF_MS = 60_000;

type Cursor = { cursor: string };
const isCursor = (value: unknown): value is Cursor => isRecord(value) && typeof value["cursor"] === "string";
const state: Cursor = readStateJson(STATE_FILE, isCursor) ?? { cursor: "" };

async function boardGet(url: string, query: string): Promise<{ events: unknown[]; cursor: string }> {
  const res = await fetch(`${url}/events?channel=${encodeURIComponent(CHANNELS)}&${query}`, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`board answered ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
  const body: unknown = await res.json();
  const events = isRecord(body) && Array.isArray(body["events"]) ? body["events"] : [];
  const cursor = isRecord(body) ? stringField(body, "cursor") : undefined;
  return { events, cursor: cursor ?? state.cursor };
}

const deviceOf = (principal: unknown) => (typeof principal === "string" ? (/user:([^@]+)@/.exec(principal)?.[1] ?? principal) : "?");

function postOf(event: unknown) {
  if (!isRecord(event) || event["type"] !== "message.posted" || dig(event, ["message", "deleted"]) === true) return;
  const [id, channel, text, re, handle] = [dig(event, ["message", "id"]), dig(event, ["payload", "channel"]), dig(event, ["payload", "text"]), dig(event, ["payload", "re"]), dig(event, ["actor", "handle"])];
  if (typeof id !== "string" || typeof channel !== "string" || typeof text !== "string") return;
  return { id, channel, text, handle: typeof handle === "string" ? handle : "?", device: deviceOf(dig(event, ["payload", "by", "principal"])), ...(typeof re === "string" && { re }) };
}

async function handOver(event: unknown) {
  const p = postOf(event);
  if (!p) return;
  for (;;) {
    const res = await post("/api/board-bus/deliver", p);
    if (!res.ok) throw new Error(`handing ${p.id} over failed: ${String(res.status)} ${await res.text()}`);
    const outcome = dig(await res.json(), ["outcome"]);
    if (outcome !== "retry") {
      log(`board #${p.id} in ${p.channel} from ${p.handle}: ${String(outcome)}`);
      return;
    }
    await Bun.sleep(RETRY_MS);
  }
}

function moveTo(cursor: string | undefined) {
  if (cursor === undefined || cursor === state.cursor) return;
  state.cursor = cursor;
  writeStateJson(STATE_FILE, state);
}

async function followFrom(url: string) {
  if (state.cursor === "") {
    state.cursor = (await boardGet(url, "last=1")).cursor;
    writeStateJson(STATE_FILE, state);
    log(`following ${url} (${CHANNELS}) from now, after ${state.cursor}`);
  }
  const { events, cursor } = await boardGet(url, `after=${encodeURIComponent(state.cursor)}&wait=${String(WAIT_S)}`);
  for (const event of events) {
    await handOver(event);
    moveTo(isRecord(event) ? stringField(event, "cursor") : undefined);
  }
  moveTo(cursor);
}

async function run() {
  let backoff = FIRST_BACKOFF_MS;
  let hasSaidNoConfig = false;
  for (;;) {
    const url = agentBoardUrl();
    if (url === undefined) {
      if (!hasSaidNoConfig) log(`no agent board configured: write ${stateDisplayPath(AGENT_BOARD_CONFIG)} ({"url": "http://127.0.0.1:4100/api/board"}) and it starts`);
      hasSaidNoConfig = true;
      await Bun.sleep(NO_CONFIG_MS);
      continue;
    }
    hasSaidNoConfig = false;
    try {
      await followFrom(url);
      backoff = FIRST_BACKOFF_MS;
    } catch (error) {
      log(`board-bus: ${String(error)}; trying again in ${String(backoff / 1000)}s (the server delivers directly meanwhile)`);
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, LONGEST_BACKOFF_MS);
    }
  }
}

if (import.meta.main) {
  takeOver("board-bus");
  await run();
}
