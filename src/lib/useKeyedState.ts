import { useState } from "react";

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
