import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startLive } from "./live";
import { loadLocalMock } from "./store";
import { installIsaacFetch } from "./lib/isaac";

// constraint: Bun's HTML bundler would bundle a manifest linked from index.html, so it is linked here, before the awaits
document.head.append(Object.assign(document.createElement("link"), { rel: "manifest", href: "/manifest.webmanifest" }));

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // constraint: registering fails outside a secure context; the app runs without being installable
  }
}
void registerServiceWorker();
installIsaacFetch();

await startLive();
await loadLocalMock();
const root = document.querySelector("#root");
if (!root) throw new Error("index.html has no #root");
createRoot(root).render(<App />);
