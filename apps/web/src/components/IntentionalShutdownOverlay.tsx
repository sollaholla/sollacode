import { LoaderCircle } from "lucide-react";
import { memo, useEffect } from "react";

import { beginIntentionalShutdown, useIntentionalShutdownStore } from "../intentionalShutdown";

export function IntentionalShutdownOverlayView({ active }: { readonly active: boolean }) {
  if (!active) return null;
  return (
    <div
      aria-live="assertive"
      className="fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-4 bg-background/96 text-foreground backdrop-blur-sm"
      data-intentional-shutdown-overlay
      role="status"
    >
      <LoaderCircle aria-hidden className="size-7 animate-spin text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium">Quitting Solla Code</p>
        <p className="mt-1 text-xs text-muted-foreground">Closing your local services safely…</p>
      </div>
    </div>
  );
}

export const IntentionalShutdownOverlay = memo(function IntentionalShutdownOverlay() {
  const active = useIntentionalShutdownStore((state) => state.active);

  useEffect(() => {
    return window.desktopBridge?.onIntentionalShutdown(beginIntentionalShutdown);
  }, []);

  return <IntentionalShutdownOverlayView active={active} />;
});
