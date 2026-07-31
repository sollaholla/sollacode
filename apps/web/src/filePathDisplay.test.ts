import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });

  it("recovers an absolute Windows image path from a project-prefixed tool path", () => {
    expect(
      formatWorkspaceRelativePath(
        "TerraGen/D:/TerraGen/Temp/billboard_scene_after_dominant_forest.png",
        String.raw`D:\TerraGen`,
      ),
    ).toBe("TerraGen/Temp/billboard_scene_after_dominant_forest.png");
  });

  it("does not prefix an absolute Windows path from a different drive", () => {
    expect(
      formatWorkspaceRelativePath(
        String.raw`D:\TerraGen\Temp\BillboardNormalValidation\conifer_22_5.png`,
        String.raw`C:\Users\Soloman\Desktop\TerraGen`,
      ),
    ).toBe("D:/TerraGen/Temp/BillboardNormalValidation/conifer_22_5.png");
  });
});
