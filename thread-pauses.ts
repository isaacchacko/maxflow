import type { Thread } from "./model";
import { threads } from "./stores";
import { pauseTimers, resurface, schedulePause } from "./threads";

const PAUSE_CHECK_MS = 60_000;

function resurfaceOrReschedule(t: Thread, until: number) {
  if (until <= Date.now()) resurface(t);
  else schedulePause(t);
}

export function keepResurfacingPausedThreads() {
  for (const t of threads) if (t.paused) schedulePause(t);
  setInterval(() => {
    for (const t of threads) if (t.paused && !pauseTimers.has(t.id)) resurfaceOrReschedule(t, t.paused.until);
  }, PAUSE_CHECK_MS);
}
