/**
 * The container style shared by the cards stacked above the composer.
 *
 * The queued-message card and the background-task panel sit directly on top of
 * one another, so any difference between them reads as a mistake rather than a
 * distinction: the owner saw one full-width and opaque above one inset and
 * translucent and asked for a single look. Keeping the string in one place is
 * what stops them drifting apart again.
 *
 * The inset is deliberate. These cards float over the transcript rather than
 * belonging to it, and pulling them in from the message column's own width is
 * what makes them read as an overlay instead of another message.
 */
export const COMPOSER_STACK_SURFACE_CLASS_NAME =
  "mx-auto w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] overflow-hidden rounded-xl border border-border/70 bg-background/95 shadow-sm backdrop-blur";
