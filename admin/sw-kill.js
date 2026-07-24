/* NexMoney back office — SERVICE WORKER KILL-SWITCH.
 * ROLLBACK PROCEDURE (2 minutes): if a deployed sw.js ever misbehaves,
 * copy this file over admin/sw.js and deploy. On each user's next visit it
 * replaces the bad worker, unregisters itself, wipes every cache, and
 * reloads their tabs onto the plain network-served app. Do NOT just delete
 * sw.js from the server — installed workers on devices would keep running.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* best effort */ }
    try { await self.registration.unregister(); } catch (e) { /* best effort */ }
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((c) => { try { c.navigate(c.url); } catch (e) { /* best effort */ } });
  })());
});
