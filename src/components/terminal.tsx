import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Base64, ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";

// tmux's OSC 52 leaves the selection field empty, which the addon's default provider drops.
const systemClipboard: IClipboardProvider = {
  readText: () => navigator.clipboard.readText(),
  writeText: (_selection, text) => navigator.clipboard.writeText(text),
};

export type TerminalHandle = { focus: () => void; fit: () => void; selection: () => string };

// What macOS terminals send for ⌘/⌥ editing keys; xterm.js leaves these to the browser.
function macKey(e: KeyboardEvent, term: XTerm): string | (() => void) | undefined {
  const only = (mod: "metaKey" | "altKey" | "ctrlKey" | "shiftKey") => (["metaKey", "altKey", "ctrlKey", "shiftKey"] as const).every((m) => e[m] === (m === mod));
  if (only("metaKey")) return ({ Backspace: "\x15", ArrowLeft: "\x01", ArrowRight: "\x05", k: () => term.clear(), a: () => term.selectAll() } as Record<string, string | (() => void)>)[e.key];
  if (only("altKey")) return ({ Backspace: "\x1b\x7f", ArrowLeft: "\x1bb", ArrowRight: "\x1bf" } as Record<string, string>)[e.key];
  if (only("shiftKey") && e.key === "Enter") return "\x1b\r";
}

export function Terminal({ id, onClose, handle }: { id: string; onClose: () => void; handle: React.RefObject<TerminalHandle | null> }) {
  const el = useRef<HTMLDivElement>(null);
  const closed = useRef(onClose);
  closed.current = onClose;

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
      theme: { background: getComputedStyle(document.body).backgroundColor, selectionBackground: "#6cb6ff44" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon(new Base64(), systemClipboard));
    term.open(el.current!);
    fit.fit();

    const ws = new WebSocket(`ws://${location.host}/ws/${id}`);
    ws.binaryType = "arraybuffer";
    const send = (m: object) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    // Replayed output contains old terminal queries; xterm's answers to them must not reach the program as input.
    let replaying = true;
    ws.onopen = () => send({ type: "resize", cols: term.cols, rows: term.rows });
    ws.onmessage = (e) => (typeof e.data === "string" ? term.write("", () => (replaying = false)) : term.write(new Uint8Array(e.data)));
    ws.onclose = () => closed.current();
    term.onData((data) => replaying || send({ type: "input", data }));
    term.attachCustomKeyEventHandler((e) => {
      const action = macKey(e, term);
      if (!action) return true;
      if (e.type === "keydown") typeof action === "string" ? send({ type: "input", data: action }) : action();
      e.preventDefault();
      return false;
    });
    term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    // Right-click belongs to maxflow's session menu, so tmux never sees the press and never opens its own in-pane menu.
    const keepRightClick = (e: MouseEvent) => e.button === 2 && e.stopPropagation();
    for (const type of ["mousedown", "mouseup"]) el.current!.addEventListener(type, keepRightClick as EventListener, true);
    const resize = new ResizeObserver(() => el.current?.offsetParent && fit.fit());
    resize.observe(el.current!);
    handle.current = { focus: () => term.focus(), fit: () => fit.fit(), selection: () => term.getSelection() };
    term.focus();

    return () => {
      resize.disconnect();
      ws.onclose = null;
      ws.close();
      term.dispose();
      handle.current = null;
    };
  }, [id]);

  return <div ref={el} className="size-full" />;
}
