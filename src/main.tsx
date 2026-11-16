import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startLive } from "./live";
import { loadLocalMock } from "./store";

await startLive();
await loadLocalMock();
createRoot(document.getElementById("root")!).render(<App />);
