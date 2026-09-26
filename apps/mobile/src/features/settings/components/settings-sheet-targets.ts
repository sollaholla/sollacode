export type SettingsSheetTarget =
  | "SettingsEnvironments"
  | "SettingsCredentials"
  | "SettingsArchive"
  | "SettingsAppearance"
  | "SettingsClientStorage";

/**
 * Root-stack screens a settings row can push to, escaping the settings sheet.
 * These present full screen rather than at a sheet detent.
 */
export type SettingsFullScreenTarget = "SettingsLegal" | "Orchestrator" | "Agents";
