import { useCallback } from "react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

/**
 * "Back" as a person means it: the previous screen, or the workspace if there
 * is no history to pop.
 *
 * A bare `history.back()` is wrong on a first navigation — opening settings
 * from a fresh tab would step out of the app entirely. Shared so the settings
 * drawer footer, the phone top bar, and Escape all do one thing.
 */
export function useNavigateBackWithinApp(): () => void {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);
}
