import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";

/** Drivers whose model ids carry a version that people read a list by. */
const VERSION_ORDERED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * The version in a model id: `claude-opus-5-5` and `gpt-5.5-codex` are 5.5,
 * `claude-sonnet-5` is 5. A date suffix like `-20250514` is not a version,
 * which the two-digit limit rules out. Null when an id names none.
 */
export function modelVersionFromSlug(slug: string): readonly [number, number] | null {
  const match = /(?:^|[^\d.])(\d{1,2})(?:[.-](\d{1,2})(?!\d))?(?!\d)/u.exec(slug);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

/** Newest version first, then by name, with models that name no version last. */
function compareModels(left: ServerProviderModel, right: ServerProviderModel): number {
  const leftVersion = modelVersionFromSlug(left.slug);
  const rightVersion = modelVersionFromSlug(right.slug);
  if (leftVersion === null || rightVersion === null) {
    if (leftVersion !== rightVersion) return leftVersion === null ? 1 : -1;
  } else {
    const delta = rightVersion[0] - leftVersion[0] || rightVersion[1] - leftVersion[1];
    if (delta !== 0) return delta;
  }
  return (
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) ||
    left.slug.localeCompare(right.slug)
  );
}

/**
 * Orders a provider's models for every client's lists. Clients fall back to the
 * first built-in model when none is marked default, so a reorder that changes
 * which one that is marks the old one: sorting must not move a thread to Haiku.
 */
export function orderProviderModels(
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  if (!VERSION_ORDERED_DRIVERS.has(driver)) return models;
  const sorted = models.toSorted(compareModels);
  if (models.some((model) => model.isDefault)) return sorted;
  const previousFirst = models.find((model) => !model.isCustom);
  if (!previousFirst || sorted.find((model) => !model.isCustom) === previousFirst) return sorted;
  return sorted.map((model) => (model === previousFirst ? { ...model, isDefault: true } : model));
}

export const orderProviderSnapshotModels = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  models: orderProviderModels(provider.driver, provider.models),
});
