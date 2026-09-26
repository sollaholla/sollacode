import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "./button";
import { GroupSeparator } from "./group";

/** Compact header actions share the agent glyph's rounded, outlined surface. */
export function ToolbarControl({
  className,
  size = "xs",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant">) {
  return (
    <Button
      {...props}
      variant="ghost"
      size={size}
      data-toolbar-control
      className={cn(
        "h-7 min-w-7 gap-1.5 rounded-[10px] border-[var(--line)] bg-transparent px-2.5 text-xs text-foreground shadow-none transition-[background-color,border-color,color] duration-150 before:hidden hover:border-foreground/40 [:hover,[data-pressed]]:bg-transparent data-pressed:border-foreground/40 data-pressed:bg-transparent focus-visible:ring-gold-500/40 disabled:opacity-60 sm:h-7 sm:text-xs [&_svg]:mx-0 [&_svg:not([class*='text-'])]:text-current [&_svg:not([class*='opacity-'])]:opacity-100",
        size === "icon-xs" && "w-7 px-0 sm:w-7",
        className,
      )}
    />
  );
}

/** Keep split-action dividers as quiet as their shared outside border. */
export function ToolbarControlSeparator({
  className,
  ...props
}: ComponentProps<typeof GroupSeparator>) {
  return <GroupSeparator {...props} className={cn("bg-[var(--line)] before:hidden", className)} />;
}
