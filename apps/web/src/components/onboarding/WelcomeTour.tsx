import { ArrowLeftIcon, ArrowRightIcon, RotateCcwIcon } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { WelcomeIllustration } from "./WelcomeIllustrations";
import { searchShortcutLabel, WELCOME_TOUR_STEPS } from "./welcomeTour.logic";
import "./welcomeTour.css";

type Direction = "forward" | "back";

const SWIPE_DISTANCE_PX = 56;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The few ideas needed to use the app, one per step. Next, Back, the arrow keys,
 * and a swipe all move through it. Skip and Escape leave from anywhere.
 */
export function WelcomeTour({
  initialStep = 0,
  doneLabel,
  onStepChange,
  onDone,
  onBackFromStart,
}: {
  readonly initialStep?: number;
  readonly doneLabel: string;
  readonly onStepChange?: (step: number) => void;
  readonly onDone: () => void;
  /** Where Back goes from the first step, when there is somewhere to go. */
  readonly onBackFromStart?: () => void;
}) {
  const [{ step, leaving, direction }, setView] = useState<{
    readonly step: number;
    readonly leaving: number | null;
    readonly direction: Direction;
  }>({ step: initialStep, leaving: null, direction: "forward" });
  const touch = useMediaQuery("(pointer: coarse)");
  const shortcut = searchShortcutLabel(typeof navigator === "undefined" ? "" : navigator.platform);
  const [playCount, setPlayCount] = useState(0);
  const nextRef = useRef<HTMLButtonElement>(null);
  const dragTarget = useRef<HTMLDivElement>(null);
  const drag = useRef<{ readonly x: number; readonly y: number; dx: number } | null>(null);
  const isLast = step === WELCOME_TOUR_STEPS.length - 1;

  // On the same button throughout, so Enter keeps moving forward. A phone has no
  // Enter to press, and focus there would only draw a ring around the button.
  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) {
      nextRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const goTo = (target: number) => {
    if (target < 0 || target >= WELCOME_TOUR_STEPS.length || target === step) return;
    onStepChange?.(target);
    setView({
      step: target,
      // Nothing would ever end a leaving animation that is not running.
      leaving: prefersReducedMotion() ? null : step,
      direction: target > step ? "forward" : "back",
    });
  };
  const next = () => (isLast ? onDone() : goTo(step + 1));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") goTo(step + 1);
    else if (event.key === "ArrowLeft") {
      if (step === 0) onBackFromStart?.();
      else goTo(step - 1);
    } else if (event.key === "Escape") onDone();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const moveDragTarget = (dx: number) => {
    const target = dragTarget.current;
    if (!target) return;
    target.style.transform = dx === 0 ? "" : `translate3d(${dx}px, 0, 0)`;
    target.style.transition = dx === 0 ? "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)" : "none";
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    drag.current = { x: event.clientX, y: event.clientY, dx: 0 };
  };
  const onPointerMove = (event: PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    if (Math.abs(event.clientY - current.y) > Math.abs(dx)) return;
    current.dx = dx;
    moveDragTarget(dx * 0.6);
  };
  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    moveDragTarget(0);
    if (!current) return;
    if (current.dx <= -SWIPE_DISTANCE_PX) goTo(step + 1);
    else if (current.dx >= SWIPE_DISTANCE_PX) goTo(step - 1);
  };

  const renderPanel = (index: number, leavingPanel: boolean) => {
    const content = WELCOME_TOUR_STEPS[index]!;
    const body = (touch && "touchBody" in content ? content.touchBody : content.body).replace(
      "{shortcut}",
      shortcut,
    );
    return (
      <div
        key={content.id}
        aria-hidden={leavingPanel || undefined}
        inert={leavingPanel || undefined}
        data-welcome-tour-step={content.id}
        className={cn(
          "col-start-1 row-start-1 flex min-w-0 flex-col",
          leavingPanel ? `wt-panel-exit-${direction}` : `wt-panel-enter-${direction}`,
        )}
        onAnimationEnd={
          leavingPanel
            ? (event) => {
                if (event.target !== event.currentTarget) return;
                setView((view) => ({ ...view, leaving: null }));
              }
            : undefined
        }
      >
        <WelcomeIllustration key={playCount} step={content.id} shortcut={touch ? null : shortcut} />
        <div className="mt-6 flex items-start justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {content.title}
          </h1>
          <button
            type="button"
            aria-label="Play the picture again"
            title="Play again"
            className="wt-replay -me-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            onClick={() => setPlayCount((count) => count + 1)}
          >
            <RotateCcwIcon aria-hidden className="size-4" />
          </button>
        </div>
        <p className="mt-2 min-h-12 text-[15px] leading-6 text-muted-foreground">{body}</p>
      </div>
    );
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Arrow keys and Escape reach this from the buttons inside.
    <div
      className="wt-root mx-auto flex min-h-full w-full max-w-md flex-1 flex-col px-5 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:justify-center sm:pb-12"
      data-testid="welcome-tour"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-3">
        <ol
          aria-label={`Step ${step + 1} of ${WELCOME_TOUR_STEPS.length}`}
          className="flex min-w-0 flex-1 gap-1.5"
        >
          {WELCOME_TOUR_STEPS.map((item, index) => (
            <li
              key={item.id}
              aria-current={index === step ? "step" : undefined}
              className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/10"
            >
              <span
                className="wt-progress-fill block h-full rounded-full bg-gold-500"
                style={{ transform: index <= step ? "none" : "scaleX(0)" }}
              />
            </li>
          ))}
        </ol>
        <Button
          variant="ghost"
          size="sm"
          // The last step's main button already leaves.
          className={cn(isLast && "invisible")}
          onClick={onDone}
          data-testid="welcome-tour-skip"
        >
          Skip
        </Button>
      </div>

      <div
        ref={dragTarget}
        aria-live="polite"
        className="my-auto grid touch-pan-y py-5 sm:my-0 sm:py-6"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {leaving !== null ? renderPanel(leaving, true) : null}
        {renderPanel(step, false)}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="lg"
          className={cn("shrink-0", step === 0 && !onBackFromStart && "invisible")}
          onClick={() => (step === 0 ? onBackFromStart?.() : goTo(step - 1))}
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
          Back
        </Button>
        <Button
          ref={nextRef}
          size="lg"
          className="ms-auto min-w-32 max-sm:flex-1"
          data-testid="welcome-tour-next"
          onClick={next}
        >
          {isLast ? doneLabel : "Next"}
          <ArrowRightIcon aria-hidden className="size-4" />
        </Button>
      </div>
    </div>
  );
}
