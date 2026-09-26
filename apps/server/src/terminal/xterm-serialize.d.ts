/** The package's browser declarations inject lib.dom into the Node server.
 * This entry describes the same serializer's supported headless API only. */
declare module "@xterm/addon-serialize/lib/addon-serialize.js" {
  export class SerializeAddon {
    activate(terminal: import("@xterm/headless").Terminal): void;
    serialize(options?: {
      scrollback?: number;
      excludeModes?: boolean;
      excludeAltBuffer?: boolean;
    }): string;
    dispose(): void;
  }
  const addon: { SerializeAddon: typeof SerializeAddon };
  export default addon;
}
