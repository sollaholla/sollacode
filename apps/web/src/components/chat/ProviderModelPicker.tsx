import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import { XIcon } from "lucide-react";
import type { VariantProps } from "class-variance-authority";
import { buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Button } from "../ui/button";
import { shouldUseFullScreenModelPicker } from "./modelPickerPresentation";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const isPhonePortrait = useMediaQuery(
    "(max-width: 639px) and (orientation: portrait) and (pointer: coarse)",
  );
  const useFullScreenModal = shouldUseFullScreenModelPicker({ isPhonePortrait });

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // If the current slug belongs to a different instance (for example after
  // a provider switch or disable), prefer the active instance's first
  // option so the trigger icon and label stay in sync instead of showing
  // a stale foreign slug.
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const setIsMenuOpen = (open: boolean) => {
    if (open && useFullScreenModal && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    // The portrait Dialog owns its modal scroll lock. Applying the popover
    // lock as well can snapshot an already-hidden body and restore that stale
    // value after close.
    if (!isMenuOpen || useFullScreenModal) {
      return;
    }

    const { documentElement, body } = document;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) => {
      return target instanceof Element && target.closest("[data-model-picker-content]");
    };
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [isMenuOpen, useFullScreenModal]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const trigger = (
    <ComposerControl
      aria-label={
        props.triggerAriaLabel ??
        (props.iconOnly ? `Choose model, currently ${triggerLabel}` : undefined)
      }
      title={props.iconOnly ? triggerLabel : undefined}
      variant={props.triggerVariant ?? "ghost"}
      data-chat-provider-model-picker="true"
      data-chat-composer-control-display={props.iconOnly ? "icon" : "label"}
      className={cn(
        "min-w-0 justify-between whitespace-nowrap",
        props.iconOnly
          ? "size-8 shrink-0 justify-center px-0"
          : props.compact
            ? "max-w-42 shrink-0"
            : "max-w-48 shrink-0 sm:max-w-56",
        props.triggerClassName,
      )}
      disabled={props.disabled}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          props.iconOnly ? "justify-center" : "flex-1",
        )}
      >
        {activeEntry ? (
          <ProviderInstanceIcon
            driverKind={activeEntry.driverKind}
            displayName={activeEntry.displayName}
            accentColor={activeEntry.accentColor}
            showBadge={showInstanceBadge}
            className="size-4"
            iconClassName={cn("size-4", props.activeProviderIconClassName)}
            indicatorBackground="var(--input)"
            badgeClassName={cn(
              "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3",
              "px-0.5 text-[7px]",
            )}
          />
        ) : null}
        {props.iconOnly ? null : (
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
              {triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
          </Tooltip>
        )}
      </span>
      {props.iconOnly ? null : (
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron />
        </span>
      )}
    </ComposerControl>
  );

  const content = (
    <ModelPickerContent
      activeInstanceId={activeInstanceId}
      model={props.model}
      lockedProvider={props.lockedProvider}
      lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
      instanceEntries={props.instanceEntries}
      {...(props.keybindings ? { keybindings: props.keybindings } : {})}
      modelOptionsByInstance={props.modelOptionsByInstance}
      terminalOpen={props.terminalOpen ?? false}
      fullScreen={useFullScreenModal}
      onRequestClose={() => setIsMenuOpen(false)}
      {...(props.getModelDisabledReason
        ? { getModelDisabledReason: props.getModelDisabledReason }
        : {})}
      onInstanceModelChange={handleInstanceModelChange}
    />
  );

  if (useFullScreenModal) {
    return (
      <Dialog
        open={isMenuOpen}
        onOpenChange={(open) => {
          if (props.disabled) {
            setIsMenuOpen(false);
            return;
          }
          setIsMenuOpen(open);
        }}
      >
        <DialogTrigger render={trigger} />
        <DialogPopup
          bottomStickOnMobile={false}
          showCloseButton={false}
          className="fixed inset-0 h-dvh max-h-none w-screen max-w-none overflow-hidden rounded-none border-0 bg-popover p-0"
          data-model-picker-phone-portrait="true"
        >
          <div className="relative flex h-full min-h-0 flex-col overscroll-contain">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3 pt-[env(safe-area-inset-top)]">
              <DialogTitle className="text-base">Choose model</DialogTitle>
              <Button
                size="icon-xl"
                variant="ghost"
                className="touch-manipulation"
                aria-label="Close model picker"
                onClick={() => setIsMenuOpen(false)}
              >
                <XIcon aria-hidden />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden overscroll-contain">{content}</div>
          </div>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
        viewportClassName="rounded-lg !overflow-hidden p-0"
      >
        {content}
      </PopoverPopup>
    </Popover>
  );
});
