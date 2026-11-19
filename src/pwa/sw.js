/// <reference lib="webworker" />
// constraint: it exists only so Chrome offers to install yarn; it caches nothing and has no fetch handler, so a reload always shows new code
const worker = globalThis;
if (worker instanceof globalThis.ServiceWorkerGlobalScope) {
  worker.addEventListener("install", () => {
    void worker.skipWaiting();
  });
  worker.addEventListener("activate", (event) => {
    if (event instanceof globalThis.ExtendableEvent) event.waitUntil(worker.clients.claim());
  });
}
