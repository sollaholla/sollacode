import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** Free and total space of the volume holding the environment's state directory. */
export const HostStorage = Schema.Struct({
  totalBytes: NonNegativeInt,
  freeBytes: NonNegativeInt,
});
export type HostStorage = typeof HostStorage.Type;

export const HostBattery = Schema.Struct({
  /** Whole percent, 0-100. */
  percent: NonNegativeInt,
  /** Wall power is connected (charging, or full and idle on the charger). */
  pluggedIn: Schema.Boolean,
});
export type HostBattery = typeof HostBattery.Type;

/**
 * What a user glancing at a remote machine wants to know: is it about to fill
 * its disk or lose power. `battery` is null on a machine that has none (a
 * desktop or a server), so clients omit it rather than render an empty gauge;
 * `storage` is null only when the volume could not be read.
 */
export const HostVitals = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  storage: Schema.NullOr(HostStorage),
  battery: Schema.NullOr(HostBattery),
});
export type HostVitals = typeof HostVitals.Type;
