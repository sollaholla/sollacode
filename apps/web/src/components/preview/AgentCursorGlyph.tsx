/** The agent cursor's shape and blue, small enough to sit in a tab strip.
 *
 *  Deliberately the same silhouette and blue as the overlay cursor in
 *  `AgentBrowserCursor`: the badge on a tab and the pointer moving inside it
 *  have to read as the same thing, or the badge is just another blue dot. The
 *  path is duplicated rather than shared because the overlay's gradient fill
 *  and glow are what make it legible over an arbitrary page, and both
 *  disappear into mud at 12px. */
export function AgentCursorGlyph(props: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={props.className} aria-hidden="true">
      <path
        d="m4 4 7.07 17 2.51-7.39L21 11.07z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        paintOrder="stroke"
      />
    </svg>
  );
}
