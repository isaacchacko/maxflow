import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// constraint: bun test shares one module cache across files, so whichever file loads timelines.ts first fixes its folder for all of them
const scratch = mkdtempSync(join(tmpdir(), "yarn-test-timelines-"));
process.env["YARN_TIMELINES"] = join(scratch, "Timelines");
process.env["YARN_TIMELINES_REMOTE"] = "";
