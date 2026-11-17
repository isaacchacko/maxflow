import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startLive } from "./live";
import { loadLocalMock } from "./store";

// yarn installs as an app (src/pwa): the manifest is linked here because Bun's HTML bundler would try to bundle it from index.html,
// and the worker caches nothing. Before the awaits below, so the app is installable even while the live data loads.
document.head.append(Object.assign(document.createElement("link"), { rel: "manifest", href: "/manifest.webmanifest" }));
navigator.serviceWorker?.register("/sw.js").catch(() => {});

await startLive();
await loadLocalMock();
createRoot(document.getElementById("root")!).render(<App />);
