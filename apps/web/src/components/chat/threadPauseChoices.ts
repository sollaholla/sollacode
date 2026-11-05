import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import type { ProviderUsageSummary, ProviderUsageWindow } from "./ProviderUsageBar";

/** Quota pools that belong to one model family rather than the whole account. */
const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku", "gemini", "claude"] as const;

export interface ThreadPauseModelChoice {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly name: string;
  /** Percent of usage known to be left, or null when the provider doesn't say. */
  readonly percentLeft: number | null;
}

export interface ThreadPauseModelGroup {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly models: ReadonlyArray<ThreadPauseModelChoice>;
}

export interface ThreadPauseAccountChoice {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly model: string;
  readonly percentLeft: number | null;
}

function familyOf(text: string): string | null {
  const lower = text.toLowerCase();
  return MODEL_FAMILIES.find((family) => lower.includes(family)) ?? null;
}

/** Whether a quota window is one this model draws on. */
function windowCoversModel(window: ProviderUsageWindow, model: string): boolean {
  const family = familyOf(`${window.key} ${window.label}`);
  return family === null || model.toLowerCase().includes(family);
}

/**
 * The tightest reading across the windows a model draws on. A window that has
 * already reset says nothing about now, and no reading at all stays unknown
 * instead of reading as full.
 */
export function percentLeftForModel(
  windows: ReadonlyArray<ProviderUsageWindow>,
  model: string,
  nowMs: number,
): number | null {
  const used = windows
    .filter((window) => window.resetAt === null || window.resetAt > nowMs)
    .filter((window) => windowCoversModel(window, model))
    .flatMap((window) => (window.usedPercent === null ? [] : [window.usedPercent]));
  if (used.length === 0) return null;
  return Math.max(0, Math.round(100 - Math.max(...used)));
}

function usableProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.auth.status !== "unauthenticated"
  );
}

function windowsFor(
  summaries: ReadonlyArray<ProviderUsageSummary>,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ProviderUsageWindow> {
  return summaries.find((summary) => summary.provider.instanceId === instanceId)?.windows ?? [];
}

function byMostLeft(a: ThreadPauseModelChoice, b: ThreadPauseModelChoice): number {
  return (b.percentLeft ?? -1) - (a.percentLeft ?? -1);
}

/**
 * The models a paused thread can move to, each with what is known to be left.
 * A model known to be spent isn't offered, since it would pause again at once.
 */
export function pauseModelChoices(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly summaries: ReadonlyArray<ProviderUsageSummary>;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly currentModel: string | null;
  readonly labelOf: (provider: ServerProvider) => string;
  readonly nowMs: number;
}): ReadonlyArray<ThreadPauseModelGroup> {
  return input.providers.filter(usableProvider).flatMap((provider) => {
    const windows = windowsFor(input.summaries, provider.instanceId);
    const models = provider.models
      .filter(
        (model) =>
          provider.instanceId !== input.currentInstanceId || model.slug !== input.currentModel,
      )
      .map((model) => ({
        instanceId: provider.instanceId,
        model: model.slug,
        name: model.name,
        percentLeft: percentLeftForModel(windows, model.slug, input.nowMs),
      }))
      .filter((choice) => choice.percentLeft !== 0)
      .toSorted(byMostLeft);
    return models.length === 0
      ? []
      : [{ instanceId: provider.instanceId, label: input.labelOf(provider), models }];
  });
}

/**
 * The other signed-in accounts of the provider that stopped. Each one is its
 * own provider instance, so moving to it keeps the same model where it can.
 */
export function pauseAccountChoices(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly summaries: ReadonlyArray<ProviderUsageSummary>;
  readonly current: ServerProvider | undefined;
  readonly currentModel: string | null;
  readonly labelOf: (provider: ServerProvider) => string;
  readonly nowMs: number;
}): ReadonlyArray<ThreadPauseAccountChoice> {
  const { current } = input;
  if (current === undefined) return [];
  return input.providers
    .filter(
      (provider) =>
        usableProvider(provider) &&
        provider.driver === current.driver &&
        provider.instanceId !== current.instanceId,
    )
    .flatMap((provider) => {
      const model =
        provider.models.find((entry) => entry.slug === input.currentModel)?.slug ??
        provider.models.find((entry) => entry.isDefault === true)?.slug ??
        provider.models[0]?.slug;
      if (model === undefined) return [];
      const percentLeft = percentLeftForModel(
        windowsFor(input.summaries, provider.instanceId),
        model,
        input.nowMs,
      );
      return [
        {
          instanceId: provider.instanceId,
          label: input.labelOf(provider),
          model,
          percentLeft,
        },
      ];
    });
}

/** When the window that ran out reopens, if a reading says. */
export function pauseResetAt(
  windows: ReadonlyArray<ProviderUsageWindow>,
  nowMs: number,
): number | null {
  const resets = windows.flatMap((window) =>
    window.resetAt !== null && window.resetAt > nowMs && (window.usedPercent ?? 0) >= 100
      ? [window.resetAt]
      : [],
  );
  return resets.length === 0 ? null : Math.max(...resets);
}

/** "at 4:10 PM" today, "Thu 4:10 PM" within the week, a date after that. */
export function formatThreadPauseReset(resetAt: number, nowMs: number): string {
  const time = new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (resetAt - nowMs) / 86_400_000;
  if (days < 1) return `at ${time}`;
  const date = new Date(resetAt);
  return days < 7
    ? `${date.toLocaleDateString([], { weekday: "long" })} at ${time}`
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}
