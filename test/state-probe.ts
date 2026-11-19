import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../instance";
import { isRecord } from "../shared/guards";
import { peekStateJson, readGatingStateJson, readStateJson } from "../state";

const put = (name: string, text: string) => {
  writeFileSync(join(STATE_DIR, name), text);
};
const has = (name: string) => readdirSync(STATE_DIR).includes(name);
const keptCopies = (name: string) => readdirSync(STATE_DIR).filter((f) => f.startsWith(`${name}.corrupt-`));
const keptText = (name: string) => readFileSync(join(STATE_DIR, keptCopies(name)[0] ?? name), "utf8");

function gatingError(name: string) {
  try {
    readGatingStateJson(name, isRecord);
    return "";
  } catch (error) {
    return String(error);
  }
}

put("ok.json", JSON.stringify({ a: 1 }));
put("broken.json", "{oops");
put("shape.json", "[1, 2]");
put("gate.json", "{oops");
put("theirs.json", "{oops");

const observed = {
  valid: readStateJson("ok.json", isRecord),
  missing: readStateJson("missing.json", isRecord) ?? "undefined",
  gatingMissing: readGatingStateJson("missing.json", isRecord) ?? "undefined",
  broken: readStateJson("broken.json", isRecord) ?? "undefined",
  brokenKept: keptCopies("broken.json").length,
  brokenKeptText: keptText("broken.json"),
  brokenStillThere: has("broken.json"),
  shape: readStateJson("shape.json", isRecord) ?? "undefined",
  shapeKept: keptCopies("shape.json").length,
  gatingError: gatingError("gate.json"),
  gateStillThere: has("gate.json"),
  gateKept: keptCopies("gate.json").length,
  peek: peekStateJson("theirs.json") ?? "undefined",
  theirsStillThere: has("theirs.json"),
};
console.log(JSON.stringify(observed));
