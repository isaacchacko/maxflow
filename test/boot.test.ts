import { afterAll, expect, test } from "bun:test";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const instance = throwawayInstance("maxflow-boot-");
const instanceServer = { process: startServerWithoutSentries(instance) };
const shellSleep = (seconds: number) => ["sh", "-c", `sleep ${seconds}`];

afterAll(async () => {
  await stopByPidAndSocket(instance, instanceServer.process);
});

const up = async () => waitUntilAnswering(instance, instanceServer.process);
const postSession = async (name: string, sleepSeconds: number) => {
  const body = JSON.stringify({ name, cmd: shellSleep(sleepSeconds), cwd: instance.home });
  return fetch(`${instance.base}/api/sessions`, withTimeout({ method: "POST", body }));
};
const makeSleepingSession = async (name: string) => (await (await postSession(name, 60)).json()) as { id: string };
const listSessions = async () => (await (await fetch(`${instance.base}/api/sessions`, withTimeout())).json()) as { id: string; name: string }[];

test("a fresh instance boots and answers", async () => {
  await up();
  expect(await listSessions()).toEqual([]);
  const world = await fetch(`${instance.base}/api/world`, withTimeout());
  expect(world.status).toBe(200);
  expect(await world.json()).toBeObject();
  expect((await fetch(`${instance.base}/`, withTimeout())).status).toBe(200);
}, 30_000);

test("it starts a session in tmux and lists it", async () => {
  const res = await postSession("boot-test", 30);
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect((await listSessions()).map((s) => [s.id, s.name])).toEqual([[id, "boot-test"]]);
  expect(Bun.spawnSync(["tmux", "-L", instance.socket, "has-session", "-t", `mf-${id}`]).exitCode).toBe(0);
}, 30_000);

test("a session made or renamed just before a restart comes back with its name", async () => {
  const made = await makeSleepingSession("made-before-restart");
  const renamed = await makeSleepingSession("old-name");
  await fetch(`${instance.base}/api/sessions/${renamed.id}`, withTimeout({ method: "PATCH", body: JSON.stringify({ name: "renamed-before-restart" }) }));
  instanceServer.process.kill("SIGTERM");
  await instanceServer.process.exited;
  instanceServer.process = startServerWithoutSentries(instance);
  await up();
  const listed = await listSessions();
  expect(listed.find((s) => s.id === made.id)?.name).toBe("made-before-restart");
  expect(listed.find((s) => s.id === renamed.id)?.name).toBe("renamed-before-restart");
}, 60_000);
