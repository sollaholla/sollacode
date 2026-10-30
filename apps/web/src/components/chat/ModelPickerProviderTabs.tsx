import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerSelectable,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/**
 * Hover copy for a provider chip that cannot be chosen. Uses the entry's
 * configured `displayName` so custom instances read as the person named them
 * (e.g. "Codex Personal — Unavailable.").
 */
function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label} — Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label} — ${kind}. ${msg}` : `${label} — ${kind}.`;
}

const CHIP_CLASS =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors pointer-coarse:h-9 pointer-coarse:px-3.5 pointer-coarse:text-sm focus-visible:ring-2 focus-visible:ring-ring/60";
const CHIP_IDLE_CLASS = "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground";
const CHIP_ACTIVE_CLASS = "bg-foreground/10 text-foreground";
const CHIP_DISABLED_CLASS = "cursor-not-allowed opacity-40 hover:bg-transparent";

/**
 * One row of provider chips above the model list: Favorites, then one chip per
 * configured instance. Scrolls sideways when the providers outgrow the row; a
 * vertical wheel scrolls it too, since most mice have no horizontal wheel.
 */
export const ModelPickerProviderTabs = memo(function ModelPickerProviderTabs(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  /** One chip per entry, keyed by `instanceId`, so custom instances get their own. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Render the Favorites chip. */
  showFavorites?: boolean;
  /** Instance ids shown but unavailable for the current picker context. */
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  /** Overrides the row's inline padding, e.g. to line up with a wider phone layout. */
  className?: string | undefined;
}) {
  const showFavorites = props.showFavorites ?? true;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const updateOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    const start = scroller.scrollLeft > 1;
    const end = maxScroll - scroller.scrollLeft > 1;
    setOverflow((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, []);

  // Keep the selected chip in view: opening the picker on a provider far down
  // the row, or switching with the keyboard, should not leave it clipped.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const chip = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (chip) {
      const padding = 12;
      const left = chip.offsetLeft - padding;
      const right = chip.offsetLeft + chip.offsetWidth + padding;
      if (left < scroller.scrollLeft) {
        scroller.scrollLeft = left;
      } else if (right > scroller.scrollLeft + scroller.clientWidth) {
        scroller.scrollLeft = right - scroller.clientWidth;
      }
    }
    updateOverflow();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Adding, removing or reordering providers moves the selected chip, so it re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    updateOverflow,
  ]);

  return (
    <div
      ref={scrollerRef}
      className={cn(
        "relative flex shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain px-2 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        overflow.start && overflow.end
          ? "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]"
          : overflow.start
            ? "[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]"
            : overflow.end
              ? "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]"
              : null,
        props.className,
      )}
      data-model-picker-providers="true"
      onScroll={updateOverflow}
      onWheel={(event) => {
        const scroller = scrollerRef.current;
        if (!scroller || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        scroller.scrollLeft += event.deltaY;
      }}
    >
      {showFavorites ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  CHIP_CLASS,
                  "px-2 pointer-coarse:px-2.5",
                  props.selectedInstanceId === "favorites" ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS,
                )}
                aria-label="Favorites"
                aria-pressed={props.selectedInstanceId === "favorites"}
                data-model-picker-provider="favorites"
                onClick={() => props.onSelectInstance("favorites")}
              >
                <StarIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 pointer-coarse:size-4",
                    props.selectedInstanceId === "favorites" && "fill-amber-400 text-amber-400",
                  )}
                />
              </button>
            }
          />
          <TooltipPopup side="top">Favorites</TooltipPopup>
        </Tooltip>
      ) : null}

      {props.instanceEntries.map((entry) => {
        const isNotReady = !isProviderInstancePickerReady(entry);
        const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
        const isDisabled = !isProviderInstancePickerSelectable(entry) || isContextDisabled;
        const isSelected = props.selectedInstanceId === entry.instanceId;
        const tooltip = isNotReady
          ? describeUnavailableInstance(entry)
          : isContextDisabled
            ? (props.getDisabledInstanceTooltip?.(entry) ?? null)
            : null;

        const chip = (
          <button
            key={entry.instanceId}
            type="button"
            className={cn(
              CHIP_CLASS,
              isSelected ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS,
              isDisabled && CHIP_DISABLED_CLASS,
            )}
            aria-label={isDisabled && tooltip ? tooltip : entry.displayName}
            aria-pressed={isSelected}
            data-model-picker-provider={entry.instanceId}
            data-provider-accent-color={entry.accentColor}
            disabled={isDisabled}
            onClick={() => props.onSelectInstance(entry.instanceId)}
          >
            <ProviderInstanceIcon
              driverKind={entry.driverKind}
              displayName={entry.displayName}
              className="size-4"
              iconClassName="size-3.5 pointer-coarse:size-4"
            />
            <span>{entry.displayName}</span>
            {entry.accentColor ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: entry.accentColor }}
              />
            ) : null}
          </button>
        );

        if (!tooltip) {
          return chip;
        }
        return (
          <Tooltip key={entry.instanceId}>
            {/* Disabled buttons swallow pointer events; the span carries the hover. */}
            <TooltipTrigger render={<span className="shrink-0">{chip}</span>} />
            <TooltipPopup side="top" className="max-w-64 text-balance leading-snug">
              {tooltip}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
});
