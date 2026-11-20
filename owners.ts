import { DIR } from "./instance";
import type { Role, Session } from "./sessions";
import { isRecord } from "./shared/guards";
import { readStateJson, writeStateJson } from "./state";

// constraint: behind a switch while objectives and routers still run; new threads get owners only once it is on (docs: yarn/thread-owners.md)
export const OWNERS_FILE = "thread-owners.json";
export const OWNER_BRIEF = `${DIR}/agents/owner.md`;
export type OwnersSwitch = { on: boolean; at: number };

const isSwitch = (value: unknown): value is OwnersSwitch => isRecord(value) && typeof value["on"] === "boolean";

export const owners = (): OwnersSwitch => readStateJson(OWNERS_FILE, isSwitch) ?? { on: false, at: 0 };
export const areOwnersOn = () => owners().on;

export function setOwners(isOn: boolean): OwnersSwitch {
  const next = { on: isOn, at: Date.now() };
  writeStateJson(OWNERS_FILE, next);
  return next;
}

export const isOwner = (s: Session | undefined): s is Session & { role: Role & { role: "owner" } } => s?.role?.role === "owner";
export const ownerRole = (thread: string): Role => ({ role: "owner", objective: "", thread });

export const ROUTERS_RETIRED = "Thread owners are on: objectives are labels now and no new router starts. Give the signal to an open thread's owner with `route <seq> --thread <thread id>`, or start a fresh owner with `size <seq> owner --cwd <dir> --name '<root>'`.";
