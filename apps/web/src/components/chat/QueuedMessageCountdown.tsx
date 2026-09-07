import { useEffect, useState } from "react";
import { formatCooldownDuration, type UsageGuardPauseNotice } from "./usageGuardPause";

/** A ticking leaf keeps the rest of the conversation out of countdown renders. */
export function QueuedMessageCountdown({ notice }: { readonly notice: UsageGuardPauseNotice }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const due = Date.parse(notice.retryAt ?? "");
  if (!Number.isFinite(due)) return null;
  const seconds = Math.max(0, Math.ceil((due - now) / 1000));
  const percent = Math.min(
    100,
    Math.max(
      0,
      (100 * (now - Date.parse(notice.createdAt))) /
        Math.max(1, due - Date.parse(notice.createdAt)),
    ),
  );
  return (
    <div className="mb-3 space-y-2 px-1">
      <div className="text-[11px] text-muted-foreground">
        {seconds > 0
          ? `Sends together in approximately ${formatCooldownDuration(seconds)}`
          : "Rechecking the usage budget before sending…"}
      </div>
      <div
        role="progressbar"
        aria-label="Queued messages cooldown"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-amber-500/70" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
