import { expect, test } from "bun:test";
import { LONG_WINDOW, lastFill, percent, windowOf } from "../context-fill";

const assistant = (model: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", timestamp: "2026-11-20T10:00:00.000Z", message: { model, usage }, ...extra });

test("fill is the last main-chain reply's input, cache write and cache read, against the model's window", () => {
  const lines = [
    assistant("claude-opus-5-5", { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 999 }),
    assistant("claude-opus-5-5", { input_tokens: 2, cache_creation_input_tokens: 5000, cache_read_input_tokens: 595_000, output_tokens: 7 }),
    assistant("claude-haiku-5-5", { input_tokens: 3, cache_read_input_tokens: 9 }, { isSidechain: true }),
    assistant("<synthetic>", { input_tokens: 0 }),
    '{"type":"user","message":{"content":"hi"}}',
    "not json",
  ];
  const fill = lastFill(lines);
  expect(fill).toMatchObject({ tokens: 600_002, window: LONG_WINDOW, model: "claude-opus-5-5", at: Date.parse("2026-11-20T10:00:00.000Z") });
  expect(fill && percent(fill)).toBe(60);
});

test("Claude 5 and [1m] models get the 1M window; older ones 200k unless they already went past it", () => {
  expect(windowOf("claude-sonnet-5-5", 0)).toBe(LONG_WINDOW);
  expect(windowOf("claude-opus-4-6[1m]", 0)).toBe(LONG_WINDOW);
  expect(windowOf("claude-opus-4-6", 150_000)).toBe(200_000);
  expect(windowOf("claude-opus-4-6", 250_000)).toBe(LONG_WINDOW);
});

test("a transcript with no reply yet has no fill", () => {
  expect(lastFill(['{"type":"user"}'])).toBeUndefined();
});
