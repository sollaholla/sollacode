import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { serviceWorkerNavigationPath } from "./webPush";

/**
 * Follows the push worker's notification taps in place: the worker posts the
 * target to an open window instead of navigating it, so a tapped notification
 * never reloads the page (and never drops a call in progress).
 */
export function useServiceWorkerNavigation(): void {
  const router = useRouter();
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent<unknown>) => {
      const path = serviceWorkerNavigationPath(event.data, window.location.origin);
      if (path !== null) void router.navigate({ href: path });
    };
    container.addEventListener("message", onMessage);
    // Listening alone does not open the queue in every browser.
    container.startMessages();
    return () => container.removeEventListener("message", onMessage);
  }, [router]);
}
