import { useRef, useState } from "react";
import { useEventListener, useInterval, useLatest, useResource } from "@/lib/effects";
import { addBox, CANVAS_CHANGED, type CanvasNode, editBox, loadBoxes, markTyping, removeBox } from "./canvas-api";

const REMOTE_CHECK_MS = 5000;
const SAVE_AFTER_MS = 400;

type Local = Record<string, Partial<CanvasNode>>;
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const without = (local: Local, id: string, keys: (keyof CanvasNode)[]) => {
  const rest = { ...local[id] };
  for (const key of keys) Reflect.deleteProperty(rest, key);
  return { ...local, [id]: rest };
};

const withText = (id: string, text: string) => (all: Local) => ({ ...all, [id]: { ...all[id], text } });

export function useBoxes(path: string, onError: (message: string) => void) {
  const loaded = useResource(`canvas:${path}`, async () => loadBoxes(path));
  const [local, setLocal] = useState<Local>({});
  const localNow = useLatest(local);
  const queues = useRef(new Map<string, Promise<void>>());

  useEventListener(CANVAS_CHANGED, (e) => {
    if (e instanceof CustomEvent && e.detail === path) void loaded.reload();
  });
  useInterval(loaded.reload, REMOTE_CHECK_MS);

  const upsert = (node: CanvasNode) => loaded.set((all = []) => (all.some((n) => n.id === node.id) ? all.map((n) => (n.id === node.id ? node : n)) : [...all, node]));
  const drop = (id: string) => loaded.set((all = []) => all.filter((n) => n.id !== id));
  const inTurn = async (id: string, work: () => Promise<unknown>) => {
    const before = queues.current.get(id);
    const next = (async () => {
      await before;
      try {
        await work();
      } catch (error) {
        onError(messageOf(error));
      }
    })();
    queues.current.set(id, next);
    return next;
  };

  const nodes = loaded.value?.map((n) => ({ ...n, ...local[n.id] }));
  return { nodes, error: loaded.error, setLocal, localNow, upsert, drop, inTurn };
}

type Boxes = ReturnType<typeof useBoxes>;

function useTextSaver(path: string, boxes: Boxes) {
  const { localNow, setLocal, upsert } = boxes;
  const bases = useRef(new Map<string, string>());
  const sendText = async (id: string) => {
    const text = localNow.current[id]?.text;
    if (text === undefined) return;
    const base = bases.current.get(id);
    const merged = await editBox(path, id, { text, ...(base !== undefined && { base }) });
    const { node } = merged.isConflict ? await editBox(path, id, { text }) : merged;
    bases.current.set(id, text);
    upsert(node);
    if (node.text === text || localNow.current[id]?.text !== text) return;
    bases.current.set(id, node.text);
    setLocal(withText(id, node.text));
  };
  return { bases, sendText };
}

function useTextEditing(path: string, boxes: Boxes) {
  const { setLocal, inTurn } = boxes;
  const [editing, setEditing] = useState<string | undefined>();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const { bases, sendText } = useTextSaver(path, boxes);
  const flush = (id: string) => {
    clearTimeout(timers.current.get(id));
    void inTurn(id, async () => sendText(id));
  };
  return {
    editing,
    bases,
    flush,
    open: (id: string, text: string) => {
      void markTyping(path, id);
      bases.current.set(id, text);
      setLocal(withText(id, text));
      setEditing(id);
    },
    stop: (id: string) => {
      clearTimeout(timers.current.get(id));
      setEditing((e) => (e === id ? undefined : e));
    },
    type: (id: string, text: string) => {
      setLocal(withText(id, text));
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => flush(id), SAVE_AFTER_MS),
      );
    },
  };
}

export function useEditing(path: string, boxes: Boxes) {
  const { nodes, setLocal, localNow, upsert, drop, inTurn } = boxes;
  const text = useTextEditing(path, boxes);
  return {
    editing: text.editing,
    flush: text.flush,
    type: text.type,
    edit: (id: string) => {
      const node = nodes?.find((n) => n.id === id);
      if (node) text.open(id, node.text);
    },
    create: async (at: { x: number; y: number }) => {
      const node = await addBox(path, { text: "", ...at });
      upsert(node);
      text.open(node.id, "");
    },
    finish: (id: string) => {
      text.stop(id);
      text.flush(id);
      void inTurn(id, async () => {
        if (localNow.current[id]?.text?.trim() === "") {
          await removeBox(path, id);
          drop(id);
        }
        setLocal((all) => without(all, id, ["text"]));
        text.bases.current.delete(id);
      });
    },
    place: (id: string, box: Partial<CanvasNode>, isDone: boolean) => {
      setLocal((all) => ({ ...all, [id]: { ...all[id], ...box } }));
      if (!isDone) return;
      void inTurn(id, async () => {
        upsert((await editBox(path, id, box)).node);
        setLocal((all) => without(all, id, ["x", "y", "width", "height"]));
      });
    },
    remove: (id: string) => {
      text.stop(id);
      void inTurn(id, async () => {
        await removeBox(path, id);
        drop(id);
      });
    },
  };
}
