import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

const lifecycleQueues = new Map<string, Promise<void>>();

/** Domain discovery and its following open/close must observe one ordered tab set. */
export async function runPreviewAutomationLifecycleMutation<A>(
  ref: ScopedThreadRef,
  mutation: () => Promise<A>,
): Promise<A> {
  const key = scopedThreadKey(ref);
  const previous = lifecycleQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  lifecycleQueues.set(key, tail);
  try {
    return await current;
  } finally {
    if (lifecycleQueues.get(key) === tail) lifecycleQueues.delete(key);
  }
}

/** A close is already committed; refresh failure must never turn it into an MCP failure. */
export async function runPreviewAutomationPostCloseRefresh(
  refresh: () => Promise<void>,
): Promise<void> {
  try {
    await refresh();
  } catch {
    // Live events or the next list query will reconcile the surviving tab.
  }
}
