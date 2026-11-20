import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInterval } from "@/lib/effects";
import { addBox, type CanvasNode, editBox, loadCanvas, onCanvasChanged, removeBox } from "./canvas-api";

const REMOTE_CHECK_MS = 5000;
const SAVE_AFTER_MS = 400;

type Local = Record<string, Partial<CanvasNode>>;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const without = (local: Local, id: string, keys: (keyof CanvasNode)[]) => {
  const rest = { ...local[id] };
  for (const key of keys) Reflect.deleteProperty(rest, key);
  return { ...local, [id]: rest };
};

// the server owns the boxes; local holds what Isaac is mid-way through (typing, dragging) so a refresh never yanks it back
export function useBoxes(path: string, onError: (message: string) => void) {
  const [nodes, setNodes] = useState<CanvasNode[] | undefined>();
  const [local, setLocal] = useState<Local>({});
  const localNow = useRef(local);
  localNow.current = local;
  const queues = useRef(new Map<string, Promise<unknown>>());
  const asked = useRef(0);

  const refresh = useCallback(async () => {
    asked.current += 1;
    const ask = asked.current;
    try {
      const shown = await loadCanvas(path);
      if (ask === asked.current) setNodes(shown.nodes);
    } catch (error) {
      onError(messageOf(error));
    }
  }, [path, onError]);
  const upsert = useCallback((node: CanvasNode) => {
    asked.current += 1;
    setNodes((all) => (all?.some((n) => n.id === node.id) === true ? all.map((n) => (n.id === node.id ? node : n)) : [...(all ?? []), node]));
  }, []);
  const drop = useCallback((id: string) => {
    asked.current += 1;
    setNodes((all) => all?.filter((n) => n.id !== id));
  }, []);
  // one box's writes go out in order, so a save never lands after the delete or link that followed it
  const inTurn = useCallback(
    async (id: string, work: () => Promise<unknown>) => {
      const next = (queues.current.get(id) ?? Promise.resolve()).then(work).catch((error: unknown) => onError(messageOf(error)));
      queues.current.set(id, next);
      return next;
    },
    [onError],
  );

  useEffect(() => {
    void refresh();
    return onCanvasChanged((changed) => {
      if (changed === path) void refresh();
    });
  }, [path, refresh]);
  useInterval(refresh, REMOTE_CHECK_MS);

  const shown = useMemo(() => nodes?.map((n) => ({ ...n, ...local[n.id] })), [nodes, local]);
  return { nodes: shown, setLocal, localNow, upsert, drop, inTurn };
}

type Boxes = ReturnType<typeof useBoxes>;

function useTextSaver(path: string, boxes: Boxes) {
  const { localNow, setLocal, upsert } = boxes;
  const bases = useRef(new Map<string, string>());
  // base is what the server last had from this editor; it merges whatever an agent wrote since
  const sendText = useCallback(
    async (id: string) => {
      const text = localNow.current[id]?.text;
      if (text === undefined) return;
      const base = bases.current.get(id);
      let { node, isConflict } = await editBox(path, id, { text, ...(base !== undefined && { base }) });
      if (isConflict) ({ node } = await editBox(path, id, { text }));
      bases.current.set(id, text);
      upsert(node);
      if (node.text === text || localNow.current[id]?.text !== text) return;
      bases.current.set(id, node.text);
      setLocal((all) => ({ ...all, [id]: { ...all[id], text: node.text } }));
    },
    [path, localNow, upsert, setLocal],
  );
  return { bases, sendText };
}

export function useEditing(path: string, boxes: Boxes) {
  const { nodes, setLocal, localNow, upsert, drop, inTurn } = boxes;
  const [editing, setEditing] = useState<string | undefined>();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const { bases, sendText } = useTextSaver(path, boxes);

  const open = (id: string, text: string) => {
    bases.current.set(id, text);
    setLocal((all) => ({ ...all, [id]: { ...all[id], text } }));
    setEditing(id);
  };
  const stop = (id: string) => {
    clearTimeout(timers.current.get(id));
    setEditing((e) => (e === id ? undefined : e));
  };
  const flush = (id: string) => {
    clearTimeout(timers.current.get(id));
    void inTurn(id, async () => sendText(id));
  };
  return {
    editing,
    flush,
    edit: (id: string) => {
      const node = nodes?.find((n) => n.id === id);
      if (node) open(id, node.text);
    },
    create: async (at: { x: number; y: number }) => {
      const node = await addBox(path, { text: "", ...at });
      upsert(node);
      open(node.id, "");
    },
    type: (id: string, text: string) => {
      setLocal((all) => ({ ...all, [id]: { ...all[id], text } }));
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => flush(id), SAVE_AFTER_MS));
    },
    finish: (id: string) => {
      stop(id);
      flush(id);
      void inTurn(id, async () => {
        if (localNow.current[id]?.text?.trim() === "") {
          await removeBox(path, id);
          drop(id);
        }
        setLocal((all) => without(all, id, ["text"]));
        bases.current.delete(id);
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
      stop(id);
      void inTurn(id, async () => {
        await removeBox(path, id);
        drop(id);
      });
    },
  };
}
