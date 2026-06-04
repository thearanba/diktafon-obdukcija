// Minimalni service worker — samo da PWA bude installable
// Ne kešira ništa jer je app uglavnom server-driven
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => self.clients.claim());
self.addEventListener("fetch", () => {});
