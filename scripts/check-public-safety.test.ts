import { describe, expect, it } from "vite-plus/test";

import { addedLines, findProblem, hashTerm, termCandidates } from "./check-public-safety.ts";

const rules = {
  termHashes: new Set([hashTerm("Harbor Light"), hashTerm("zephyrine"), hashTerm("10.9.8.7")]),
  localTerms: new Set(["quillfeather"]),
  checkNewTextPatterns: true,
};

describe("termCandidates", () => {
  it("finds a term however it is written", () => {
    for (const written of [
      "Harbor Light",
      "harbor-light",
      "HarborLight",
      "harborLightTests",
      "agent_harbor_light",
    ]) {
      expect(termCandidates(written).has("harborlight"), written).toBe(true);
    }
  });
});

describe("findProblem", () => {
  it("catches names on the private list in every spelling, without storing them", () => {
    expect(findProblem("Open the Harbor Light project", rules)).toContain("private list");
    expect(findProblem('label: "Zephyrine\'s Laptop"', rules)).toContain("private list");
    expect(findProblem("D:\\ZEPHYRINE\\Temp", rules)).toContain("private list");
    expect(findProblem("http://10.9.8.7:3773", rules)).toContain("private list");
  });

  it("catches a project on this computer that no list has heard of", () => {
    expect(findProblem("/Users/me/Desktop/QuillFeather/render.png", rules)).toContain(
      "this computer",
    );
  });

  it("catches a real tailnet address but not a made-up one", () => {
    expect(findProblem(`https://mac${".tail"}0a1b2c.ts.net/`, rules)).toContain("tailnet");
    expect(findProblem("https://studio-macbook.example.ts.net/", rules)).toBeNull();
  });

  it("catches real email addresses but not examples or package versions", () => {
    expect(findProblem(`from ${"person"}@${"company.io"}`, rules)).toContain("email");
    expect(findProblem("work@example.com", rules)).toBeNull();
    expect(findProblem("Co-Authored-By: Claude <noreply@anthropic.com>", rules)).toBeNull();
    expect(findProblem("pnpm@10.24.0 and @t3tools/contracts", rules)).toBeNull();
  });

  it("catches credentials in new text", () => {
    expect(findProblem(`token: ${"ghp_"}${"a".repeat(24)}`, rules)).toContain("GitHub");
    expect(findProblem(`key: ${"sk-ant-"}${"a".repeat(24)}`, rules)).toContain("API key");
    expect(findProblem(`${"-----BEGIN "}PRIVATE KEY-----`, rules)).toContain("private key");
  });

  it("leaves ordinary code alone", () => {
    for (const line of [
      "const harbor = beacon;",
      "Scout (Studio Mac)",
      "/Users/me/report.pdf",
      "Fix the login bug",
    ]) {
      expect(findProblem(line, rules), line).toBeNull();
    }
  });

  it("does not hold old fixtures to the rules for new text", () => {
    expect(
      findProblem(`from ${"person"}@${"company.io"}`, { ...rules, checkNewTextPatterns: false }),
    ).toBeNull();
  });
});

describe("addedLines", () => {
  it("reads added lines and new paths, and skips removed ones", () => {
    const diff = ["+++ b/src/new-name.ts", "@@ -1 +1 @@", "-old line", "+new line"].join("\n");
    expect(addedLines(diff)).toEqual([
      { file: "src/new-name.ts", text: "src/new-name.ts" },
      { file: "src/new-name.ts", text: "new line" },
    ]);
  });
});
