import { useLocation, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

/** The screen settings was opened from: its entry in the browser's history, and its address. */
export interface SettingsReturn {
  readonly index: number;
  readonly href: string;
}

let settingsReturn: SettingsReturn | null = null;

export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** Records every screen outside settings, so closing settings can return to it. */
export function useRememberSettingsReturn(): void {
  const location = useLocation();
  useEffect(() => {
    if (isSettingsPath(location.pathname)) return;
    settingsReturn = { index: location.state.__TSR_index, href: location.href };
  }, [location]);
}

/**
 * How far back in history the screen settings was opened from lies, or null
 * when it isn't behind the current entry (settings was the first page loaded).
 */
export function settingsCloseStep(
  currentIndex: number,
  opened: SettingsReturn | null,
): number | null {
  if (opened === null || opened.index >= currentIndex) return null;
  return opened.index - currentIndex;
}

/**
 * Leaves settings for the screen it was opened from, however many settings
 * pages were visited in between, or the workspace when there is none. The back
 * arrow, the drawer's Back, and Escape all close settings this way; moving
 * between settings pages is what the tabs and links are for.
 */
export function useCloseSettings(): () => void {
  const router = useRouter();
  return useCallback(() => {
    const step = settingsCloseStep(router.history.location.state.__TSR_index, settingsReturn);
    if (step !== null) {
      router.history.go(step);
      return;
    }
    void router.navigate({ to: "/", replace: true });
  }, [router]);
}
