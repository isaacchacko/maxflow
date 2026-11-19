import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DIR } from "./instance";

export const LOG = "/tmp/maxflow-v2.log";
const IS_MAC = process.platform === "darwin";
export const LABEL = IS_MAC ? "com.isaacchacko.maxflow-v2" : "maxflow-v2.service";
const LAUNCHD_PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const SYSTEMD_UNIT = join(homedir(), ".config/systemd/user", LABEL);
const LAUNCHD_DOMAIN = `gui/${String(userInfo().uid)}`;
const LAUNCHD_SERVICE = `${LAUNCHD_DOMAIN}/${LABEL}`;

// constraint: systemctl --user needs the user's bus, which a shell outside the login session (ssh, tmux started elsewhere) may not carry
const env = { ...process.env, XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${String(userInfo().uid)}` };
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { env });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};

export function isLoaded() {
  return IS_MAC ? run(["launchctl", "print", LAUNCHD_SERVICE]).ok : run(["systemctl", "--user", "is-enabled", LABEL]).ok;
}

function launchdStatus() {
  const out = run(["launchctl", "print", LAUNCHD_SERVICE]).out;
  const field = (key: string) => new RegExp(String.raw`^\s*${key} = (.+)$`, "m").exec(out)?.[1];
  return { runs: field("runs"), lastExit: field("last exit code"), text: out.split("\n").filter((l) => /state =|runs =|last exit|pid =/.test(l)).join("\n") };
}

export function status() {
  if (IS_MAC) return launchdStatus();
  const out = run(["systemctl", "--user", "show", LABEL, "-p", "ActiveState,SubState,NRestarts,ExecMainStatus,ExecMainPID"]).out;
  const field = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(out)?.[1];
  return { runs: field("NRestarts"), lastExit: field("ExecMainStatus"), text: out.trim() };
}

export function checkout() {
  const file = IS_MAC ? LAUNCHD_PLIST : SYSTEMD_UNIT;
  if (!existsSync(file)) return;
  return (IS_MAC ? /<key>WorkingDirectory<\/key><string>([^<]+)</ : /^WorkingDirectory=(.+)$/m).exec(readFileSync(file, "utf8"))?.[1];
}

export const restartCommand = IS_MAC ? `launchctl kickstart -k gui/$(id -u)/${LABEL}` : `systemctl --user restart ${LABEL}`;

const LAUNCHD_BOOTOUT_POLLS = 20;

function installLaunchd(bun: string, path: string, sentriesToRun: string) {
  mkdirSync(join(LAUNCHD_PLIST, ".."), { recursive: true });
  writeFileSync(LAUNCHD_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${bun}</string><string>server.ts</string></array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string>${sentriesToRun ? `<key>MAXFLOW_SENTRIES</key><string>${sentriesToRun}</string>` : ""}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Stopping the server must leave its tmux sessions (every agent, the health sentry, a Chrome started from a pane) running. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`);
  run(["launchctl", "bootout", LAUNCHD_SERVICE]);
  // constraint: launchctl bootout returns before the old job is gone, and bootstrapping over it fails with an I/O error
  for (let i = 0; i < LAUNCHD_BOOTOUT_POLLS && run(["launchctl", "print", LAUNCHD_SERVICE]).ok; i++) Bun.sleepSync(250);
  return run(["launchctl", "bootstrap", LAUNCHD_DOMAIN, LAUNCHD_PLIST]);
}

function installSystemd(bun: string, path: string, sentriesToRun: string) {
  mkdirSync(join(SYSTEMD_UNIT, ".."), { recursive: true });
  writeFileSync(SYSTEMD_UNIT, `[Unit]
Description=maxflow v2

[Service]
WorkingDirectory=${DIR}
ExecStart=${bun} server.ts
Environment=PATH=${path}
${sentriesToRun ? `Environment=MAXFLOW_SENTRIES=${sentriesToRun}\n` : ""}Restart=always
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

export function install(sentriesToRun = process.env["MAXFLOW_SENTRIES"] ?? "") {
  const bun = process.execPath;
  const path = `${join(bun, "..")}:${process.env["PATH"] ?? ""}`;
  return IS_MAC ? installLaunchd(bun, path, sentriesToRun) : installSystemd(bun, path, sentriesToRun);
}
