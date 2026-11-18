import { createStore } from "@/store";

// Slack's side pane: one thread open beside the page, shift-clicked from anywhere. It belongs to the page it was opened on: going
// back to that page (Esc, ←, Back, h) opens it again, as Forward does, and closing it there forgets it. Its width is kept too.

const WIDTH = "yarn-pane-width";
const BY_PAGE = "yarn-pane-by-page";
export const paneStore = createStore<string | undefined>(undefined);

const byPage: Record<string, string> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(BY_PAGE) ?? "{}");
  } catch {
    return {};
  }
})();
const page = () => location.hash.slice(1) || "inbox";
function remember(id: string | undefined) {
  if (id) byPage[page()] = id;
  else delete byPage[page()];
  try {
    sessionStorage.setItem(BY_PAGE, JSON.stringify(byPage));
  } catch {}
}

export const openPane = (threadId: string) => (remember(threadId), paneStore.set(threadId));
export const closePane = () => (remember(undefined), paneStore.set(undefined));
/** The page changed: its own pane, if it had one open, or none. */
export const restorePane = () => paneStore.set(byPage[page()]);
restorePane();

export function paneWidth() {
  try {
    return Number(localStorage.getItem(WIDTH)) || 480;
  } catch {
    return 480;
  }
}
export function savePaneWidth(w: number) {
  try {
    localStorage.setItem(WIDTH, String(Math.round(w)));
  } catch {}
}
