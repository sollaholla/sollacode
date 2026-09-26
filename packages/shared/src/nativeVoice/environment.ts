/** Host paths required by the native speech helpers, shared by desktop and server. */
export interface NativeVoiceEnvironment {
  readonly platform: string;
  readonly stateDir: string;
  readonly isPackaged: boolean;
  readonly appRoot: string;
  readonly resourcesPath: string;
  readonly path: { join(...parts: string[]): string };
}
