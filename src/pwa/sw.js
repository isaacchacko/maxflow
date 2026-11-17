// yarn's service worker exists only so Chrome offers to install yarn as an app. It caches nothing and has no fetch handler, so
// every request goes to the server as if it weren't here, and a live reload always shows the new code.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
