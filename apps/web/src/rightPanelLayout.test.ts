import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "./rightPanelLayout.ts";

describe("responsive right panel layout", () => {
  it("fills the viewport instead of leaving the conversation visible beside it", () => {
    const classes = new Set(RIGHT_PANEL_SHEET_CLASS_NAME.split(/\s+/));

    NodeAssert.equal(classes.has("h-full"), true);
    NodeAssert.equal(classes.has("w-full"), true);
    NodeAssert.equal(classes.has("max-w-none"), true);
    NodeAssert.equal(classes.has("min-w-0"), true);
    NodeAssert.equal(
      [...classes].some((className) => className.includes("88vw")),
      false,
    );
  });
});
