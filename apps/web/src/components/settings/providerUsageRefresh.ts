import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

const REFRESHABLE_USAGE_DRIVERS = new Set(["codex", "claudeAgent", "grok"]);
export const PROVIDER_USAGE_REFRESH_FAILURE_BACKOFF_MS = 30_000;

export class ProviderUsageRefreshBackoffError extends Error {
  constructor() {
    super("Usage refresh is temporarily paused after a failed provider request.");
    this.name = "ProviderUsageRefreshBackoffError";
  }
}

export function isProviderUsageRefreshEligible(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.status !== "disabled" &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated" &&
    REFRESHABLE_USAGE_DRIVERS.has(provider.driver)
  );
}

export function createProviderUsageRefreshCoordinator(input: {
  readonly refresh: (instanceId: ProviderInstanceId) => Promise<void>;
  readonly now?: () => number;
  readonly failureBackoffMs?: number;
}) {
  const now = input.now ?? Date.now;
  const failureBackoffMs = input.failureBackoffMs ?? PROVIDER_USAGE_REFRESH_FAILURE_BACKOFF_MS;
  const inFlight = new Map<ProviderInstanceId, Promise<void>>();
  const retryAfter = new Map<ProviderInstanceId, number>();
  let queue: Promise<void> = Promise.resolve();

  const request = (
    provider: ServerProvider,
    options?: { readonly ignoreFailureBackoff?: boolean },
  ): Promise<void> | null => {
    if (!isProviderUsageRefreshEligible(provider)) return null;

    const existing = inFlight.get(provider.instanceId);
    if (existing) return existing;

    if (
      options?.ignoreFailureBackoff !== true &&
      (retryAfter.get(provider.instanceId) ?? 0) > now()
    ) {
      return Promise.reject(new ProviderUsageRefreshBackoffError());
    }

    // The transport command is single-flight per environment. Serialize
    // different instance refreshes here so one provider's request cannot be
    // coalesced into another provider's response.
    const task = queue.then(async () => {
      try {
        await input.refresh(provider.instanceId);
        retryAfter.delete(provider.instanceId);
      } catch (error) {
        retryAfter.set(provider.instanceId, now() + failureBackoffMs);
        throw error;
      }
    });
    queue = task.catch(() => undefined);
    inFlight.set(provider.instanceId, task);
    void task.then(
      () => inFlight.delete(provider.instanceId),
      () => inFlight.delete(provider.instanceId),
    );
    return task;
  };

  return { request };
}
