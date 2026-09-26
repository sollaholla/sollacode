export type TouchAction = "scroll" | "drag" | "right-click" | "hold" | "left-hold" | "right-hold";
export interface TouchPoint {
  x: number;
  y: number;
}
export interface TouchMenuState {
  center: TouchPoint;
  layer: "main" | "hold";
  hovered: TouchAction | null;
  activated: TouchAction | null;
}
export const TOUCH_MENU_HOLD_MS = 400;
export const TOUCH_MENU_DWELL_MS = 450;
export const TOUCH_MENU_ITEMS = [
  { action: "scroll", label: "Scroll", x: 0, y: -66 },
  { action: "drag", label: "Drag", x: -66, y: 10 },
  { action: "right-click", label: "Right-click", x: 66, y: 10 },
  { action: "hold", label: "Hold", x: 0, y: 76 },
] as const;

export const TOUCH_HOLD_ITEMS = [
  { action: "left-hold", label: "Left hold", x: -52, y: 0 },
  { action: "right-hold", label: "Right hold", x: 52, y: 0 },
] as const;

/**
 * Local gesture ownership: no remote press while choosing an action.
 *
 * `panScrolls` makes a one-finger pan that leaves the tap slop before the menu
 * opens scroll, as a page does on a phone. Without it that pan does nothing,
 * which suits a desktop whose one-finger pan means nothing in particular.
 */
export function createTouchActionMenu(callbacks: {
  menu: (state: TouchMenuState | null) => void;
  pointer: (action: "down" | "move" | "up", point: TouchPoint, button: "left" | "right") => void;
  scroll: (anchor: TouchPoint, delta: TouchPoint) => void;
  panScrolls?: boolean;
}) {
  let phase: "idle" | "pending" | "cancelled" | "menu" | TouchAction = "idle";
  let origin = { x: 0, y: 0 };
  let last = origin;
  let dragPoint = origin;
  let center = origin;
  let hovered: TouchAction | null = null;
  let layer: "main" | "hold" = "main";
  let startedAt = 0;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let dwell: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    clearTimeout(hold);
    clearTimeout(dwell);
    hold = undefined;
    dwell = undefined;
  };
  const cancel = () => {
    clearTimers();
    if (phase === "drag") callbacks.pointer("up", dragPoint, "left");
    if (phase === "left-hold" || phase === "right-hold")
      callbacks.pointer("up", origin, phase === "left-hold" ? "left" : "right");
    phase = "idle";
    hovered = null;
    callbacks.menu(null);
  };
  return {
    cancel,
    start(point: TouchPoint, menuCenter: TouchPoint) {
      cancel();
      origin = point;
      last = point;
      dragPoint = point;
      center = menuCenter;
      phase = "pending";
      startedAt = Date.now();
      layer = "main";
      hold = setTimeout(() => {
        phase = "menu";
        callbacks.menu({ center, layer, hovered: null, activated: null });
      }, TOUCH_MENU_HOLD_MS);
    },
    move(point: TouchPoint) {
      if (phase === "idle") return false;
      const delta = { x: point.x - last.x, y: point.y - last.y };
      last = point;
      if (phase === "pending") {
        if (Math.hypot(point.x - origin.x, point.y - origin.y) > 10) {
          clearTimers();
          if (callbacks.panScrolls) {
            phase = "scroll";
            callbacks.scroll(origin, { x: origin.x - point.x, y: origin.y - point.y });
          } else {
            phase = "cancelled";
          }
        }
      } else if (phase === "menu") {
        const next =
          (layer === "main" ? TOUCH_MENU_ITEMS : TOUCH_HOLD_ITEMS).find(
            (item) => Math.hypot(point.x - center.x - item.x, point.y - center.y - item.y) <= 32,
          )?.action ?? null;
        if (next !== hovered) {
          clearTimeout(dwell);
          hovered = next;
          callbacks.menu({ center, layer, hovered, activated: null });
          if (next)
            dwell = setTimeout(() => {
              if (next === "hold") {
                layer = "hold";
                hovered = null;
                callbacks.menu({ center, layer, hovered: null, activated: null });
                return;
              }
              phase = next;
              dragPoint = origin;
              callbacks.menu({ center, layer, hovered: next, activated: next });
              if (next === "drag" || next === "left-hold")
                callbacks.pointer("down", origin, "left");
              if (next === "right-hold") callbacks.pointer("down", origin, "right");
              if (next === "right-click") {
                callbacks.pointer("down", origin, "right");
                callbacks.pointer("up", origin, "right");
              }
            }, TOUCH_MENU_DWELL_MS);
        }
      } else if (phase === "scroll") {
        if (delta.x || delta.y) callbacks.scroll(origin, { x: -delta.x, y: -delta.y });
      } else if (phase === "drag") {
        dragPoint = { x: dragPoint.x + delta.x, y: dragPoint.y + delta.y };
        callbacks.pointer("move", dragPoint, "left");
      }
      return true;
    },
    end() {
      if (phase === "idle") return false;
      if (phase === "pending" && Date.now() - startedAt < TOUCH_MENU_HOLD_MS) {
        callbacks.pointer("down", origin, "left");
        callbacks.pointer("up", origin, "left");
      }
      cancel();
      return true;
    },
  };
}
