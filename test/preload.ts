import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// constraint: bun test shares one module cache across files, so whichever file loads timelines.ts first fixes its folder for all of them
process.env["YARN_TIMELINES"] = join(mkdtempSync(join(tmpdir(), "yarn-test-timelines-")), "Timelines");
process.env["YARN_TIMELINES_REMOTE"] = "";
