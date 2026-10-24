import { memo, useCallback, useRef, useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Whether the title is actually clipped by its box. Only then is there
 * anything to expand; a short title that fits has no reason to open a popup.
 */
export function isThreadTitleTruncated(
  element: { readonly scrollWidth: number; readonly clientWidth: number } | null,
): boolean {
  return element !== null && element.scrollWidth > element.clientWidth;
}

/**
 * The thread name in the header, truncated to one line. Tapping it (or
 * hovering with a mouse) shows the full name in a popover: the header is a
 * fixed-height row, so expanding in place would push the whole window down,
 * and a hover-only tooltip is unreachable on a phone.
 */
export const ThreadTitle = memo(function ThreadTitle(props: { readonly title: string }) {
  const { title } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const handleOpenChange = useCallback((next: boolean) => {
    if (next && !isThreadTitleTruncated(triggerRef.current)) return;
    setOpen(next);
  }, []);

  return (
    <h2
      aria-label={title}
      className="min-w-20 flex-1 text-sm font-medium text-foreground"
      data-thread-title
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          ref={triggerRef}
          openOnHover
          delay={500}
          className="block w-full min-w-0 cursor-pointer truncate rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title}
        </PopoverTrigger>
        <PopoverPopup
          tooltipStyle
          side="bottom"
          align="start"
          className="max-w-[min(36rem,calc(100vw-1.5rem))]"
        >
          <span className="select-text whitespace-normal break-words text-sm text-foreground">
            {title}
          </span>
        </PopoverPopup>
      </Popover>
    </h2>
  );
});
