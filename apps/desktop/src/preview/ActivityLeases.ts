export const PreviewActivityConsumer = {
  Automation: "automation",
  Diagnostics: "diagnostics",
  PictureInPicture: "picture-in-picture",
  Recording: "recording",
  RemoteControl: "remote-control",
  Ui: "ui",
} as const;

export type PreviewActivityConsumer =
  (typeof PreviewActivityConsumer)[keyof typeof PreviewActivityConsumer];

export interface PreviewActivityLease {
  readonly tabId: string;
  readonly leaseId: string;
  readonly consumer: PreviewActivityConsumer;
}

export interface PreviewActivitySnapshot {
  readonly total: number;
  readonly byConsumer: ReadonlyMap<PreviewActivityConsumer, number>;
  readonly leases: ReadonlyArray<PreviewActivityLease>;
}

const emptySnapshot = (): PreviewActivitySnapshot => ({
  total: 0,
  byConsumer: new Map(),
  leases: [],
});

/**
 * Tracks independent reasons that a preview tab must stay active.
 *
 * Lease IDs are stable and idempotent: acquiring the same tab/id/consumer
 * twice does not create a second lease. Reusing an ID for another consumer is
 * rejected because it would make the eventual release ambiguous.
 */
export class PreviewActivityLeases {
  readonly #leasesByTab = new Map<string, Map<string, PreviewActivityConsumer>>();

  acquire(tabId: string, leaseId: string, consumer: PreviewActivityConsumer): boolean {
    const leases = this.#leasesByTab.get(tabId);
    const existing = leases?.get(leaseId);
    if (existing !== undefined) {
      if (existing !== consumer) {
        throw new Error(
          `Preview activity lease ${leaseId} for tab ${tabId} is already owned by ${existing}`,
        );
      }
      return false;
    }

    const next = leases ?? new Map<string, PreviewActivityConsumer>();
    next.set(leaseId, consumer);
    if (!leases) this.#leasesByTab.set(tabId, next);
    return true;
  }

  release(tabId: string, leaseId: string): boolean {
    const leases = this.#leasesByTab.get(tabId);
    if (!leases?.delete(leaseId)) return false;
    if (leases.size === 0) this.#leasesByTab.delete(tabId);
    return true;
  }

  clearTab(tabId: string): number {
    const leases = this.#leasesByTab.get(tabId);
    if (!leases) return 0;
    this.#leasesByTab.delete(tabId);
    return leases.size;
  }

  has(tabId: string, consumer?: PreviewActivityConsumer): boolean {
    const leases = this.#leasesByTab.get(tabId);
    if (!leases) return false;
    if (consumer === undefined) return leases.size > 0;
    for (const value of leases.values()) {
      if (value === consumer) return true;
    }
    return false;
  }

  snapshot(tabId?: string): PreviewActivitySnapshot {
    if (tabId !== undefined) {
      const leases = this.#leasesByTab.get(tabId);
      if (!leases) return emptySnapshot();
      return this.#snapshotEntries([[tabId, leases]]);
    }
    return this.#snapshotEntries(this.#leasesByTab.entries());
  }

  #snapshotEntries(
    entries: Iterable<readonly [string, ReadonlyMap<string, PreviewActivityConsumer>]>,
  ): PreviewActivitySnapshot {
    const leases: Array<PreviewActivityLease> = [];
    const byConsumer = new Map<PreviewActivityConsumer, number>();
    for (const [tabId, tabLeases] of entries) {
      for (const [leaseId, consumer] of tabLeases) {
        leases.push({ tabId, leaseId, consumer });
        byConsumer.set(consumer, (byConsumer.get(consumer) ?? 0) + 1);
      }
    }
    return {
      total: leases.length,
      byConsumer,
      leases,
    };
  }
}
