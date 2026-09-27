/** The native pointer bridge may take longer than one poll interval to reply. */
export function pollRemoteControlPointer(read: () => Promise<void>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    await read();
    if (!stopped) timer = setTimeout(() => void tick(), 100);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
