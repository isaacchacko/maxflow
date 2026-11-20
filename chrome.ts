import { yarnEnv } from "./shared/legacy-maxflow";
import { existsSync } from "node:fs";

const CHROMES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

export function chromeBinary(): string | undefined {
  const chosen = yarnEnv("CHROME");
  if (chosen !== undefined && chosen !== "") return chosen;
  return (CHROMES[process.platform] ?? []).find((path) => existsSync(path));
}
