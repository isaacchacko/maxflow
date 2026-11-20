import { afterAll, expect, test } from "bun:test";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const instance = throwawayInstance("yarn-notify-plain-");
const server = startServerWithoutSentries(instance);

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
});

test("notify to a session that isn't an agent is refused, saying nothing reads it", async () => {
  await waitUntilAnswering(instance, server);
  const made = await fetch(`${instance.base}/api/sessions`, withTimeout({ method: "POST", body: JSON.stringify({ name: "plain", cmd: ["sh"], cwd: instance.home }) }));
  expect(made.status).toBe(201);
  const { id } = (await made.json()) as { id: string };
  const notified = await fetch(`${instance.base}/api/sessions/${id}/notify`, withTimeout({ method: "POST", body: JSON.stringify({ text: "stand down on app#1" }) }));
  expect(notified.status).toBe(409);
  expect(await notified.text()).toContain("nothing reads text sent to it");
});
