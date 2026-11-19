import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import type { Root } from "react-dom/client";

// A DOM for these tests only: registered globally it would replace fetch and friends for the other test files.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useEventListener, useNow, usePresence, useResource, useSettled } = await import("../src/lib/effects");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
const render = async (el: React.ReactElement) => {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(el));
};
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});
// One act per few ms: updates queued inside one act flush only when it ends.
// The clock-driven hooks run on fake timers, moved on by hand, so a loaded machine can't change what they see.
const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));
const fakeClock = () => {
  jest.useFakeTimers();
  return { [Symbol.dispose]: () => jest.useRealTimers() };
};
const wait = async (ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; ) await act(() => new Promise(r => setTimeout(r, 5)));
  await act(async () => {});
};

test("useEventListener runs the newest handler and stops at unmount", async () => {
  const seen: string[] = [];
  function Listener({ label }: { label: string }) {
    useEventListener("ping", () => seen.push(label));
    return null;
  }
  await render(h(Listener, { label: "first" }));
  dispatchEvent(new Event("ping"));
  await render(h(Listener, { label: "second" }));
  dispatchEvent(new Event("ping"));
  await act(async () => root!.unmount());
  root = undefined;
  dispatchEvent(new Event("ping"));
  expect(seen).toEqual(["first", "second"]);
});

test("useEventListener listens on the target it is given", async () => {
  let n = 0;
  function Listener() {
    useEventListener("selectionchange", () => n++, { target: document });
    return null;
  }
  await render(h(Listener));
  dispatchEvent(new Event("selectionchange"));
  document.dispatchEvent(new Event("selectionchange"));
  expect(n).toBe(1);
});

test("useNow draws again after the wait it is given", async () => {
  using _ = fakeClock();
  const draws: number[] = [];
  function Clock() {
    draws.push(useNow(() => 20));
    return null;
  }
  await render(h(Clock));
  await tick(19);
  expect(draws.length).toBe(1);
  await tick(1);
  await tick(20);
  expect(draws.length).toBe(3);
  expect(draws[2]! - draws[0]!).toBe(40);
});

test("useSettled follows its value only once it holds still", async () => {
  const draws: string[] = [];
  function Search({ q }: { q: string }) {
    draws.push(useSettled(q, 30));
    return null;
  }
  using _ = fakeClock();
  await render(h(Search, { q: "a" }));
  await render(h(Search, { q: "ab" }));
  await tick(29);
  await render(h(Search, { q: "abc" }));
  await tick(29);
  expect(draws.at(-1)).toBe("a");
  await tick(1);
  expect(draws.at(-1)).toBe("abc");
  expect(draws).not.toContain("ab");
});

test("usePresence stays mounted for the way out, and shows only after it mounts", async () => {
  using _ = fakeClock();
  const states: { mounted: boolean; shown: boolean }[] = [];
  function Panel({ open }: { open: boolean }) {
    states.push(usePresence(open, 30));
    return null;
  }
  await render(h(Panel, { open: false }));
  expect(states.at(-1)).toEqual({ mounted: false, shown: false });
  await render(h(Panel, { open: true }));
  expect(states.at(-1)).toEqual({ mounted: true, shown: false });
  await tick(100);
  expect(states.at(-1)).toEqual({ mounted: true, shown: true });
  await render(h(Panel, { open: false }));
  expect(states.at(-1)).toEqual({ mounted: true, shown: false });
  await tick(29);
  expect(states.at(-1)).toEqual({ mounted: true, shown: false });
  await tick(1);
  expect(states.at(-1)).toEqual({ mounted: false, shown: false });
});

test("useResource fetches once per key while read, keeps edits, and fetches again after everyone leaves", async () => {
  let loads = 0;
  const load = async () => ++loads;
  let shown: ReturnType<typeof useResource<number>> | undefined;
  function Reader({ k }: { k?: string }) {
    shown = useResource(k, load);
    return null;
  }
  function Two() {
    return h("div", null, h(Reader, { k: "a" }), h(Reader, { k: "a" }));
  }
  await render(h(Reader, {}));
  expect(shown!.value).toBeUndefined();
  expect(loads).toBe(0);

  await render(h(Two));
  await wait(0);
  expect(loads).toBe(1);
  expect(shown!.value).toBe(1);

  await act(async () => shown!.set(v => (v ?? 0) + 100));
  expect(shown!.value).toBe(101);

  await act(async () => shown!.reload());
  await wait(0);
  expect(shown!.value).toBe(2);

  await act(async () => root!.unmount());
  root = undefined;
  await wait(5);
  await render(h(Reader, { k: "a" }));
  await wait(0);
  expect(loads).toBe(3);
  expect(shown!.value).toBe(3);
});

test("useResource keeps the last value and reports a failed fetch", async () => {
  let fail = false;
  let shown: ReturnType<typeof useResource<string>> | undefined;
  function Reader() {
    shown = useResource("b", async () => (fail ? Promise.reject(new Error("down")) : "ok"));
    return null;
  }
  await render(h(Reader));
  await wait(0);
  fail = true;
  await act(async () => shown!.reload());
  await wait(0);
  expect(shown!.value).toBe("ok");
  expect(shown!.error?.message).toBe("down");
});
