import { createStore } from "@/store";

// Tabs, as a browser has them: each one is a place in the app with its own back and forward, the address bar shows the active
// tab's place, and they survive a reload. A link moves the active tab; switching tabs or going back in one rewrites the current
// history entry instead of adding to it, and marks it seen so the page puts its scroll back (see arrive in threads/jump.ts).

export type Tab = { id: string; stack: string[]; at: number };
type State = { tabs: Tab[]; active: string };

const KEY = "yarn-tabs";
const HOME = "inbox";
const DEPTH = 50;

const fresh = (): Tab => ({ id: crypto.randomUUID().slice(0, 8), stack: [HOME], at: 0 });
const here = () => location.hash.slice(1) || HOME;
export const placeOf = (t: Tab) => t.stack[t.at] ?? HOME;

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "") as State;
    if (s.tabs.length && s.tabs.some(t => t.id === s.active)) return s;
  } catch {}
  const t = fresh();
  return { tabs: [t], active: t.id };
}

export const tabStore = createStore<State>(load());
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabStore.get()));
  } catch {}
};
const activeTab = () => tabStore.get().tabs.find(t => t.id === tabStore.get().active)!;
const update = (fn: (s: State) => State) => (tabStore.set(fn), save());
const updateTab = (id: string, fn: (t: Tab) => Tab) => update(s => ({ ...s, tabs: s.tabs.map(t => (t.id === id ? fn(t) : t)) }));

/** The route changed; App re-reads the hash. `moved` says how: a link (fresh), a tab switch, or this tab's back or forward. */
export type RouteChange = { moved: "link" | "switch" | "history" };
// The hash the app last drew, so a popstate knows whether the browser will follow it with a hashchange.
let drawn = "";
function announce(moved: RouteChange["moved"]) {
  drawn = location.hash.slice(1) || HOME;
  dispatchEvent(new CustomEvent<RouteChange>("route", { detail: { moved } }));
}

// Every history entry carries a sequence number, so a popstate can tell Back from Forward.
let seq = history.state?.seq ?? 0;
const stamp = (extra: object = {}) => history.replaceState({ ...history.state, seq: (seq = seq + 1), ...extra }, "");
if (history.state?.seq === undefined) stamp();

/** Shows `place` in the current history entry without adding one, as seen, so its scroll comes back. */
function show(place: string) {
  if (here() !== place) history.replaceState({ ...history.state, seen: true }, "", `#${place}`);
  else history.replaceState({ ...history.state, seen: true }, "");
}

/** The active tab goes forward to `place`, dropping whatever was ahead of it. */
function push(place: string) {
  updateTab(tabStore.get().active, t => {
    const stack = [...t.stack.slice(0, t.at + 1), place].slice(-DEPTH);
    return { ...t, stack, at: stack.length - 1 };
  });
}

// A hash he opened himself (a link, a view key, ⌘K) moves the active tab forward.
let ignoreHash = false;
addEventListener("hashchange", () => {
  if (ignoreHash) return void (ignoreHash = false);
  if (here() !== placeOf(activeTab())) (stamp(), push(here()));
  announce("link");
});

// The browser's Back and Forward are the active tab's own, whichever entries the browser walked through to get there.
addEventListener("popstate", e => {
  // Following a link fires popstate too, on a new entry with no state yet; that one is hashchange's.
  if (e.state?.seq === undefined) return;
  // The browser has already put the popped entry's hash in the address; it fires hashchange after this if that differs from ours.
  ignoreHash = here() !== drawn;
  const forward = (e.state?.seq ?? 0) > seq;
  seq = e.state?.seq ?? seq;
  const t = activeTab();
  const at = Math.max(0, Math.min(t.stack.length - 1, t.at + (forward ? 1 : -1)));
  updateTab(t.id, x => ({ ...x, at }));
  show(placeOf(activeTab()));
  announce("history");
});

// The address he loaded with is where the active tab is: a link from outside opens in it.
if (location.hash && here() !== placeOf(activeTab())) push(here());
else show(placeOf(activeTab()));
drawn = here();

export function switchTab(id: string) {
  if (id === tabStore.get().active || !tabStore.get().tabs.some(t => t.id === id)) return;
  update(s => ({ ...s, active: id }));
  show(placeOf(activeTab()));
  announce("switch");
}

/** A new tab at `place` (the inbox by default), in front unless `background`, right after the active one. */
export function openTab(place = HOME, background = false) {
  const t = { ...fresh(), stack: place === HOME ? [HOME] : [HOME, place], at: place === HOME ? 0 : 1 };
  update(s => {
    const i = s.tabs.findIndex(x => x.id === s.active);
    return { ...s, tabs: [...s.tabs.slice(0, i + 1), t, ...s.tabs.slice(i + 1)] };
  });
  if (!background) switchTab(t.id);
}

/** The last tab stays; closing the active one lands on its neighbour, as a browser does. */
export function closeTab(id: string) {
  const { tabs, active } = tabStore.get();
  if (tabs.length < 2) return;
  const i = tabs.findIndex(t => t.id === id);
  const next = tabs[i + 1] ?? tabs[i - 1]!;
  if (id === active) switchTab(next.id);
  update(s => ({ ...s, tabs: s.tabs.filter(t => t.id !== id) }));
}

export function moveTab(id: string, to: number) {
  update(s => {
    const tabs = s.tabs.filter(t => t.id !== id);
    tabs.splice(to, 0, s.tabs.find(t => t.id === id)!);
    return { ...s, tabs };
  });
}

/** By position (⌘1–9, where ⌘9 is the last tab, as in a browser) or one step either way (⌃Tab, ⌃⇧Tab). */
export function switchToIndex(n: number) {
  const { tabs } = tabStore.get();
  const t = n === 8 ? tabs.at(-1) : tabs[n];
  if (t) switchTab(t.id);
}
export function cycleTab(by: 1 | -1) {
  const { tabs, active } = tabStore.get();
  const i = tabs.findIndex(t => t.id === active);
  switchTab(tabs[(i + by + tabs.length) % tabs.length]!.id);
}

/** The view this tab was last on before the page it shows now (the inbox if none), where climbing out of a top thread lands. */
export function viewBehind() {
  const t = activeTab();
  return t.stack.slice(0, t.at + 1).findLast(p => !p.includes("/")) ?? HOME;
}

/** Which tab the page drawn now belongs to, so per-page memory (scroll) can be kept per tab. */
export const activeTabId = () => tabStore.get().active;
