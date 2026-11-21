import type { ServerWebSocket, Subprocess } from "bun";
import { TMUX, termEnv, tmuxName } from "./tmux";
import { type Session, type WsData, sessions } from "./sessions";
import { latestBuild, openWorld, worldClients } from "./world";
import { closeViewer, openViewer, viewerAsked } from "./browser-screencast";
import { patch } from "./patch";
import { recordIsaacTyped } from "./isaac-words";
import { isRecord } from "./shared/guards";

type Ws = ServerWebSocket<WsData>;
type TerminalInput = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

const ESC = "\u{1B}";
const WS_OPEN = 1;
const VIEWER_COLS = 120;
const VIEWER_ROWS = 34;
const TAB_THAT_MISSED_A_PATCH_ASKS = "full";

const isTerminalInput = (value: unknown): value is TerminalInput =>
  isRecord(value) &&
  ((value["type"] === "input" && typeof value["data"] === "string") || (value["type"] === "resize" && typeof value["cols"] === "number" && typeof value["rows"] === "number"));

async function sayWhenTheSessionEnds(ws: Ws, pty: Subprocess) {
  await pty.exited;
  if (ws.readyState !== WS_OPEN) return;
  ws.sendBinary(new TextEncoder().encode(`\r\n${ESC}[2m[session ended]${ESC}[0m\r\n`));
}

function attachTerminal(ws: Ws, s: Session) {
  s.clients.add(ws);
  ws.sendText("replayed");
  if (s.exitCode !== null) {
    for (const chunk of s.chunks) ws.sendBinary(chunk);
    return;
  }
  const pty = Bun.spawn([...TMUX, "attach-session", "-t", tmuxName(s.id)], {
    env: termEnv,
    terminal: { cols: VIEWER_COLS, rows: VIEWER_ROWS, data: (_term, data) => ws.sendBinary(new Uint8Array(data)) },
  });
  patch(ws.data, { pty });
  void sayWhenTheSessionEnds(ws, pty);
}

function sendWholeWorld(ws: Ws) {
  const built = latestBuild();
  if (built) ws.sendText(JSON.stringify({ type: "world", v: built.v, world: built.w }));
}

function typeIntoTerminal(ws: Ws, pty: Subprocess, raw: string) {
  const input: unknown = JSON.parse(raw);
  if (!isTerminalInput(input)) return;
  if (input.type !== "input") {
    if (input.cols > 0 && input.rows > 0) pty.terminal?.resize(input.cols, input.rows);
    return;
  }
  if (ws.data.isIsaac !== true) return;
  recordIsaacTyped(ws.data.id, input.data);
  pty.terminal?.write(input.data);
}

export const websocketHandlers = {
  open(ws: Ws) {
    if (ws.data.world) {
      void openWorld(ws);
      return;
    }
    if (ws.data.browser) {
      void openViewer(ws);
      return;
    }
    const s = sessions.get(ws.data.id);
    if (s) attachTerminal(ws, s);
  },
  message(ws: Ws, raw: string | Buffer) {
    const text = String(raw);
    if (ws.data.browser) {
      void viewerAsked(ws, text);
      return;
    }
    if (ws.data.world) {
      if (text === TAB_THAT_MISSED_A_PATCH_ASKS) sendWholeWorld(ws);
      return;
    }
    const pty = ws.data.pty;
    if (pty?.exitCode === null) typeIntoTerminal(ws, pty, text);
  },
  close(ws: Ws) {
    if (ws.data.world) {
      worldClients.delete(ws);
      return;
    }
    if (ws.data.browser) {
      closeViewer(ws);
      return;
    }
    ws.data.pty?.kill();
    sessions.get(ws.data.id)?.clients.delete(ws);
  },
};
