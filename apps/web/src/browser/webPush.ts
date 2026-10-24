/** This flag only suppresses duplicate foreground alerts; the host owns delivery. */
export function setBrowserPushEnabled(environmentId: string, enabled: boolean) {
  try {
    localStorage.setItem(`solla:web-push:${environmentId}`, String(enabled));
  } catch {
    /* private browsing */
  }
}

export function isBrowserPushEnabled(environmentId: string): boolean {
  try {
    return (
      Notification.permission === "granted" &&
      localStorage.getItem(`solla:web-push:${environmentId}`) === "true"
    );
  } catch {
    return false;
  }
}

export function browserPushUnavailableReason(): string | null {
  if (typeof window === "undefined") return "Push notifications are available in the browser.";
  if (window.desktopBridge) return "Use desktop agent alerts in the installed app.";
  if (!window.isSecureContext)
    return "Open Solla Code through an HTTPS address, such as your Tailscale link, to enable push notifications.";
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && !window.matchMedia("(display-mode: standalone)").matches) {
    return "On iPhone or iPad, tap Share → Add to Home Screen, open Solla Code from that icon, then enable notifications here.";
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "This browser does not support Web Push. Use a supported browser or a Home Screen web app.";
  if (Notification.permission === "denied")
    return "Notifications are blocked. Allow them in your device or browser notification settings, then reopen this page.";
  return null;
}

export async function currentBrowserPushSubscription() {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration?.pushManager ? registration.pushManager.getSubscription() : null;
}

/** Call from the user's tap: Safari requires permission to be requested synchronously. */
export async function enableBrowserPush(publicKey: string) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  await navigator.serviceWorker.register("/web-push-worker.js", {
    scope: "/",
    updateViaCache: "none",
  });
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const raw = atob(publicKey.replaceAll("-", "+").replaceAll("_", "/"));
  const applicationServerKey = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  if (existing) {
    const previous = existing.options.applicationServerKey;
    if (
      previous &&
      previous.byteLength === applicationServerKey.byteLength &&
      new Uint8Array(previous).every((byte, index) => byte === applicationServerKey[index])
    )
      return existing;
    await existing.unsubscribe();
  }
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}
