import { useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Base64, ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { useLatest } from "@/lib/effects";

const ESC = "\u{1B}";
const DEVICE_ATTRIBUTE_REPLY = new RegExp(`${ESC}\\[[?>][\\d;]*c`, "g");

// constraint: tmux's OSC 52 leaves the selection field empty, which the addon's default provider drops
const systemClipboard: IClipboardProvider = {
  readText: async () => navigator.clipboard.readText(),
  writeText: async (_selection, text) => navigator.clipboard.writeText(text),
};

// constraint: xterm.js only reads hex and rgb colours and the theme's are oklch, so a painted pixel gives the rgb back
function rgb(color: string) {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return color;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

type MacEdit = string | ((term: XTerm) => void);
const MAC_COMMAND_EDITS: Record<string, MacEdit> = { Backspace: "\u{15}", ArrowLeft: "\u{1}", ArrowRight: "\u{5}", k: term => term.clear(), a: term => term.selectAll() };
const MAC_OPTION_EDITS: Record<string, MacEdit> = { Backspace: `${ESC}\u{7F}`, ArrowLeft: `${ESC}b`, ArrowRight: `${ESC}f` };
const MODIFIERS = ["metaKey", "altKey", "ctrlKey", "shiftKey"] as const;

function macEditingKey(e: KeyboardEvent): MacEdit | undefined {
  const isOnly = (mod: (typeof MODIFIERS)[number]) => MODIFIERS.every(m => e[m] === (m === mod));
  if (isOnly("metaKey")) return MAC_COMMAND_EDITS[e.key];
  if (isOnly("altKey")) return MAC_OPTION_EDITS[e.key];
  return isOnly("shiftKey") && e.key === "Enter" ? `${ESC}\r` : undefined;
}

function openTerminal(el: HTMLDivElement) {
  const term = new XTerm({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionClickForcesSelection: true,
    theme: { background: rgb(getComputedStyle(el).backgroundColor), selectionBackground: "#6cb6ff44" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  // @ts-expect-error @xterm/addon-clipboard's typings declare one constructor argument, but its code takes (base64, provider)
  term.loadAddon(new ClipboardAddon(new Base64(), systemClipboard));
  term.open(el);
  fit.fit();
  return { term, fit };
}

const stopRightClick = (e: MouseEvent) => {
  if (e.button === 2) e.stopPropagation();
};

function keepRightClickForSessionMenu(el: HTMLDivElement) {
  for (const type of ["mousedown", "mouseup"] as const) el.addEventListener(type, stopRightClick, { capture: true });
}

export function Terminal({ id, onClose }: { id: string; onClose?: () => void }) {
  const latestOnClose = useLatest(onClose);

  const mount = useCallback(
    (el: HTMLDivElement) => {
      const { term, fit } = openTerminal(el);
      const ws = new WebSocket(`ws://${location.host}/ws/${id}`);
      ws.binaryType = "arraybuffer";
      const send = (m: object) => ws.readyState === 1 && ws.send(JSON.stringify(m));
      // constraint: replayed output holds old terminal queries, and xterm's answers to them must not reach the program as input
      let isReplaying = true;
      const onMessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data === "string")
          term.write("", () => {
            isReplaying = false;
          });
        else if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
      };
      const onSocketClose = () => latestOnClose.current?.();
      ws.addEventListener("open", () => send({ type: "resize", cols: term.cols, rows: term.rows }));
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onSocketClose);
      // constraint: tmux answers device-attribute queries itself and types a late reply into the pane (it held router 17656f41's messages)
      term.onData(data => {
        const typed = data.replaceAll(DEVICE_ATTRIBUTE_REPLY, "");
        if (!isReplaying && typed !== "") send({ type: "input", data: typed });
      });
      term.attachCustomKeyEventHandler(e => {
        const edit = macEditingKey(e);
        if (edit === undefined) return true;
        if (e.type === "keydown") {
          if (typeof edit === "string") send({ type: "input", data: edit });
          else edit(term);
        }
        e.preventDefault();
        return false;
      });
      term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
      keepRightClickForSessionMenu(el);
      const resize = new ResizeObserver(() => {
        if (el.offsetParent) fit.fit();
      });
      resize.observe(el);
      term.focus();

      return () => {
        resize.disconnect();
        ws.removeEventListener("close", onSocketClose);
        ws.close();
        term.dispose();
      };
    },
    [id, latestOnClose],
  );

  return <div ref={mount} className="dark size-full bg-background" />;
}
