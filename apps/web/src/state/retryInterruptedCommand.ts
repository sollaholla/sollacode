export const INTERRUPTED_COMMAND_RETRY_MS = 500;

/**
 * A renderer reconnect can interrupt the local command waiter even when the
 * environment will be reachable again moments later. Callers keep the same
 * durable command id while retrying that transport boundary.
 */
export async function retryInterruptedCommand<T>(input: {
  readonly run: () => Promise<T>;
  readonly isInterrupted: (result: T) => boolean;
  readonly shouldRetry: () => boolean;
  readonly wait?: () => Promise<void>;
}): Promise<T> {
  while (true) {
    const result = await input.run();
    if (!input.isInterrupted(result) || !input.shouldRetry()) {
      return result;
    }
    await (input.wait?.() ??
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, INTERRUPTED_COMMAND_RETRY_MS);
      }));
  }
}
