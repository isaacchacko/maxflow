import { createStore } from "@/store";

// Slack's side pane: one thread open beside the page, shift-clicked from anywhere, its width kept in this browser.

const WIDTH = "yarn-pane-width";
export const paneStore = createStore<string | undefined>(undefined);
export const openPane = (threadId: string) => paneStore.set(threadId);
export const closePane = () => paneStore.set(undefined);

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
