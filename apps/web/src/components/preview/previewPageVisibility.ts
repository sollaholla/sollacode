import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const pageVisible = () => document.visibilityState === "visible";
const pageVisibleOnServer = () => false;

/** Remote media is only useful while the browser itself is in the foreground. */
export function usePreviewPageVisible() {
  return useSyncExternalStore(subscribe, pageVisible, pageVisibleOnServer);
}
