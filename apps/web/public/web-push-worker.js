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

// An agent ringing: stays up until handled, alerts again when the same call's
// notification is replaced, and buzzes like a phone where the platform allows.
const CALL_NOTIFICATION_OPTIONS = {
  requireInteraction: true,
  renotify: true,
  vibrate: [500, 250, 500, 250, 500, 250, 500],
};
// A ring that stopped (answered, declined, cancelled) replaces the ringing
// notification under the same tag without a sound. Browsers check what a push
// left on screen once its event settles and penalise one that shows nothing,
// so the event waits only for the notice; clearing it 4 s later is best
// effort, and where the worker is suspended first the quiet notice stays.
const CALL_ENDED_NOTIFICATION_OPTIONS = { silent: true };
const CALL_ENDED_LINGER_MS = 4000;

async function closeNotifications(filter, shouldClose) {
  if (typeof self.registration.getNotifications !== "function") return;
  const shown = await self.registration.getNotifications(filter).catch(() => []);
  for (const notification of shown) if (shouldClose(notification)) notification.close();
}

// A ring whose call never reported an ending (the host restarted mid-ring)
// would stay up for good; any later push clears it once its ring is over.
function closeExpiredRings() {
  const now = Date.now();
  return closeNotifications(
    undefined,
    (notification) =>
      notification.data?.kind === "call" && Date.parse(notification.data?.expiresAt) <= now,
  ).catch(() => undefined);
}

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {}
  const title = typeof data?.title === "string" ? data.title.slice(0, 120) : "Solla Code";
  const tag = typeof data?.tag === "string" ? data.tag : "solla-notification";
  const kind = typeof data?.kind === "string" ? data.kind : undefined;
  const expiresAt = typeof data?.expiresAt === "string" ? data.expiresAt : undefined;
  // `kind` lets an open page tell a ring from the missed-call notice that
  // replaces it; `expiresAt` lets a later push clear a stranded ring.
  const showing = closeExpiredRings().then(() =>
    self.registration.showNotification(title, {
      body:
        typeof data?.body === "string"
          ? data.body.slice(0, 300)
          : "Open Solla Code to view your notifications.",
      icon: "/solla-code-mark.png",
      tag,
      data: {
        url: localNotificationUrl(data?.path),
        ...(kind === undefined ? {} : { kind }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
      ...(kind === "call" ? CALL_NOTIFICATION_OPTIONS : {}),
      ...(kind === "call-ended" ? CALL_ENDED_NOTIFICATION_OPTIONS : {}),
    }),
  );
  event.waitUntil(showing);
  if (kind !== "call-ended") return;
  showing
    .then(() =>
      setTimeout(
        () => void closeNotifications({ tag }, () => true).catch(() => undefined),
        CALL_ENDED_LINGER_MS,
      ),
    )
    .catch(() => undefined);
});

// Same-origin pages the server serves itself (file views, sign-in) do not run
// the app, so nothing there would follow a navigation message.
const SERVER_PAGE_PREFIXES = ["/api/", "/oauth", "/.well-known"];

function runsTheApp(client) {
  const url = new URL(client.url);
  return (
    url.origin === self.location.origin &&
    !SERVER_PAGE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  );
}

// A tap opens the notification's page. An open app window is asked to route
// there itself rather than navigated, which would reload it and drop a live
// call; with none, a new window opens.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = localNotificationUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (!runsTheApp(client)) continue;
        try {
          // eslint-disable-next-line unicorn/require-post-message-target-origin -- Client.postMessage takes a transfer list, not a target origin.
          client.postMessage({ type: "solla-navigate", url: target });
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
