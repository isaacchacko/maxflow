import { expect, test } from "bun:test";
import { boardConfigOf, boardEventOf, busTopic, feedText, isFed, isForIsaac } from "../sentries/board-events";

const config = boardConfigOf({ url: "https://board.test/api/board", self: ["isaac/claude"], objective: "agent-board-on-aca-postgres-devs", name: "the Dryft agent board" });
if (config === undefined) throw new Error("the test config should parse");

const line = (cursor: string, handle: string, text: string, { labels = {}, type = "message.posted" }: { labels?: Record<string, string>; type?: string } = {}) =>
  JSON.stringify({
    cursor,
    type,
    createdAt: "2026-11-20T00:58:53.824Z",
    payload: { channel: "general", text, re: null, thread: "key:abc", labels, by: { profile: handle.split("/", 2)[1] } },
    message: { id: cursor, channel: "general", text, thread: "key:abc", labels },
    actor: { id: `entra:user:x+${handle}`, kind: "agent", handle, name: handle.split("/", 2)[1] },
  });

test("a board tail line becomes an event with its sender, channel, thread and labels", () => {
  const event = boardEventOf(line("11", "max/claude-max", "Urgent ticket PRO-7287", { labels: { priority: "urgent", ticket: "PRO-7287" } }));
  expect(event).toMatchObject({ cursor: "11", id: "11", channel: "general", thread: "key:abc", who: "max/claude-max", labels: { priority: "urgent", ticket: "PRO-7287" } });
  expect(event?.re).toBeUndefined();
});

test("lines that aren't board events are skipped", () => {
  for (const noise of ["", "Vercel CLI 50.0.0", "{}", '{"type":"message.posted"}', "[1,2]"]) expect(boardEventOf(noise)).toBeUndefined();
});

test("our own profile's messages, and anything that isn't a new message, go to the log but not the funnel", () => {
  const theirs = boardEventOf(line("11", "max/claude-max", "hi"));
  const ours = boardEventOf(line("12", "isaac/claude", "seen"));
  const someoneElsesClaude = boardEventOf(line("13", "max/claude", "hi"));
  const reaction = boardEventOf(line("14", "max/claude-max", "", { type: "reaction.added" }));
  if (!theirs || !ours || !someoneElsesClaude || !reaction) throw new Error("fixtures should parse");
  expect([theirs, ours, someoneElsesClaude, reaction].map((e) => isFed(e, config))).toEqual([true, false, true, false]);
  expect(busTopic(reaction)).toBe("board/general/reaction.added");
});

test("a ticket or a message naming Isaac is sized like any feed item; chatter goes to the board's objective", () => {
  const ticket = boardEventOf(line("11", "max/claude-max", "PRO-7287 is urgent", { labels: { ticket: "PRO-7287" } }));
  const forIsaac = boardEventOf(line("12", "max/claude-max", "For Isaac: can you look?"));
  const chatter = boardEventOf(line("13", "max/claude-max", "favourite movie?"));
  if (!ticket || !forIsaac || !chatter) throw new Error("fixtures should parse");
  expect([ticket, forIsaac, chatter].map(isForIsaac)).toEqual([true, true, false]);
  expect(feedText(chatter, config)).toContain("route it to objective agent-board-on-aca-postgres-devs");
  expect(feedText(ticket, config)).toContain("size it like any feed item");
  expect(feedText(ticket, config)).toContain("reply 11 '<text>' --as claude");
});

test("the board's URL and credential are config: no URL means no board, no token command means no token", () => {
  expect(boardConfigOf({})).toBeUndefined();
  const tailnet = boardConfigOf({ url: "https://vm-dryft-board.tail280eed.ts.net/api/board" });
  expect(tailnet?.tokenCommand).toBeUndefined();
  expect(tailnet?.cli).toEqual(["npx", "-y", "vercel@latest", "board"]);
  expect(boardConfigOf({ url: "x", tokenCommand: ["az", "account"] })?.tokenCommand).toEqual(["az", "account"]);
});
