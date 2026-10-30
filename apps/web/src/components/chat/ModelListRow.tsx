import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { CheckIcon, LockIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * One model in the picker: a single line with the name, an optional muted
 * detail, and a trailing column for the shortcut, favorite star and the check
 * that marks the current model.
 */
export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * The instance's configured name, e.g. "Codex Personal". Shown as the muted
   * detail only when `showProviderName` is set, because the icon alone cannot
   * tell two instances of one driver apart.
   */
  providerDisplayName: string;
  isFavorite: boolean;
  isSelected: boolean;
  /** Lead with the provider icon. For lists that mix providers (Favorites, search). */
  showProviderIcon: boolean;
  showProviderName?: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = props.showProviderIcon
    ? (PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null)
    : null;
  const detail = [
    props.showProviderName ? props.providerDisplayName : null,
    props.model.subProvider ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const isDisabled = Boolean(props.disabledReason);

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      disabled={isDisabled}
      contentClassName="flex w-full min-w-0 items-center gap-2.5"
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer rounded-md px-2 py-1.5 text-sm pointer-coarse:px-3 pointer-coarse:py-2",
        "hover:bg-foreground/[0.05] data-highlighted:bg-foreground/[0.06] data-selected:bg-transparent data-selected:text-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.06] [&[data-highlighted][data-selected]]:text-foreground",
        isDisabled &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:opacity-45 data-disabled:hover:bg-transparent",
      )}
    >
      {ProviderIcon ? <ProviderIcon aria-hidden className="size-4 shrink-0 opacity-90" /> : null}
      <div className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
        <span
          className={cn(
            "min-w-0 truncate leading-5",
            props.isSelected ? "font-medium text-foreground" : "text-foreground/90",
          )}
        >
          {props.useTriggerLabel
            ? getTriggerDisplayModelLabel(props.model)
            : getDisplayModelName(
                props.model,
                props.preferShortName ? { preferShortName: true } : undefined,
              )}
        </span>
        {detail ? (
          <span className="min-w-0 shrink truncate text-muted-foreground/70 text-xs">{detail}</span>
        ) : null}
        {props.showNewBadge ? (
          <span
            className="shrink-0 self-center rounded-full bg-amber-500/15 px-1.5 py-px font-semibold text-[10px] text-amber-700 uppercase leading-none tracking-wide dark:bg-amber-400/15 dark:text-amber-300"
            aria-label="New model"
          >
            New
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {props.jumpLabel ? (
          <span
            className="hidden font-sans text-[11px] text-muted-foreground/50 tabular-nums pointer-fine:inline"
            aria-hidden
          >
            {props.jumpLabel}
          </span>
        ) : null}
        {isDisabled ? (
          <LockIcon aria-hidden className="mx-1 size-3.5 text-muted-foreground" />
        ) : (
          <button
            type="button"
            className={cn(
              "relative inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-[color,opacity] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60",
              "pointer-coarse:size-8",
              props.isFavorite
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 pointer-coarse:opacity-40",
            )}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleFavorite();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
            aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <StarIcon
              aria-hidden
              className={cn(
                "size-3.5 text-current pointer-coarse:size-4",
                props.isFavorite && "fill-amber-400 text-amber-400",
              )}
            />
          </button>
        )}
        <span className="flex size-4 items-center justify-center" aria-hidden>
          {props.isSelected ? <CheckIcon className="size-4 text-primary" /> : null}
        </span>
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center" className="max-w-64 text-balance leading-snug">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
