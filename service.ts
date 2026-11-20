import { LEGACY_SERVICE, yarnEnv } from "./shared/legacy-maxflow";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DIR } from "./instance";

const IS_MAC = process.platform === "darwin";
const YARN_SERVICE = { mac: "com.isaacchacko.yarn", linux: "yarn.service", log: "/tmp/yarn.log" };
const fileOf = (label: string) => (IS_MAC ? join(homedir(), "Library/LaunchAgents", `${label}.plist`) : join(homedir(), ".config/systemd/user", label));
const labelOf = (service: typeof YARN_SERVICE) => (IS_MAC ? service.mac : service.linux);
const isOnlyLegacyInstalled = !existsSync(fileOf(labelOf(YARN_SERVICE))) && existsSync(fileOf(labelOf(LEGACY_SERVICE)));
const INSTALLED = isOnlyLegacyInstalled ? LEGACY_SERVICE : YARN_SERVICE;
export const LOG = INSTALLED.log;
export const LABEL = labelOf(INSTALLED);
const LAUNCHD_DOMAIN = `gui/${String(userInfo().uid)}`;
const launchdService = (label: string) => `${LAUNCHD_DOMAIN}/${label}`;
const LAUNCHD_SERVICE = launchdService(LABEL);

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
  const file = fileOf(LABEL);
  if (!existsSync(file)) return;
  return (IS_MAC ? /<key>WorkingDirectory<\/key><string>([^<]+)</ : /^WorkingDirectory=(.+)$/m).exec(readFileSync(file, "utf8"))?.[1];
}

export const restartCommand = IS_MAC ? `launchctl kickstart -k gui/$(id -u)/${LABEL}` : `systemctl --user restart ${LABEL}`;

const LAUNCHD_BOOTOUT_POLLS = 20;

function bootoutLaunchd(label: string) {
  run(["launchctl", "bootout", launchdService(label)]);
  // constraint: launchctl bootout returns before the old job is gone, and bootstrapping over it fails with an I/O error
  for (let i = 0; i < LAUNCHD_BOOTOUT_POLLS && run(["launchctl", "print", launchdService(label)]).ok; i++) Bun.sleepSync(250);
}

function installLaunchd(bun: string, path: string, sentriesToRun: string) {
  const label = YARN_SERVICE.mac;
  const plist = fileOf(label);
  mkdirSync(join(plist, ".."), { recursive: true });
  /* eslint-disable unicorn/prefer-https -- Apple's plist DOCTYPE system identifier is this exact http URL; launchd matches it as text */
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${bun}</string><string>server.ts</string></array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string>${sentriesToRun ? `<key>YARN_SENTRIES</key><string>${sentriesToRun}</string>` : ""}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Stopping the server must leave its tmux sessions (every agent, the health sentry, a Chrome started from a pane) running. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${YARN_SERVICE.log}</string>
  <key>StandardErrorPath</key><string>${YARN_SERVICE.log}</string>
</dict></plist>
`);
  /* eslint-enable unicorn/prefer-https */
  for (const old of [LEGACY_SERVICE.mac, label]) bootoutLaunchd(old);
  rmSync(fileOf(LEGACY_SERVICE.mac), { force: true });
  return run(["launchctl", "bootstrap", LAUNCHD_DOMAIN, plist]);
}

function installSystemd(bun: string, path: string, sentriesToRun: string) {
  const label = YARN_SERVICE.linux;
  const unit = fileOf(label);
  mkdirSync(join(unit, ".."), { recursive: true });
  writeFileSync(unit, `[Unit]
Description=yarn v2

[Service]
WorkingDirectory=${DIR}
ExecStart=${bun} server.ts
Environment=PATH=${path}
${sentriesToRun ? `Environment=YARN_SENTRIES=${sentriesToRun}\n` : ""}Restart=always
RestartSec=2
# Stopping the server must leave its tmux sessions (every agent, and the health sentry) running.
KillMode=process
StandardOutput=append:${YARN_SERVICE.log}
StandardError=append:${YARN_SERVICE.log}

[Install]
WantedBy=default.target
`);
  if (existsSync(fileOf(LEGACY_SERVICE.linux))) run(["systemctl", "--user", "disable", "--now", LEGACY_SERVICE.linux]);
  rmSync(fileOf(LEGACY_SERVICE.linux), { force: true });
  run(["systemctl", "--user", "daemon-reload"]);
  return run(["systemctl", "--user", "enable", "--now", label]);
}

export function install(sentriesToRun = yarnEnv("SENTRIES") ?? "") {
  const bun = process.execPath;
  const path = `${join(bun, "..")}:${process.env["PATH"] ?? ""}`;
  return IS_MAC ? installLaunchd(bun, path, sentriesToRun) : installSystemd(bun, path, sentriesToRun);
}
