import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { shouldShowCommandPaletteKeybindingLegend } from "./CommandPalette.presentation";
import { Command, CommandFooter, CommandInput, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

type CommandPaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly escapeLabel?: ReactNode;
  readonly footerActionLabel?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  readonly panelClassName?: string;
  readonly showBackHint?: boolean;
  readonly testId?: string;
};

/**
 * Shared command palette chrome. Palette modes provide their query behavior,
 * results, and optional input accessory while retaining one input, panel, and
 * keyboard-hint gutter.
 */
export function CommandPaletteContent({
  children,
  escapeLabel = "Close",
  footerActionLabel,
  footerTrailing,
  inputAccessory,
  inputProps,
  panelClassName,
  showBackHint,
  testId,
  ...commandProps
}: CommandPaletteContentProps) {
  // Keyboard hints are noise on a touch device with no keyboard, and on a
  // narrow viewport they push the palette's own results off screen. Lives here
  // rather than in the palette because this component now owns the footer for
  // every palette mode.
  const isNarrowViewport = useMediaQuery("max-sm");
  const hasCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const showKeybindingLegend = shouldShowCommandPaletteKeybindingLegend({
    isNarrowViewport,
    hasCoarsePointer,
  });

  return (
    <div className="contents" data-testid={testId}>
      <Command {...commandProps}>
        <div className="relative">
          <CommandInput {...inputProps} />
          {inputAccessory}
        </div>
        <CommandPanel className={panelClassName}>{children}</CommandPanel>
        {showKeybindingLegend || footerTrailing ? (
          <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
            {showKeybindingLegend ? (
              <div className="flex items-center gap-3">
                <KbdGroup className="items-center gap-1.5">
                  <Kbd>
                    <ArrowUpIcon />
                  </Kbd>
                  <Kbd>
                    <ArrowDownIcon />
                  </Kbd>
                  <span>Navigate</span>
                </KbdGroup>
                {footerActionLabel !== undefined ? (
                  <KbdGroup className="items-center gap-1.5">
                    <Kbd>Enter</Kbd>
                    <span>{footerActionLabel}</span>
                  </KbdGroup>
                ) : null}
                {showBackHint ? (
                  <KbdGroup className="items-center gap-1.5">
                    <Kbd>Backspace</Kbd>
                    <span>Back</span>
                  </KbdGroup>
                ) : null}
                <KbdGroup className="items-center gap-1.5">
                  <Kbd>Esc</Kbd>
                  <span>{escapeLabel}</span>
                </KbdGroup>
              </div>
            ) : null}
            {footerTrailing}
          </CommandFooter>
        ) : null}
      </Command>
    </div>
  );
}
