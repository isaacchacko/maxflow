import { expect, test } from "bun:test";
import { describeView, layoutOf, parseSize, phoneAgentFrom, zoomWithin } from "../browser-size";

test("a size is a preset or WxH within bounds, and zoom snaps to 25% steps between 25% and 300%", () => {
  expect(parseSize("Tablet")).toEqual({ name: "tablet", width: 768, height: 1024, mobile: false, dpr: 1 });
  expect(parseSize("1024x600")).toEqual({ name: "custom", width: 1024, height: 600, mobile: false, dpr: 1 });
  expect(() => parseSize("10x10")).toThrow("WxH");
  expect(() => parseSize("big")).toThrow("phone, tablet, laptop, desktop");
  expect([zoomWithin(0.1), zoomWithin(1.3), zoomWithin(9)]).toEqual([0.25, 1.25, 3]);
});

test("zoom shrinks the layout viewport the way Chrome's own zoom does, and the size reads back plainly", () => {
  const view = { size: parseSize("desktop"), zoom: 1.5 };
  expect(layoutOf(view)).toEqual({ width: 1280, height: 720 });
  expect(describeView(view)).toBe("desktop 1920x1080 at 150% zoom");
  expect(describeView({ size: parseSize("800x600"), zoom: 1 })).toBe("800x600");
});

test("a phone sends a mobile user agent with the same Chrome version", () => {
  const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.8103.79 Safari/537.36";
  expect(phoneAgentFrom(desktop)).toBe("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.79 Mobile Safari/537.36");
});
