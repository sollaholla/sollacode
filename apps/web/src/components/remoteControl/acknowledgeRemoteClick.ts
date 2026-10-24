/** A transport enqueue is not a receipt: wait for the native host's input result. */
export async function acknowledgeRemoteClick(
  apply: () => Promise<{ readonly delivered: boolean; readonly blocked?: unknown } | undefined>,
  acknowledge: (applied: boolean) => Promise<unknown>,
): Promise<void> {
  let applied = false;
  try {
    const result = await apply();
    applied = result?.delivered === true && result.blocked == null;
  } catch {
    // The host's input path already reports its actionable error to the viewer.
  }
  await acknowledge(applied);
}
