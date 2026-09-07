/** Give a second finger time to claim a pinch before sending a press to the host. */
export const TOUCH_PRESS_DELAY_MS = 250;

export function createTouchPressDelay() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let press: (() => void) | undefined;
  let move: (() => void) | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    press = undefined;
    move = undefined;
  };
  const flush = () => {
    const down = press;
    const latestMove = move;
    cancel();
    down?.();
    latestMove?.();
  };
  return {
    cancel,
    flush,
    start(down: () => void) {
      cancel();
      press = down;
      timer = setTimeout(flush, TOUCH_PRESS_DELAY_MS);
    },
    move(latest: () => void) {
      if (!press) return false;
      move = latest;
      return true;
    },
  };
}
