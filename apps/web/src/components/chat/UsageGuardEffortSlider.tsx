import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { ArrowDownRightIcon, ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { type UsageGuardEffortEstimate, formatCooldownDuration } from "./usageGuardPause";

const ranks: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
  ultrathink: 8,
  ultracode: 8,
};

const NO_ESTIMATES: ReadonlyArray<UsageGuardEffortEstimate> = [];

/**
 * The hold card's planning section: what the current model and effort will
 * wait, a slider that *previews* other efforts against the same snapshot, and
 * every other model the provider offers, shortest wait first.
 *
 * Nothing here changes the turn on its own. The slider is a preview until
 * Apply; Resume always runs the applied setting. Every saving is measured
 * against the quote for the current effort from the same snapshot, never
 * against the banner countdown, which can lag an Apply.
 */
export function UsageGuardEffortSlider({
  selection,
  provider,
  waitSeconds,
  estimates = NO_ESTIMATES,
  nowMs = Date.now(),
  onApply,
  onDraftChange,
  busy,
}: {
  selection: ModelSelection;
  provider: ServerProvider | undefined;
  waitSeconds: number | null;
  estimates?: ReadonlyArray<UsageGuardEffortEstimate> | undefined;
  nowMs?: number;
  onApply: (selection: ModelSelection) => void;
  onDraftChange?: (selection: ModelSelection | null) => void;
  busy: boolean;
}) {
  const modelName = (slug: string) =>
    provider?.models.find((model) => model.slug === slug)?.name ?? slug;
  const descriptors =
    provider?.models.find((model) => model.slug === selection.model)?.capabilities
      ?.optionDescriptors ?? [];
  const descriptor = descriptors.find(
    (option) =>
      option.type === "select" && (option.id === "effort" || option.id === "reasoningEffort"),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const adjustable = descriptor?.type === "select" && descriptor.options.length > 1;
  const choices =
    descriptor?.type === "select" && descriptor.options.length
      ? [...descriptor.options].sort((a, b) => (ranks[a.id] ?? 100) - (ranks[b.id] ?? 100))
      : [{ id: "default", label: "Default", isDefault: true }];
  const optionId = descriptor?.id;
  const current =
    selection.options?.find((option) => option.id === optionId)?.value ??
    (descriptor?.type === "select" ? descriptor.currentValue : undefined) ??
    choices.find((choice) => choice.isDefault)?.id ??
    choices[0]!.id;
  const currentChoice = choices.find((choice) => choice.id === current) ?? choices[0]!;
  const index = Math.max(
    0,
    choices.findIndex((choice) => choice.id === (draft ?? current)),
  );
  const chosen = choices[index]!;
  const changed = chosen.id !== current;
  const waitFor = (resumeAt: number | null | undefined) =>
    resumeAt == null ? null : Math.max(0, Math.ceil((resumeAt - nowMs) / 1000));
  const estimate = estimates.find(
    (entry) => entry.model === selection.model && entry.effort === chosen.id,
  );
  const baselineEstimate = estimates.find(
    (entry) => entry.model === selection.model && entry.effort === current,
  );
  const baselineWait = waitFor(baselineEstimate?.resumeAt) ?? waitSeconds;
  const selectedWait = changed ? waitFor(estimate?.resumeAt) : baselineWait;
  const saved = selectedWait !== null && baselineWait !== null ? baselineWait - selectedWait : null;
  const selectionWith = (effort: string): ModelSelection => ({
    ...selection,
    options: [
      ...(selection.options ?? []).filter((option) => option.id !== optionId),
      ...(optionId ? [{ id: optionId, value: effort }] : []),
    ],
  });
  const alternatives = [...new Set(estimates.map((entry) => entry.model))]
    .filter((model) => model !== selection.model)
    .map(
      (model) =>
        estimates.find((entry) => entry.model === model && entry.effort === current) ??
        estimates.find((entry) => entry.model === model),
    )
    .filter((entry) => entry !== undefined)
    .sort(
      (a, b) => (a.resumeAt ?? Number.POSITIVE_INFINITY) - (b.resumeAt ?? Number.POSITIVE_INFINITY),
    );
  const waitLabel = (wait: number | null) =>
    wait === null
      ? "Waiting for budget"
      : wait === 0
        ? "Ready now"
        : `Wait ${formatCooldownDuration(wait)}`;
  const delta = (saving: number | null) =>
    saving === null || saving === 0 ? null : (
      <span className={saving > 0 ? "text-emerald-600" : "text-red-600"}>
        {saving > 0 ? "↗ +" : "↘ −"}
        {formatCooldownDuration(Math.abs(saving))}
        {saving < 0 ? " longer" : ""}
      </span>
    );
  return (
    <div className="space-y-3" data-testid="usage-guard-effort-slider">
      <div className="rounded-lg border border-border/60 bg-background/40 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-medium">
            {modelName(selection.model)} · Thinking effort: {chosen.label}
          </span>
          <span
            className={
              saved === null || saved === 0
                ? "text-muted-foreground"
                : saved > 0
                  ? "inline-flex items-center gap-1 text-emerald-600"
                  : "inline-flex items-center gap-1 text-red-600"
            }
          >
            {saved !== null &&
              saved !== 0 &&
              (saved > 0 ? (
                <ArrowUpRightIcon className="size-3.5" aria-hidden />
              ) : (
                <ArrowDownRightIcon className="size-3.5" aria-hidden />
              ))}
            {!changed
              ? "Current setting"
              : saved === null
                ? "Time saved: waiting for budget estimate"
                : saved === 0
                  ? "Same wait · already-spent usage sets this hold"
                  : saved < 0
                    ? `−${formatCooldownDuration(-saved)} saved (longer wait)`
                    : `Estimated time saved: +${formatCooldownDuration(saved)}`}
          </span>
        </div>
        <p className="mt-1 text-muted-foreground">
          {selectedWait === null
            ? "Wait estimate unavailable for this effort"
            : `Estimated wait: ${formatCooldownDuration(selectedWait)}`}
          {changed && baselineWait !== null
            ? ` · now ${currentChoice.label}: ${formatCooldownDuration(baselineWait)}`
            : ""}
        </p>
        {adjustable ? (
          <>
            <input
              type="range"
              min={0}
              max={choices.length - 1}
              step={1}
              value={index}
              disabled={busy}
              onChange={(event) => {
                const effort = choices[Number(event.target.value)]!.id;
                setDraft(effort);
                onDraftChange?.(effort === current ? null : selectionWith(effort));
              }}
              aria-label="Thinking effort"
              aria-valuetext={chosen.label}
              className="mt-2 block w-full cursor-pointer accent-amber-500"
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>{choices[0]!.label}</span>
              <span>{choices.at(-1)!.label}</span>
            </div>
          </>
        ) : (
          <p className="mt-2 text-muted-foreground">
            This model does not expose an adjustable thinking effort.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
            {estimate && estimate.samples < 3
              ? "Starting estimate; measured usage will refine it."
              : "Based on observed usage."}{" "}
            Already-spent usage stays in the calculation. Resume runs the applied setting; apply a
            change to use it.
          </p>
          {changed && (
            <Button
              type="button"
              size="xs"
              variant="default"
              className="shrink-0"
              disabled={busy}
              onClick={() => onApply(selectionWith(chosen.id))}
            >
              {busy ? "Applying…" : `Apply ${chosen.label} effort`}
            </Button>
          )}
        </div>
      </div>
      {alternatives.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-0.5">
            <p className="font-medium">
              Compare other models{alternatives.length > 1 ? ` (${alternatives.length})` : ""}
            </p>
            {selection.model.toLowerCase().includes("fable") && (
              <p className="text-[11px] text-muted-foreground">
                Other families skip the Fable-specific limit; shared account limits still apply.
              </p>
            )}
          </div>
          <div className="max-h-48 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5">
            {alternatives.map((entry) => {
              const wait = waitFor(entry.resumeAt);
              const saving = wait === null || baselineWait === null ? null : baselineWait - wait;
              return (
                <div
                  key={entry.model}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{modelName(entry.model)}</p>
                    <p className="truncate text-muted-foreground">
                      {waitLabel(wait)}
                      {saving !== null && saving !== 0 ? (
                        <>
                          {" · "}
                          {delta(saving)}
                        </>
                      ) : null}
                      {saving === 0 ? " · Same wait" : ""}
                      {" · "}
                      {entry.effort} · {entry.windowLabel ?? "Account usage"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    disabled={busy}
                    aria-label={`Use ${modelName(entry.model)}`}
                    onClick={() =>
                      onApply({
                        instanceId: selection.instanceId,
                        model: entry.model,
                        options: entry.optionId
                          ? [{ id: entry.optionId, value: entry.effort }]
                          : [],
                      })
                    }
                  >
                    Use
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
