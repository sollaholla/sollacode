import { describe, expect, it } from "vite-plus/test";

import { preservePopupOpenerHeaders } from "./CrossOriginOpenerPolicy.ts";

describe("preservePopupOpenerHeaders", () => {
  it.each(["same-origin", "same-origin-allow-popups", "restrict-properties"])(
    "keeps an OAuth popup connected when COOP is %s",
    (policy) => {
      const result = preservePopupOpenerHeaders({
        "Content-Type": ["text/html"],
        "Cross-Origin-Opener-Policy": [`${policy}; report-to="coop"`],
        "Cross-Origin-Opener-Policy-Report-Only": ["same-origin"],
      });

      expect(result).toEqual({
        changed: true,
        responseHeaders: {
          "Content-Type": ["text/html"],
          "Cross-Origin-Opener-Policy": ["unsafe-none"],
          "Cross-Origin-Opener-Policy-Report-Only": ["same-origin"],
        },
      });
    },
  );

  it("leaves compatible and unrelated headers byte-for-byte unchanged", () => {
    const headers = {
      "cross-origin-opener-policy": ["unsafe-none"],
      "cross-origin-opener-policy-report-only": ["same-origin"],
      "set-cookie": ["session=opaque"],
    };

    const result = preservePopupOpenerHeaders(headers);

    expect(result.changed).toBe(false);
    expect(result.responseHeaders).toBe(headers);
  });
});
