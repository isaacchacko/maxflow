import { useRef, useState } from "react";
import { useEventListener, useLatest } from "@/lib/effects";
import { uploadKeptAsFile } from "@/lib/upload";
import { startThread } from "@/store";
import { whereTheShotWasTaken } from "./capture/context";
import { captureRegion } from "./capture/draw";
import { CommentPopover, PickOverlay, type Shot } from "./capture/parts";
import { captureTarget, type Rect } from "./capture/region";

const isCaptureShortcut = (e: KeyboardEvent) => e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey;

const untilTheOverlayIsGone = async () =>
  new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

function closeDialogThroughItsInput(dialog: Element | null) {
  if (dialog?.isConnected !== true) return;
  (dialog.querySelector("input") ?? dialog).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function failureText(error: unknown) {
  if (error instanceof Event) return "something on the page wouldn't load while drawing it";
  return error instanceof Error ? error.message : String(error);
}

function useCaptureState() {
  const [mode, setMode] = useState<"off" | "picking" | "shooting" | "comment">("off");
  const [shot, setShot] = useState<Shot | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [isSendingWhenReady, setSendWhenReady] = useState(false);
  const takingRef = useRef(0);
  const reset = () => {
    if (shot?.preview !== undefined) URL.revokeObjectURL(shot.preview);
    takingRef.current += 1;
    setSendWhenReady(false);
    setMode("off");
    setShot(null);
    setComment("");
    setError("");
  };
  return { mode, setMode, shot, setShot, comment, setComment, error, setError, isSendingWhenReady, setSendWhenReady, takingRef, reset };
}

function useCapture() {
  const state = useCaptureState();
  const { mode, setMode, shot, setShot, comment, setError, setSendWhenReady, takingRef, reset } = state;
  const overlay = useRef<HTMLDivElement>(null);
  const latestSendWhenReady = useLatest(state.isSendingWhenReady);

  async function send(picture: Pick<Shot, "png" | "failure"> = { ...(shot?.png && { png: shot.png }), ...(shot?.failure !== undefined && { failure: shot.failure }) }) {
    if (!shot || (!picture.png && picture.failure === undefined)) return;
    setMode("shooting");
    try {
      const attached = picture.png ? `![screenshot](${await uploadKeptAsFile(picture.png)})` : `(No screenshot: ${picture.failure ?? ""}.)`;
      await startThread([comment.trim(), attached, shot.context].filter(Boolean).join("\n"));
      reset();
    } catch (error_) {
      setError(String(error_));
      setMode("comment");
    }
  }
  const latestSend = useLatest(send);

  async function take(rect: Rect, picked?: Element) {
    if (rect.w < 2 || rect.h < 2) {
      reset();
      return;
    }
    const context = whereTheShotWasTaken(rect, overlay.current);
    const target = captureTarget(rect, picked, overlay.current);
    takingRef.current += 1;
    const mine = takingRef.current;
    const dialogInTheShot = document.querySelector('[role="dialog"]');
    setShot({ rect, context, target });
    setMode("comment");
    try {
      await untilTheOverlayIsGone();
      const png = await captureRegion(rect, target);
      if (mine !== takingRef.current) return;
      setShot(s => s && { ...s, png, preview: URL.createObjectURL(png) });
      if (latestSendWhenReady.current) {
        setSendWhenReady(false);
        void latestSend.current({ png });
      }
      closeDialogThroughItsInput(dialogInTheShot);
    } catch (error_) {
      if (mine !== takingRef.current) return;
      const failure = failureText(error_);
      setShot(s => s && { ...s, failure });
      setError(`Couldn't take the picture: ${failure}. Enter sends your message without it.`);
      if (latestSendWhenReady.current) {
        setSendWhenReady(false);
        void latestSend.current({ failure });
      }
    }
  }

  useEventListener(
    "keydown",
    e => {
      if (isCaptureShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        setMode(m => (m === "off" ? "picking" : m));
      } else if (mode === "picking" && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        reset();
      }
    },
    { capture: true },
  );

  const sendOrWait = () => {
    if (shot?.png || shot?.failure !== undefined) void send();
    else setSendWhenReady(true);
  };
  return { ...state, overlay, take, sendOrWait };
}

export function Capture() {
  const { mode, shot, comment, setComment, error, isSendingWhenReady, overlay, take, sendOrWait, reset } = useCapture();
  return (
    <>
      {mode === "picking" && (
        <PickOverlay
          overlayRef={overlay}
          onPick={(rect, picked) => {
            void take(rect, picked);
          }}
        />
      )}
      {(mode === "comment" || (mode === "shooting" && shot)) && (
        <CommentPopover shot={shot} error={error} comment={comment} onComment={setComment} isSending={mode === "shooting"} isSendingWhenReady={isSendingWhenReady} onEnter={sendOrWait} onCancel={reset} />
      )}
    </>
  );
}
