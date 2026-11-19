import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIR } from "./instance";

// The live maxflow runs as a login service so it outlives any shell: a launchd agent on macOS, a systemd user unit on Linux.
export const LOG = "/tmp/maxflow-v2.log";
const MAC = process.platform === "darwin";
export const LABEL = MAC ? "com.isaacchacko.maxflow-v2" : "maxflow-v2.service";
const PLIST = join(process.env.HOME!, "Library/LaunchAgents", `${LABEL}.plist`);
const UNIT = join(process.env.HOME!, ".config/systemd/user", LABEL);

// systemctl --user needs the user's bus, which a shell outside the login session (ssh, tmux started elsewhere) may not carry.
const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}` };
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { env });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};

// Loaded means the service manager still means to run it; unloading it on purpose counts as meant to be down.
export function loaded() {
  return MAC ? run(["launchctl", "print", `gui/${process.getuid!()}/${LABEL}`]).ok : run(["systemctl", "--user", "is-enabled", LABEL]).ok;
}

// The few lines of the service manager's status worth showing on the down page and to a recovery agent.
export function status() {
  if (MAC) {
    const out = run(["launchctl", "print", `gui/${process.getuid!()}/${LABEL}`]).out;
    const field = (k: string) => out.match(new RegExp(`^\\s*${k} = (.+)$`, "m"))?.[1];
    return { runs: field("runs"), lastExit: field("last exit code"), text: out.split("\n").filter((l) => /state =|runs =|last exit|pid =/.test(l)).join("\n") };
  }
  const out = run(["systemctl", "--user", "show", LABEL, "-p", "ActiveState,SubState,NRestarts,ExecMainStatus,ExecMainPID"]).out;
  const field = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
  return { runs: field("NRestarts"), lastExit: field("ExecMainStatus"), text: out.trim() };
}

// The checkout the installed service runs from, whichever checkout asks.
export function checkout() {
  const file = MAC ? PLIST : UNIT;
  return existsSync(file) ? readFileSync(file, "utf8").match(MAC ? /<key>WorkingDirectory<\/key><string>([^<]+)</ : /^WorkingDirectory=(.+)$/m)?.[1] : undefined;
}

export const restartCommand = MAC ? `launchctl kickstart -k gui/$(id -u)/${LABEL}` : `systemctl --user restart ${LABEL}`;

// Writes and starts the service, running `bun server.ts` from this checkout (Bun reads its Tailwind plugin from bunfig.toml here).
// sentries: MAXFLOW_SENTRIES for the service, when it should run fewer than all of them.
export function install(sentries = process.env.MAXFLOW_SENTRIES) {
  const bun = process.execPath;
  const path = `${join(bun, "..")}:${process.env.PATH}`;
  if (MAC) {
    mkdirSync(join(PLIST, ".."), { recursive: true });
    writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${bun}</string><string>server.ts</string></array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string>${sentries ? `<key>MAXFLOW_SENTRIES</key><string>${sentries}</string>` : ""}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Stopping the server must leave its tmux sessions (every agent, the health sentry, a Chrome started from a pane) running. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`);
    run(["launchctl", "bootout", `gui/${process.getuid!()}/${LABEL}`]);
    // bootout returns before the old job is gone, and bootstrapping over it fails with an I/O error.
    for (let i = 0; i < 20 && run(["launchctl", "print", `gui/${process.getuid!()}/${LABEL}`]).ok; i++) Bun.sleepSync(250);
    return run(["launchctl", "bootstrap", `gui/${process.getuid!()}`, PLIST]);
  }
  mkdirSync(join(UNIT, ".."), { recursive: true });
  writeFileSync(UNIT, `[Unit]
Description=maxflow v2

[Service]
WorkingDirectory=${DIR}
ExecStart=${bun} server.ts
Environment=PATH=${path}
${sentries ? `Environment=MAXFLOW_SENTRIES=${sentries}\n` : ""}Restart=always
RestartSec=2
# Stopping the server must leave its tmux sessions (every agent, and the health sentry) running.
KillMode=process
StandardOutput=append:${LOG}
StandardError=append:${LOG}

[Install]
WantedBy=default.target
`);
  run(["systemctl", "--user", "daemon-reload"]);
  return run(["systemctl", "--user", "enable", "--now", LABEL]);
}
