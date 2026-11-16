import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadLocalMock } from "./store";

await loadLocalMock();
createRoot(document.getElementById("root")!).render(<App />);
