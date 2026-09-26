/** Jev uses System One requests and cannot serve an OpenCode text-generation turn. */
export function isOpenCodeDecisionModel(slug: string): boolean {
  return /(?:^|\/)jev(?:$|-(?:latest|\d)(?:[\w.-]*))$/i.test(slug.trim());
}
