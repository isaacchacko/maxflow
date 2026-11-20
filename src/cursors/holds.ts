const held = new Map<string, number>();
const landers = new Map<string, Set<() => void>>();
const releaseListeners = new Set<() => void>();

export const heldKeys = () => held.keys().toArray();
export const isHeld = (key: string) => held.has(key);

export function onLand(key: string, fn: () => void) {
  const set = landers.get(key) ?? new Set();
  set.add(fn);
  landers.set(key, set);
  return () => {
    set.delete(fn);
  };
}

export function onRelease(fn: () => void) {
  releaseListeners.add(fn);
  return () => {
    releaseListeners.delete(fn);
  };
}

function release(keys: string[]) {
  const landed = keys.filter(key => {
    const n = (held.get(key) ?? 1) - 1;
    if (n > 0) held.set(key, n);
    else held.delete(key);
    return n <= 0;
  });
  for (const fn of releaseListeners) fn();
  const toCall = landed.flatMap(key => [...(landers.get(key) ?? [])]);
  for (const fn of toCall) fn();
}

const claims = new Map<string, () => void>();

export function claim(key: string, capMs: number) {
  claims.get(key)?.();
  claims.set(key, hold([key], capMs));
}

export function settleClaims(keys: string[]) {
  for (const key of keys) {
    const settle = claims.get(key);
    claims.delete(key);
    settle?.();
  }
}

export function hold(keys: string[], capMs: number) {
  for (const key of keys) held.set(key, (held.get(key) ?? 0) + 1);
  let isReleased = false;
  const once = () => {
    if (isReleased) return;
    isReleased = true;
    clearTimeout(timer);
    release(keys);
  };
  const timer = setTimeout(once, capMs);
  return once;
}
