import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_COMPOSER_EMOJIS,
  loadRecentComposerEmojis,
  rankComposerEmojis,
  recordComposerEmojiUsage,
  searchComposerEmojis,
} from "./composerEmoji";

function makeStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("composer emoji shortcuts", () => {
  it("starts with five useful defaults", () => {
    expect(loadRecentComposerEmojis(makeStorage())).toEqual(DEFAULT_COMPOSER_EMOJIS);
  });

  it("ranks frequency before recency and fills remaining slots with defaults", () => {
    expect(
      rankComposerEmojis({
        "🚀": { count: 2, lastUsedAt: 10 },
        "✨": { count: 2, lastUsedAt: 20 },
        "🐶": { count: 1, lastUsedAt: 30 },
      }),
    ).toEqual(["✨", "🚀", "🐶", "👍", "❤️"]);
  });

  it("persists selections and immediately updates the ranked shortcuts", () => {
    const storage = makeStorage();
    recordComposerEmojiUsage("🚀", 10, storage);
    recordComposerEmojiUsage("✨", 20, storage);
    expect(recordComposerEmojiUsage("🚀", 30, storage)).toEqual(["🚀", "✨", "👍", "❤️", "😂"]);
    expect(loadRecentComposerEmojis(storage)[0]).toBe("🚀");
  });

  it("searches emoji labels and keywords with every search term", () => {
    expect(searchComposerEmojis("rocket space").map((item) => item.emoji)).toContain("🚀");
    expect(searchComposerEmojis("blue heart").map((item) => item.emoji)).toEqual(["💙"]);
    expect(searchComposerEmojis("does-not-exist")).toEqual([]);
  });

  it("ignores corrupt persisted data", () => {
    const storage = makeStorage({ "t3code:composer-emoji-usage:v1": "not json" });
    expect(loadRecentComposerEmojis(storage)).toEqual(DEFAULT_COMPOSER_EMOJIS);
  });
});
