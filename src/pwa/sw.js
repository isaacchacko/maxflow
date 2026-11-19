// constraint: it exists only so Chrome offers to install yarn; it caches nothing and has no fetch handler, so a reload always shows new code
globalThis.addEventListener("install", () => globalThis.skipWaiting());
globalThis.addEventListener("activate", (e) => e.waitUntil(globalThis.clients.claim()));
