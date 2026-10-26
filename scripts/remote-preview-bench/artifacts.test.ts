import { describe, expect, it } from "vite-plus/test";

import { sceneSampleLabel } from "./artifacts.ts";

describe("preview benchmark evidence", () => {
  it("keeps every default loopback and slow-link sample under a distinct name", () => {
    const labels: string[] = [];
    for (const scene of ["idle", "ticks", "caret", "spinner", "typing", "scroll", "video"]) {
      for (const mode of ["old", "new", "new-native"]) {
        for (const viewer of mode === "old" ? ["shared-node"] : ["phone", "desktop"]) {
          labels.push(sceneSampleLabel({ scene, mode, viewer, condition: "loopback" }));
        }
      }
    }
    for (const scene of ["ticks", "scroll"]) {
      for (const mode of ["old", "new", "new-native"]) {
        labels.push(
          sceneSampleLabel({
            scene,
            mode,
            viewer: mode === "old" ? "shared-node" : "phone",
            condition: "slow",
          }),
        );
      }
    }
    expect(labels).toHaveLength(41);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
