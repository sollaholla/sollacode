// Push only: no fetch handler or app-shell caching, so releases load normally.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function localNotificationUrl(path) {
  try {
    const url = new URL(typeof path === "string" ? path : "/", self.location.origin);
    if (url.origin === self.location.origin && !url.username && !url.password) return url.href;
  } catch {}
  return self.location.origin + "/";
}

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {}
  event.waitUntil(
    self.registration.showNotification(
      typeof data?.title === "string" ? data.title.slice(0, 120) : "Solla Code",
      {
        body:
          typeof data?.body === "string"
            ? data.body.slice(0, 300)
            : "Open Solla Code to view your notifications.",
        icon: "/solla-code-mark.png",
        tag: typeof data?.tag === "string" ? data.tag : "solla-notification",
        data: { url: localNotificationUrl(data?.path) },
      },
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = localNotificationUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          if (client.url !== target) await client.navigate(target);
          await client.focus();
          return;
        } catch {
          /* A closing window may disappear between lookup and focus. */
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
