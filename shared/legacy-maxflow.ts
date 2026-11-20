// constraint: yarn was called maxflow, and live sessions, transcripts and stored rows still carry the old name; drop these once none do

const filled = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

export const yarnEnv = (name: string) => filled(process.env[`YARN_${name}`]) ?? filled(process.env[`MAXFLOW_${name}`]);

export const bothEnvNames = (name: string) => [`YARN_${name}`, `MAXFLOW_${name}`];

export const callerOf = (req: Request) => req.headers.get("x-yarn-from") ?? req.headers.get("x-maxflow-from") ?? "";

// constraint: a sentry still on the old code reads x-maxflow-seq until the deploy restarts it, and without it would replay the log from 0
export const seqHeaders = (seq: string) => ({ "x-yarn-seq": seq, "x-maxflow-seq": seq });

export const seqOf = (res: Response) => res.headers.get("x-yarn-seq") ?? res.headers.get("x-maxflow-seq");

export const isStamped = (text: string) => text.startsWith("[yarn") || text.startsWith("[maxflow");

export const BEFORE_A_STAMP = /\n(?=\[(?:yarn|maxflow))/;

export const FORGEABLE_STAMPS = ["[yarn · verified", "[yarn · Isaac", "[maxflow · verified", "[maxflow · Isaac"];

export const SCREENSHOT_STAMP = /^\[(?:yarn|maxflow) · screenshot\].*$/gm;

export const renamedSource = <T extends string>(source: T) => (source === "maxflow" ? "yarn" : source);

export const noSessionEnv = () => Object.fromEntries(bothEnvNames("SESSION").map((key) => [key, ""]));

export const LEGACY_STATE_DIR = ".maxflow-v2";

export const LEGACY_CHECKOUT = "maxflow-v2";

export const LEGACY_SERVICE = { mac: "com.isaacchacko.maxflow-v2", linux: "maxflow-v2.service", log: "/tmp/maxflow-v2.log" };
