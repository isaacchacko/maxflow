import { expect, test } from "bun:test";
import { asOf, candidatesAt, funnelPick, JevCallError, NEW_OBJECTIVE, routeObjective, type ObjectiveRow } from "../jev";

const objectives = new Map<string, ObjectiveRow>(
  [
    { id: "dev", title: "maxflow development", at: 100 },
    { id: "dup", title: "maxflow images", at: 200, closed: true, mergedInto: "dev" },
    { id: "later", title: "festo templates", at: 500 },
    { id: "early", title: "old twin", at: 50, closed: true, mergedInto: "later" },
    { id: "done", title: "finished", at: 10, closed: true },
  ].map((o) => [o.id, o]),
);

test("a merged objective counts as the one it was merged into, if that one existed at the time", () => {
  expect(asOf(objectives, "dup", 300)).toBe("dev");
  expect(asOf(objectives, "early", 300)).toBe("early");
  expect(asOf(objectives, "later", 300)).toBe(NEW_OBJECTIVE);
});

test("the funnel picked new when it created the objective after the signal", () => {
  expect(funnelPick(objectives, "dup", 150)).toBe(NEW_OBJECTIVE);
  expect(funnelPick(objectives, "dup", 300)).toBe("dev");
});

test("candidates are the open objectives of the time, merged twins folded together", () => {
  expect(candidatesAt(objectives, 300, (o) => o.closed !== true || o.id === "dup").map((o) => o.id)).toEqual(["dev"]);
});

test("routeObjective asks one choice over the candidates plus new and reads Jev's answer", async () => {
  let asked: unknown;
  using server = Bun.serve({
    port: 0,
    async fetch(req) {
      asked = await req.json();
      return Response.json({ model: "fake", answers: { pick: { type: "choice", choice: "dev", probabilities: { dev: 0.9, new: 0.1 }, confidence: 0.53 } }, usage: { input_tokens: 120, output_tokens: 0 } });
    },
  });
  const answer = await routeObjective({ url: server.url.origin, key: "", model: "fake", sources: new Set(["isaac"]) }, "add vim motions to threads", objectives.values().filter((o) => o.id === "dev").toArray());
  expect(answer.choice).toBe("dev");
  expect(answer.confidence).toBe(0.53);
  expect(answer.usage).toEqual({ input: 120, output: 0 });
  expect(asked).toMatchObject({ model: "fake", state: "add vim motions to threads", questions: { pick: { type: "choice", criteria: { dev: "maxflow development" } } } });
});

test("a refused call carries its status and never the key", async () => {
  using server = Bun.serve({ port: 0, fetch: (req) => new Response(`rate limited for ${req.headers.get("authorization") ?? ""}`, { status: 429 }) });
  const refused = routeObjective({ url: server.url.origin, key: "sk-secret", model: "fake", sources: new Set(["isaac"]) }, "hello", []);
  expect(refused).rejects.toBeInstanceOf(JevCallError);
  const error = await refused.catch((caught: unknown) => caught);
  expect(error).toMatchObject({ status: 429 });
  expect(String(error)).not.toContain("sk-secret");
});
