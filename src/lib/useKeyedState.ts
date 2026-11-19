import { useState } from "react";

/**
 * State that starts over at `initial` whenever `key` changes, like a list's highlighted row going back to the top as the
 * query changes. The reset happens during the render that sees the new key, so it draws with the change.
 */
export function useKeyedState<T>(key: unknown, initial: T) {
  const [state, setState] = useState({ key, value: initial });
  const current = Object.is(state.key, key) ? state : { key, value: initial };
  if (current !== state) setState(current);
  const set = (next: T | ((prev: T) => T)) =>
    setState(prev => {
      const base = Object.is(prev.key, key) ? prev.value : initial;
      return { key, value: typeof next === "function" ? (next as (prev: T) => T)(base) : next };
    });
  return [current.value, set] as const;
}
