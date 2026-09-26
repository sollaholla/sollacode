import type { ModelSelection } from "@t3tools/contracts";

/** Keep an earlier server echo from replacing a newer local picker choice. */
export class PendingModelSelections {
  private readonly pending = new Map<string, ModelSelection>();

  set(threadKey: string, selection: ModelSelection): void {
    this.pending.set(threadKey, selection);
  }

  accept(threadKey: string, selection: ModelSelection): boolean {
    const pending = this.pending.get(threadKey);
    if (pending && JSON.stringify(pending) !== JSON.stringify(selection)) return false;
    this.pending.delete(threadKey);
    return true;
  }

  failed(threadKey: string, selection: ModelSelection): void {
    if (this.pending.get(threadKey) === selection) this.pending.delete(threadKey);
  }
}
