const DISCLOSURE_SELECTOR =
  "[aria-expanded]:not([aria-haspopup]), [data-timeline-disclosure], summary";

interface DisclosureAnchor {
  readonly element: HTMLElement;
  readonly rowId: string;
  readonly controlIndex: number;
  readonly top: number;
}

/** Keeps the clicked disclosure in place through virtualized row measurements. */
export function captureTimelineDisclosure(
  scroller: HTMLElement,
  target: EventTarget | null,
): DisclosureAnchor | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(DISCLOSURE_SELECTOR);
  if (!element || !scroller.contains(element)) return null;
  const row = element.closest<HTMLElement>("[data-timeline-row-id]");
  if (!row?.dataset.timelineRowId) return null;
  return {
    element,
    rowId: row.dataset.timelineRowId,
    controlIndex: Array.from(row.querySelectorAll(DISCLOSURE_SELECTOR)).indexOf(element),
    top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
  };
}

export function restoreTimelineDisclosure(scroller: HTMLElement, anchor: DisclosureAnchor): void {
  // A list may remount the row when inserting/removing its neighbours. Resolve
  // the same control by row identity instead of holding a detached DOM node.
  const element = scroller.contains(anchor.element)
    ? anchor.element
    : Array.from(scroller.querySelectorAll<HTMLElement>("[data-timeline-row-id]"))
        .find((row) => row.dataset.timelineRowId === anchor.rowId)
        ?.querySelectorAll<HTMLElement>(DISCLOSURE_SELECTOR)[anchor.controlIndex];
  if (!element) return;
  const delta =
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) > 0.5) {
    scroller.scrollTop += delta;
  }
}

/** Uses the browser's measured extent, including images and the footer. */
export function followTimelineEnd(scroller: HTMLElement): void {
  const end = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (Math.abs(scroller.scrollTop - end) > 0.5) scroller.scrollTop = end;
}
