/**
 * Page titles may arrive with UTF-8 punctuation decoded as Windows-1252.
 * Repair the stray A-circumflex before a middle dot or nonbreaking space in
 * tab labels, without re-decoding the title's other Unicode text.
 */
export function formatPreviewTitle(title: string): string {
  return title.replace(/\u00c2(?=[\u00a0\u00b7])/g, "");
}
