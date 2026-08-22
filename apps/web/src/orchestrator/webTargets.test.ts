import { describe, expect, it } from "vite-plus/test";

import { resolveWebTarget, supportsQuery, urlFor, WEB_TARGETS } from "./webTargets";

const targetById = (id: string) => {
  const target = WEB_TARGETS.find((candidate) => candidate.id === id);
  if (target === undefined) throw new Error(`no target ${id}`);
  return target;
};

describe("resolveWebTarget", () => {
  it("finds a site by name", () => {
    const resolution = resolveWebTarget("YouTube");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.url).toBe("https://www.youtube.com/");
    }
  });

  it("accepts how a transcriber writes a site name", () => {
    // "open you tube" is what actually arrives, and it is not how the site is
    // spelled. Same word out loud.
    for (const spoken of ["you tube", "You Tube", "youtube", "u tube"]) {
      const resolution = resolveWebTarget(spoken);
      expect(resolution.kind, spoken).toBe("resolved");
      if (resolution.kind === "resolved") expect(resolution.target.id, spoken).toBe("youtube");
    }
  });

  it("folds a spoken query into the site's search", () => {
    const resolution = resolveWebTarget("YouTube", "lofi beats");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.url).toBe("https://www.youtube.com/results?search_query=lofi%20beats");
    }
  });

  it("escapes a query rather than letting it reshape the address", () => {
    // The query is transcribed speech, so it can contain anything; the one
    // thing it must not do is change the URL it lands in.
    const resolution = resolveWebTarget("Google", "a&b=c#d");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.url).toBe("https://www.google.com/search?q=a%26b%3Dc%23d");
      expect(new URL(resolution.url).searchParams.get("q")).toBe("a&b=c#d");
    }
  });

  it("refuses a site it does not know, and says what it does know", () => {
    const resolution = resolveWebTarget("my bank");
    expect(resolution.kind).toBe("not-found");
    if (resolution.kind === "not-found") {
      expect(resolution.known).toContain("YouTube");
    }
  });

  it("refuses an address given instead of a name", () => {
    // The catalog is the whole safety property: an invented hostname must not
    // become an opened page.
    for (const spoken of ["https://evil.example.com", "file:///etc/passwd", "localhost:3773"]) {
      expect(resolveWebTarget(spoken).kind, spoken).toBe("not-found");
    }
  });

  it("asks rather than guessing between two sites that sound alike", () => {
    const resolution = resolveWebTarget("byll", undefined, [
      { id: "a", names: ["Bill"], home: "https://a.example/" },
      { id: "b", names: ["Bille"], home: "https://b.example/" },
    ]);
    expect(resolution.kind).toBe("ambiguous");
  });

  it("prefers an exact name over one that merely sounds alike", () => {
    const resolution = resolveWebTarget("Maps");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") expect(resolution.target.id).toBe("maps");
  });

  it("treats an empty site as not found rather than opening something", () => {
    expect(resolveWebTarget("").kind).toBe("not-found");
    expect(resolveWebTarget("   ").kind).toBe("not-found");
  });
});

describe("urlFor", () => {
  it("opens the home page when a site cannot search", () => {
    const gmail = targetById("gmail");
    expect(supportsQuery(gmail)).toBe(false);
    expect(urlFor(gmail, "invoices")).toBe(gmail.home);
  });

  it("ignores a blank query", () => {
    const youtube = targetById("youtube");
    expect(urlFor(youtube, "   ")).toBe(youtube.home);
  });
});

describe("the catalog itself", () => {
  it("only ever points at https", () => {
    // The Electron side allows http too; there is no reason for anything in a
    // fixed list to need it.
    for (const target of WEB_TARGETS) {
      expect(new URL(target.home).protocol, target.id).toBe("https:");
      if (target.search !== undefined) {
        expect(target.search.startsWith("https://"), target.id).toBe(true);
        expect(target.search.includes("%s"), target.id).toBe(true);
      }
    }
  });

  it("gives every site a spoken name", () => {
    for (const target of WEB_TARGETS) {
      expect(target.names.length, target.id).toBeGreaterThan(0);
    }
  });
});
