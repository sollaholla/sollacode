import { useMemo, useState } from "react";

import {
  dailyBuckets,
  estimateVoiceMinutes,
  formatTokens,
  formatUsd,
  monthlyBuckets,
  totalBucket,
  type UsageBucket,
  type UsageDay,
} from "../../orchestrator/usageTracking";
import { Button } from "../ui/button";

/**
 * Spend and usage for the voice orchestrator.
 *
 * The numbers come from the Realtime API's own per-response `usage` block, so
 * token counts are exact for this client. Money is an estimate — counts times a
 * hand-maintained rate table — and is labelled as such everywhere it appears,
 * because published rates move and a confidently wrong dollar figure is worse
 * than an honest approximate one.
 *
 * OpenAI's organisation usage endpoints are deliberately not called: they
 * require an Admin key, and the key configured here is a normal API key. This
 * view is what *this app* spent, not the account total.
 */

const MAX_ROWS = 14;

function BucketRow({ bucket, label }: { bucket: UsageBucket; label: string }) {
  const minutes = estimateVoiceMinutes(bucket.usage);
  return (
    <tr className="border-border/40 border-b last:border-0">
      <td className="text-foreground py-1.5 pr-3 font-mono text-xs whitespace-nowrap">{label}</td>
      <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs tabular-nums">
        {minutes < 0.1 ? "<0.1" : minutes.toFixed(1)}
      </td>
      <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs tabular-nums">
        {formatTokens(bucket.usage.inputAudioTokens + bucket.usage.cachedAudioTokens)}
      </td>
      <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs tabular-nums">
        {formatTokens(bucket.usage.outputAudioTokens)}
      </td>
      <td className="text-foreground py-1.5 text-right text-xs tabular-nums">
        {formatUsd(bucket.costUsd)}
      </td>
    </tr>
  );
}

function UsageTable({
  caption,
  buckets,
  formatKey,
}: {
  caption: string;
  buckets: ReadonlyArray<UsageBucket>;
  formatKey: (key: string) => string;
}) {
  if (buckets.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-muted-foreground mb-1 text-xs font-medium">{caption}</div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-muted-foreground/70 border-border/60 border-b text-[10px] uppercase">
            <th className="py-1 pr-3 text-left font-medium">Period</th>
            <th className="py-1 pr-3 text-right font-medium">Min</th>
            <th className="py-1 pr-3 text-right font-medium">Heard</th>
            <th className="py-1 pr-3 text-right font-medium">Spoken</th>
            <th className="py-1 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {buckets.slice(0, MAX_ROWS).map((bucket) => (
            <BucketRow key={bucket.key} bucket={bucket} label={formatKey(bucket.key)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OrchestratorUsageView({
  days,
  onClear,
}: {
  days: ReadonlyArray<UsageDay>;
  onClear: () => void;
}) {
  const [showDaily, setShowDaily] = useState(true);
  const daily = useMemo(() => dailyBuckets(days), [days]);
  const monthly = useMemo(() => monthlyBuckets(days), [days]);
  const total = useMemo(() => totalBucket(days), [days]);
  const thisMonth = monthly[0];
  const today = daily[0];

  if (days.length === 0) {
    return (
      <div className="border-border/60 text-muted-foreground mt-2 rounded-md border border-dashed p-4 text-xs">
        No voice usage recorded yet. Usage appears here after your first spoken session, taken from
        what the Realtime API reports for each response.
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Today", bucket: today },
          { label: "This month", bucket: thisMonth },
          { label: "All time", bucket: total },
        ].map((entry) => (
          <div key={entry.label} className="border-border/60 rounded-md border p-3">
            <div className="text-muted-foreground text-[10px] uppercase">{entry.label}</div>
            <div className="text-foreground mt-1 text-lg tabular-nums">
              {formatUsd(entry.bucket?.costUsd ?? 0)}
            </div>
            <div className="text-muted-foreground text-[11px] tabular-nums">
              {entry.bucket === undefined
                ? "0.0 min"
                : `${estimateVoiceMinutes(entry.bucket.usage).toFixed(1)} min`}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          variant={showDaily ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setShowDaily(true)}
        >
          Daily
        </Button>
        <Button
          type="button"
          variant={showDaily ? "ghost" : "secondary"}
          size="sm"
          onClick={() => setShowDaily(false)}
        >
          Monthly
        </Button>
        <div className="grow" />
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear history
        </Button>
      </div>

      {showDaily ? (
        <UsageTable caption="Daily" buckets={daily} formatKey={(key) => key} />
      ) : (
        <UsageTable caption="Monthly" buckets={monthly} formatKey={(key) => key} />
      )}

      <p className="text-muted-foreground mt-3 text-[11px] leading-relaxed">
        Token counts are exact — they come from the Realtime API's own per-response usage. Costs are
        estimates from published rates as of August 2026 and may not match your OpenAI invoice; a
        model with no known rate shows tokens but no cost. "Heard" is audio you sent, "Spoken" is
        audio the orchestrator produced, which bills at roughly twice the rate. This is what this
        app spent, not your account total.
      </p>
    </div>
  );
}
