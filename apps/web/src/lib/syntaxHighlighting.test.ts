import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
}));

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

it("caches the recovered text highlighter for unsupported languages", async () => {
  const textHighlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text"
      ? Promise.resolve(textHighlighter)
      : Promise.reject(new Error("unsupported language")),
  );

  const first = getSyntaxHighlighterPromise("unsupported-test-language", "pierre-dark");
  await expect(first).resolves.toBe(textHighlighter);
  const second = getSyntaxHighlighterPromise("unsupported-test-language", "pierre-dark");

  expect(second).toBe(first);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
});

it("loads each syntax theme into its own highlighter promise", async () => {
  getSharedHighlighter.mockReset();
  getSharedHighlighter.mockImplementation(() => Promise.resolve({} as DiffsHighlighter));

  const pierre = getSyntaxHighlighterPromise("typescript", "pierre-dark");
  const dracula = getSyntaxHighlighterPromise("typescript", "dracula");

  expect(dracula).not.toBe(pierre);
  expect(getSyntaxHighlighterPromise("typescript", "dracula")).toBe(dracula);
  expect(getSharedHighlighter).toHaveBeenLastCalledWith(
    expect.objectContaining({ themes: ["dracula"], langs: ["typescript"] }),
  );
});
