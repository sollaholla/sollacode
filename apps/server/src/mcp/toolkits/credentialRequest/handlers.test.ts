import { describe, expect, it } from "vite-plus/test";

import { credentialRequestOrigin } from "./handlers.ts";
import { credentialRequestQuestion } from "./prompt.ts";

describe("credentialRequestOrigin", () => {
  it("files a login under the page's exact origin", () => {
    expect(credentialRequestOrigin("https://app.example.com/login?next=/")).toBe(
      "https://app.example.com",
    );
    expect(credentialRequestOrigin("http://localhost:5173/login")).toBe("http://localhost:5173");
  });

  it("refuses places a secret must not be offered", () => {
    expect(credentialRequestOrigin(null)).toBeNull();
    expect(credentialRequestOrigin("http://app.example.com/login")).toBeNull();
    expect(credentialRequestOrigin("about:blank")).toBeNull();
    expect(credentialRequestOrigin("not a url")).toBeNull();
  });
});

describe("credentialRequestQuestion", () => {
  // Clients drop a question with no options, which would hide the card.
  it("always carries an option", () => {
    for (const mode of ["password", "code", "person", "passkey"] as const) {
      const question = credentialRequestQuestion({
        origin: "https://app.example.com",
        mode,
        reason: "Acme needs a login",
      });
      expect(question.options.length).toBeGreaterThan(0);
      expect(question.question).toContain("app.example.com");
      expect(question.question).toContain("Acme needs a login");
    }
  });
});
