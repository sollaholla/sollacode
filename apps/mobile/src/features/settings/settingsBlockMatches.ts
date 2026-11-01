/** Every word typed has to hit one of the words someone would look for this block by. */
export function settingsBlockMatches(
  block: { readonly terms: ReadonlyArray<string> },
  query: string,
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => block.terms.some((term) => term.includes(word)));
}
