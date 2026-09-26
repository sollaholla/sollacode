import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderApiKeyAccountId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);

/** Public metadata only. Credential values never belong in settings snapshots. */
export const ProviderApiKeyAccount = Schema.Struct({
  id: ProviderApiKeyAccountId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  baseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  credentialId: ProviderApiKeyAccountId,
  keySuffix: Schema.String.check(Schema.isMaxLength(4)),
});
export type ProviderApiKeyAccount = typeof ProviderApiKeyAccount.Type;

export const ProviderApiKeyAccounts = Schema.Struct({
  accounts: Schema.Array(ProviderApiKeyAccount).check(Schema.isMaxLength(20)),
  activeAccountId: Schema.NullOr(ProviderApiKeyAccountId),
});
export type ProviderApiKeyAccounts = typeof ProviderApiKeyAccounts.Type;

/** A write-only settings operation, applied under the server settings lock. */
export const ProviderApiKeyAccountAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("save"),
    instanceId: ProviderInstanceId,
    id: ProviderApiKeyAccountId,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
    baseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
    apiKey: Schema.optionalKey(
      TrimmedNonEmptyString.check(Schema.isMaxLength(4096), Schema.isPattern(/^\S+$/)),
    ),
    activate: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("select"),
    instanceId: ProviderInstanceId,
    id: Schema.NullOr(ProviderApiKeyAccountId),
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
    id: ProviderApiKeyAccountId,
  }),
]);
export type ProviderApiKeyAccountAction = typeof ProviderApiKeyAccountAction.Type;
