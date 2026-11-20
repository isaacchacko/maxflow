import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../shared/guards";
import { peekStateJson, readGatingStateJson, readStateJson } from "../state";

const probeDir = join(process.env["HOME"] ?? "", ".yarn-v2-statetest");

const put = (name: string, text: string) => {
  writeFileSync(join(probeDir, name), text);
};
const isListed = (name: string) => readdirSync(probeDir).includes(name);
const keptCopies = (name: string) => readdirSync(probeDir).filter((f) => f.startsWith(`${name}.corrupt-`));
const keptText = (name: string) => readFileSync(join(probeDir, keptCopies(name)[0] ?? name), "utf8");

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
  brokenStillThere: isListed("broken.json"),
  shape: readStateJson("shape.json", isRecord) ?? "undefined",
  shapeKept: keptCopies("shape.json").length,
  gatingError: gatingError("gate.json"),
  gateStillThere: isListed("gate.json"),
  gateKept: keptCopies("gate.json").length,
  peek: peekStateJson("theirs.json") ?? "undefined",
  theirsStillThere: isListed("theirs.json"),
};
console.log(JSON.stringify(observed));
