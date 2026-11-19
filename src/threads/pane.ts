import { isRecord } from "../../shared/guards";
import { hasText } from "@/lib/utils";
import { createStore } from "@/store";
import { focusRegion } from "./region";

const WIDTH = "yarn-pane-width";
const BY_PAGE = "yarn-pane-by-page";
const DEFAULT_WIDTH = 480;
export const paneStore = createStore<string | undefined>(undefined);

function readPanesByPage() {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(BY_PAGE) ?? "{}");
    const entries = isRecord(parsed) ? Object.entries(parsed) : [];
    return new Map(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return new Map<string, string>();
  }
}

const paneOpenOnPage = readPanesByPage();
const page = () => location.hash.slice(1) || "inbox";

function remember(id: string | undefined) {
  if (hasText(id)) paneOpenOnPage.set(page(), id);
  else paneOpenOnPage.delete(page());
  try {
    sessionStorage.setItem(BY_PAGE, JSON.stringify(Object.fromEntries(paneOpenOnPage)));
  } catch {
    // constraint: sessionStorage throws in a private window or on a full quota; the pane is still remembered in memory
  }
}

function showAndFocus(id: string | undefined) {
  if (id !== paneStore.get()) focusRegion(hasText(id) ? "pane" : "main");
  paneStore.set(id);
}

export const openPane = (threadId: string) => {
  remember(threadId);
  showAndFocus(threadId);
};
export const closePane = () => {
  remember(undefined);
  showAndFocus(undefined);
};
export const restorePane = () => showAndFocus(paneOpenOnPage.get(page()));
restorePane();

export function paneWidth() {
  try {
    const stored = Number(localStorage.getItem(WIDTH));
    return stored === 0 || Number.isNaN(stored) ? DEFAULT_WIDTH : stored;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function savePaneWidth(w: number) {
  try {
    localStorage.setItem(WIDTH, String(Math.round(w)));
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the width then lasts only this page load
  }
}
