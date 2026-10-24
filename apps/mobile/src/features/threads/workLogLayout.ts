import {
  collectWorkLogImages,
  WORK_LOG_IMAGE_ROW_HEIGHT,
  type WorkLogImage,
} from "@t3tools/client-runtime/state/work-log-images";

import { scaledTypographyLineHeight } from "../../lib/appearancePreferences";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";

// Tool-like activities with a neutral status carry no signal worth a row.
export function visibleWorkLogActivities(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<ThreadFeedActivity> {
  return activities.filter((activity) => !(activity.toolLike && activity.status === "neutral"));
}

// Pre-measurement heights for the feed's getFixedItemSize. Collapsed work-log
// rows are single-line (numberOfLines={1}) inside a min-height that stays
// taller than the text at every supported base font size (text-xs reaches
// 23px at the 22pt maximum, under the 32px min-h-8), so row height is
// deterministic. The "work log" label has no such clamp — its height follows
// the scaled text-2xs line height. Values mirror the classNames below — keep
// them in sync; a mismatch only costs a one-time correction on measure.
const WORK_ROW_HEIGHT = 32; // min-h-8
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_HEADER_PADDING = 2; // pb-0.5 under the "work log" label
const WORK_LOG_BOTTOM_MARGIN = 4; // mb-1

export const WORK_GROUP_TOGGLE_HEIGHT = 36; // min-h-8 (32) + mb-1 (4)

/** A row's images, less those found to be gone or undecodable. */
export function shownWorkLogImages(
  row: ThreadFeedActivity,
  unavailable: ReadonlySet<string>,
): WorkLogImage[] {
  return collectWorkLogImages([row]).filter((image) => !unavailable.has(image.id));
}

export function collapsedWorkLogHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  baseFontSize: number,
  unavailableImages: ReadonlySet<string> = new Set(),
): number {
  const rows = visibleWorkLogActivities(activities);
  if (rows.length === 0) {
    return 0;
  }
  const onlyToolRows = rows.every((row) => row.toolLike);
  const headerHeight =
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.caption, baseFontSize) + WORK_LOG_HEADER_PADDING;
  return (
    WORK_LOG_BOTTOM_MARGIN +
    (onlyToolRows ? 0 : headerHeight) +
    rows.filter((row) => shownWorkLogImages(row, unavailableImages).length > 0).length *
      WORK_LOG_IMAGE_ROW_HEIGHT +
    rows.length * WORK_ROW_HEIGHT +
    (rows.length - 1) * WORK_ROW_GAP
  );
}
