import { describe, expect, it } from "vite-plus/test";

import { phoneticKey, phoneticPhrase, phoneticSimilarity, soundsLike } from "./phonetics";

describe("phoneticKey", () => {
  it("gives the same key to spellings of the same sound", () => {
    // The reported case: a transcriber that has never seen the product name
    // writes the vowel it thinks it heard.
    expect(phoneticKey("CaraGen")).toBe(phoneticKey("CareGen"));
    expect(phoneticKey("Karagen")).toBe(phoneticKey("CareGen"));
  });

  it("collapses doubled consonants", () => {
    expect(phoneticKey("Solla")).toBe(phoneticKey("Sola"));
  });

  it("resolves the spellings English uses for one sound", () => {
    expect(phoneticKey("Photo")).toBe(phoneticKey("Foto"));
    expect(phoneticKey("night")).toBe(phoneticKey("nite"));
    expect(phoneticKey("Knight")).toBe(phoneticKey("nite"));
    expect(phoneticKey("Zoe")).toBe(phoneticKey("Soe"));
  });

  it("keeps a leading vowel, so a missing first sound still matters", () => {
    // Dropping it outright would make these one word.
    expect(phoneticKey("Ann")).not.toBe(phoneticKey("Nan"));
  });

  it("keeps genuinely different names apart", () => {
    expect(phoneticKey("CareGen")).not.toBe(phoneticKey("Cartogen"));
    expect(phoneticKey("Vera")).not.toBe(phoneticKey("Vermont"));
    expect(phoneticKey("rover")).not.toBe(phoneticKey("medical"));
  });

  it("returns nothing for something with no letters", () => {
    expect(phoneticKey("123")).toBe("");
    expect(phoneticKey("   ")).toBe("");
  });
});

describe("phoneticPhrase", () => {
  it("encodes each word on its own", () => {
    expect(phoneticPhrase("Vera Medical").split(" ")).toHaveLength(2);
    expect(phoneticPhrase("t3-fork")).toBe(phoneticPhrase("T3 Fork"));
  });
});

describe("soundsLike", () => {
  it("accepts the transcriber's spelling of a real name", () => {
    expect(soundsLike("caragen", "CareGen")).toBe(true);
    expect(soundsLike("vera medicul", "Vera Medical")).toBe(true);
  });

  it("ignores where the transcriber put the spaces", () => {
    expect(soundsLike("Care Gen", "CareGen")).toBe(true);
    expect(soundsLike("solla code", "SollaCode")).toBe(true);
  });

  it("refuses two different names", () => {
    expect(soundsLike("rover", "Vera Medical")).toBe(false);
    expect(soundsLike("billing", "CareGen")).toBe(false);
  });

  it("never matches on an unpronounceable query", () => {
    // Silence and punctuation must fall through to the other tiers rather than
    // matching every thread whose title is equally unpronounceable.
    expect(soundsLike("", "CareGen")).toBe(false);
    expect(soundsLike("!!!", "!!!")).toBe(false);
  });
});

describe("phoneticSimilarity", () => {
  it("scores a near-miss above a written comparison would", () => {
    // "Medicul" shares few letter pairs with "Medical" but nearly every sound.
    expect(phoneticSimilarity("vera medicul", "Vera Medical")).toBeGreaterThan(0.9);
  });

  it("stays low for unrelated names", () => {
    expect(phoneticSimilarity("rover", "Vera Medical")).toBeLessThan(0.62);
  });

  it("is 1 for the same sound and 0 when one side is silent", () => {
    expect(phoneticSimilarity("Karagen", "CareGen")).toBe(1);
    expect(phoneticSimilarity("", "CareGen")).toBe(0);
  });
});
