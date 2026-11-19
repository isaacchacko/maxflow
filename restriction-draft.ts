import type { Call, Exception, Person, Restriction } from "./shared/restrictions-types";
import { MODES } from "./restrictions";
import { isRecord } from "./shared/guards";
import { type Body, flagOf, textOf, textsOf } from "./route-kit";

const REACHES = ["slack", "email", "github"] as const;
const EXCEPTIONS = ["people", "objective", "repo"] as const;
const NAMING_REFUSALS_CHECKED_BEFORE_REACHES = new Set(["label required", "action required", `mode: one of ${MODES.join(", ")}`]);

const isException = (value: unknown): value is Exception => EXCEPTIONS.some((e) => e === value);
const UNSET = new Set<unknown>([undefined, null, ""]);
const isSet = (value: unknown) => !UNSET.has(value);

function personOf(value: unknown): Person {
  if (!isRecord(value)) return {};
  const [name, slack, email, github] = ["name", "slack", "email", "github"].map((key) => textOf(value, key));
  const team = flagOf(value, "team");
  return { ...(name !== undefined && { name }), ...(slack !== undefined && { slack }), ...(email !== undefined && { email }), ...(github !== undefined && { github }), ...(team !== undefined && { team }) };
}

const peopleOf = (value: unknown): Person[] | undefined => (Array.isArray(value) ? value.map(personOf) : undefined);

export function matchOf(value: unknown): Restriction["match"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return {};
  const [tools, bash, paths] = ["tools", "bash", "paths"].map((key) => textsOf(value, key));
  return { ...(tools !== undefined && { tools }), ...(bash !== undefined && { bash }), ...(paths !== undefined && { paths }) };
}

function scopeOf(value: unknown): Restriction["scope"] {
  if (!isRecord(value)) return undefined;
  const objective = textOf(value, "objective");
  const cwd = textOf(value, "cwd");
  const people = peopleOf(value["people"]);
  return { ...(objective !== undefined && { objective }), ...(cwd !== undefined && { cwd }), ...(people !== undefined && { people }) };
}

function textFieldsOf(body: Body) {
  const [id, action, label, parent, forPerson, about, noun, note] = ["id", "action", "label", "parent", "forPerson", "about", "noun", "note"].map((key) => textOf(body, key));
  return {
    ...(id !== undefined && { id }),
    ...(action !== undefined && { action }),
    ...(label !== undefined && { label }),
    ...(parent !== undefined && { parent }),
    ...(forPerson !== undefined && { forPerson }),
    ...(about !== undefined && { about }),
    ...(noun !== undefined && { noun }),
    ...(note !== undefined && { note }),
  };
}

export function restrictionDraftOf(body: Body): Partial<Restriction> {
  const mode = MODES.find((m) => m === body["mode"]);
  const reaches = REACHES.find((r) => r === body["reaches"]);
  const match = matchOf(body["match"]);
  const scope = scopeOf(body["scope"]);
  const examples = textsOf(body, "examples");
  const askedExceptions: unknown = body["exceptions"];
  const exceptions = Array.isArray(askedExceptions) ? askedExceptions.filter(isException) : undefined;
  const builtin = flagOf(body, "builtin");
  return {
    ...textFieldsOf(body),
    ...(mode !== undefined && { mode }),
    ...(reaches !== undefined && { reaches }),
    ...(match !== undefined && { match }),
    ...(scope !== undefined && { scope }),
    ...(examples !== undefined && { examples }),
    ...(exceptions !== undefined && { exceptions }),
    ...(builtin !== undefined && { builtin }),
  };
}

export const isModeUnknown = (body: Body) => body["mode"] !== undefined && MODES.every((m) => m !== body["mode"]);
const isReachesUnknown = (body: Body) => isSet(body["reaches"]) && REACHES.every((r) => r !== body["reaches"]);

export function refusalInValidationOrder(body: Body, refusal: string | undefined): string | undefined {
  if (isReachesUnknown(body) && (refusal === undefined || !NAMING_REFUSALS_CHECKED_BEFORE_REACHES.has(refusal))) return "reaches: slack, email or github";
  return refusal;
}

export function callOf(value: unknown): Call {
  if (!isRecord(value)) return { tool: "" };
  const input = value["input"];
  const [cwd, objective] = [textOf(value, "cwd"), textOf(value, "objective")];
  const people = peopleOf(value["people"]);
  return {
    tool: textOf(value, "tool") ?? "",
    ...(isRecord(input) && { input }),
    ...(cwd !== undefined && { cwd }),
    ...(objective !== undefined && { objective }),
    ...(people !== undefined && { people }),
  };
}
