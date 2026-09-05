import { cn } from "~/lib/utils";
import {
  type ContextWindowSnapshot,
  deriveAutoCompactionTokenThreshold,
  formatContextWindowTokens,
} from "~/lib/contextWindow";
import {
  MAX_AUTO_COMPACTION_THRESHOLD_PERCENTAGE,
  MIN_AUTO_COMPACTION_THRESHOLD_PERCENTAGE,
  type AutoCompactionThresholdPercentage,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { useId } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const AUTO_COMPACTION_TICKS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95] as const;

export function providerSupportsConfigurableAutoCompaction(
  driver: ProviderDriverKind | null | undefined,
): boolean {
  return driver === "claudeAgent" || driver === "codex";
}

export function AutoCompactionThresholdControl(props: {
  maxTokens: number;
  providerDisplayName?: string | null;
  thresholdPercentage: AutoCompactionThresholdPercentage;
  onThresholdChange: (value: AutoCompactionThresholdPercentage) => void;
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const inputId = useId();
  const tokenThreshold = deriveAutoCompactionTokenThreshold(
    props.maxTokens,
    props.thresholdPercentage,
  );
  if (tokenThreshold === null) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-col gap-2 border-border/50 border-t pt-2">
      <div className="flex items-start justify-between gap-3">
        <label htmlFor={inputId} className="text-[11px] font-medium text-muted-foreground/80">
          Auto-compact at
        </label>
        <span className="text-right text-[11px] tabular-nums text-muted-foreground/70">
          {props.thresholdPercentage}% · {formatContextWindowTokens(tokenThreshold)} tokens
        </span>
      </div>
      <input
        id={inputId}
        type="range"
        min={MIN_AUTO_COMPACTION_THRESHOLD_PERCENTAGE}
        max={MAX_AUTO_COMPACTION_THRESHOLD_PERCENTAGE}
        step={5}
        value={props.thresholdPercentage}
        disabled={props.disabled}
        onChange={(event) =>
          props.onThresholdChange(
            Number(event.currentTarget.value) as AutoCompactionThresholdPercentage,
          )
        }
        aria-label="Automatic compaction threshold"
        aria-valuetext={`${props.thresholdPercentage}% (${formatContextWindowTokens(tokenThreshold)} tokens)`}
        className="h-4 w-full cursor-pointer accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div
        className="flex items-start justify-between px-0.5 text-[9px] tabular-nums text-muted-foreground/50"
        aria-hidden="true"
      >
        {AUTO_COMPACTION_TICKS.map((tick) => (
          <span key={tick} className="flex flex-col items-center gap-0.5">
            <span className="h-1 w-px bg-muted-foreground/40" />
            <span>{tick}%</span>
          </span>
        ))}
      </div>
      <div className="text-pretty text-[10px] leading-4 text-muted-foreground/60">
        {props.disabled && props.disabledReason
          ? props.disabledReason
          : `${props.providerDisplayName ?? "This agent"} compacts before the hard context limit.`}
      </div>
    </div>
  );
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  providerDisplayName?: string | null;
  configurableAutoCompaction: boolean;
  autoCompactionThresholdPercentage: AutoCompactionThresholdPercentage;
  onAutoCompactionThresholdChange: (value: AutoCompactionThresholdPercentage) => void;
  autoCompactionDisabledReason?: string | null;
  /** Which edge of the trigger the popover lines up with; matches the cluster the meter sits in. */
  align?: "start" | "end";
}) {
  const {
    usage,
    providerDisplayName,
    configurableAutoCompaction,
    autoCompactionThresholdPercentage,
    onAutoCompactionThresholdChange,
    autoCompactionDisabledReason,
    align = "end",
  } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-red-500)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            data-chat-composer-context-meter="true"
            className={cn(
              "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align={align}
        className="dropdown-glass w-72 max-w-none border-0! bg-secondary! p-0 shadow-none! before:hidden"
      >
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-muted-foreground/60">Total processed</span>
              <span className="font-medium tabular-nums text-muted-foreground/80">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {configurableAutoCompaction &&
          usage.maxTokens !== null &&
          usage.maxTokens !== undefined ? (
            <AutoCompactionThresholdControl
              maxTokens={usage.maxTokens}
              {...(providerDisplayName !== undefined ? { providerDisplayName } : {})}
              thresholdPercentage={autoCompactionThresholdPercentage}
              onThresholdChange={onAutoCompactionThresholdChange}
              disabled={Boolean(autoCompactionDisabledReason)}
              {...(autoCompactionDisabledReason !== undefined
                ? { disabledReason: autoCompactionDisabledReason }
                : {})}
            />
          ) : usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
              {providerDisplayName ?? "It"} automatically compacts its context when needed.
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
