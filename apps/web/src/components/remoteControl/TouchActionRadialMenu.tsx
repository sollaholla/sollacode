import { createPortal } from "react-dom";
import { ArrowDownUpIcon, MousePointer2Icon, MousePointerClickIcon, HandIcon } from "lucide-react";
import {
  TOUCH_MENU_DWELL_MS,
  TOUCH_MENU_ITEMS,
  TOUCH_HOLD_ITEMS,
  type TouchMenuState,
} from "./touchActionMenu";

export function TouchActionRadialMenu({ state }: { state: TouchMenuState | null }) {
  if (!state) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[200] select-none"
      style={{ left: state.center.x, top: state.center.y }}
      role="status"
      aria-label={state.activated ? `${state.activated} active` : "Hold over an action to select"}
    >
      {state.activated ? (
        <div className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-background px-3 py-2 text-xs text-foreground shadow-lg">
          {state.activated === "scroll"
            ? "Scroll · move your finger"
            : state.activated === "drag"
              ? "Drag · lift to drop"
              : state.activated === "right-click"
                ? "Right-click"
                : `${state.activated === "left-hold" ? "Left" : "Right"} held · lift to release`}
        </div>
      ) : (
        <>
          <div className="absolute -translate-x-1/2 translate-y-[116px] whitespace-nowrap rounded-full bg-background/95 px-3 py-1 text-[11px] text-foreground shadow">
            Hold over an action
          </div>
          {(state.layer === "hold" ? TOUCH_HOLD_ITEMS : TOUCH_MENU_ITEMS).map((item) => {
            const Icon =
              item.action === "scroll"
                ? ArrowDownUpIcon
                : item.action === "drag"
                  ? MousePointer2Icon
                  : item.action === "right-click"
                    ? MousePointerClickIcon
                    : HandIcon;
            const active = state.hovered === item.action;
            return (
              <div
                key={item.action}
                className={`absolute flex size-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-full border bg-background text-foreground shadow-lg ${active ? "border-primary" : "border-border"}`}
                style={{ left: item.x, top: item.y }}
              >
                <Icon className="size-5" />
                <span className="text-[10px] font-medium">{item.label}</span>
                {active && (
                  <svg
                    className="absolute inset-0 size-full -rotate-90 text-primary"
                    viewBox="0 0 64 64"
                    aria-hidden="true"
                  >
                    <circle
                      cx="32"
                      cy="32"
                      r="30"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeDasharray="188.5"
                      strokeDashoffset="188.5"
                    >
                      <animate
                        attributeName="stroke-dashoffset"
                        from="188.5"
                        to="0"
                        dur={`${TOUCH_MENU_DWELL_MS}ms`}
                        fill="freeze"
                      />
                    </circle>
                  </svg>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>,
    document.body,
  );
}
