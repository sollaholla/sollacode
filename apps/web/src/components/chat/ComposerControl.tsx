import type { ComponentProps } from "react";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SelectTrigger } from "../ui/select";

// Composer controls are 32px circles (pills once they carry a label) on the
// row surface with the shared 1px edge — the same shape family as the header's
// action buttons, so the two rows of controls read as one system.
const composerControlClassName =
  "h-8 min-h-8 min-w-8 gap-1.5 rounded-full sm:h-8 sm:min-h-8 border border-[var(--line)] bg-surface-row px-2 text-foreground/80 transition-colors hover:bg-surface-hover hover:text-foreground [&_svg[data-composer-control-icon]]:mx-0 [&_svg[data-composer-control-chevron]]:-mx-0.5";

export function ComposerControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(composerControlClassName, className)}
      size={size}
      variant={variant}
      {...props}
    />
  );
}

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
}: {
  icon: LucideIcon;
  className?: string | undefined;
  opticalSize?: "default" | "large";
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cn("shrink-0", opticalSize === "large" ? "size-4.5" : "size-4", className)}
      data-composer-control-icon
    />
  );
}

export function ComposerControlChevron() {
  return (
    <ChevronDownIcon
      aria-hidden="true"
      className="-mx-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      data-composer-control-chevron
      strokeWidth={2.25}
    />
  );
}

export function ComposerSelectControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(composerControlClassName, className)}
      icon={<ComposerControlChevron />}
      size={size}
      variant={variant}
      {...props}
    />
  );
}
