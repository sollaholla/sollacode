import {
  type ProviderApiKeyAccount,
  type ProviderApiKeyAccountAction,
  type ProviderInstanceId,
  type ServerSettings,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

export interface ResolvedProviderApiKey {
  readonly account: ProviderApiKeyAccount;
  readonly apiKey: string;
}

export const makeProviderApiKeyAccounts = Effect.fn("makeProviderApiKeyAccounts")(function* (
  settingsPath: string,
) {
  const secrets = yield* ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const secretName = (instanceId: string, credentialId: string) =>
    `provider-api-key-${instanceId}-${credentialId}`;
  const failure = (instanceId: string, detail: string) =>
    new ServerSettingsError({
      settingsPath,
      operation: "normalize",
      providerInstanceId: instanceId,
      detail,
      cause: new Error(detail),
    });
  const removeSecret = (instanceId: string, credentialId: string) =>
    secrets.remove(secretName(instanceId, credentialId)).pipe(Effect.ignore);

  const resolve = Effect.fn("ProviderApiKeyAccounts.resolve")(function* (
    settings: ServerSettings,
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ResolvedProviderApiKey | null, ServerSettingsError> {
    const configured = settings.providerApiKeyAccounts?.[instanceId];
    if (!configured?.activeAccountId) return null;
    const account = configured.accounts.find((item) => item.id === configured.activeAccountId);
    if (!account)
      return yield* failure(instanceId, "The selected API-key account no longer exists.");
    const stored = yield* secrets
      .get(secretName(instanceId, account.credentialId))
      .pipe(Effect.mapError(() => failure(instanceId, "The saved API key could not be read.")));
    if (Option.isNone(stored))
      return yield* failure(
        instanceId,
        "The selected API key is missing. Replace it in Providers settings.",
      );
    return { account, apiKey: new TextDecoder().decode(stored.value) };
  });

  const prepare = Effect.fn("ProviderApiKeyAccounts.prepare")(function* (
    settings: ServerSettings,
    action: ProviderApiKeyAccountAction | undefined,
  ) {
    if (!action) return { settings, commit: Effect.void, rollback: Effect.void };
    const { instanceId } = action;
    const driver = settings.providerInstances[instanceId]?.driver ?? instanceId;
    if (driver !== "deepcode")
      return yield* failure(instanceId, "Named API-key accounts are supported for Deep Code.");
    const current = settings.providerApiKeyAccounts?.[instanceId] ?? {
      accounts: [],
      activeAccountId: null,
    };
    const previous = current.accounts.find((item) => item.id === action.id);
    let accounts = [...current.accounts];
    let activeAccountId = current.activeAccountId;
    let commit = Effect.void;
    let rollback = Effect.void;
    if (action.action === "select") {
      if (action.id !== null && !previous)
        return yield* failure(instanceId, "That saved API-key account no longer exists.");
      activeAccountId = action.id;
    } else if (action.action === "remove") {
      accounts = accounts.filter((item) => item.id !== action.id);
      if (activeAccountId === action.id) activeAccountId = null;
      if (previous) commit = removeSecret(instanceId, previous.credentialId);
    } else {
      if (!previous && accounts.length >= 20)
        return yield* failure(instanceId, "You can save up to 20 API-key accounts per provider.");
      if (
        accounts.some(
          (item) => item.id !== action.id && item.name.toLowerCase() === action.name.toLowerCase(),
        )
      )
        return yield* failure(instanceId, "Choose a different name for this API-key account.");
      let baseUrl: string;
      try {
        const parsed = new URL(action.baseUrl);
        if (
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          (parsed.protocol !== "https:" &&
            !(
              parsed.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
            ))
        )
          throw new Error("Invalid endpoint");
        baseUrl = parsed.href.replace(/\/$/, "");
      } catch {
        return yield* failure(
          instanceId,
          "Use an HTTPS API endpoint without a password, query, or fragment.",
        );
      }
      if (!action.apiKey && !previous)
        return yield* failure(instanceId, "Enter an API key for the new account.");
      if (!action.apiKey && previous && previous.baseUrl !== baseUrl)
        return yield* failure(instanceId, "Supply a new API key when changing its endpoint.");
      const credentialId = action.apiKey
        ? yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(() => failure(instanceId, "Could not save the API key.")),
          )
        : previous!.credentialId;
      if (action.apiKey) {
        yield* secrets
          .set(secretName(instanceId, credentialId), new TextEncoder().encode(action.apiKey))
          .pipe(
            Effect.mapError(() => failure(instanceId, "The API key could not be stored securely.")),
          );
        rollback = removeSecret(instanceId, credentialId);
        if (previous) commit = removeSecret(instanceId, previous.credentialId);
      }
      const account: ProviderApiKeyAccount = {
        id: action.id,
        name: action.name,
        baseUrl,
        credentialId,
        keySuffix: action.apiKey
          ? action.apiKey.length > 8
            ? action.apiKey.slice(-4)
            : ""
          : previous!.keySuffix,
      };
      accounts = previous
        ? accounts.map((item) => (item.id === action.id ? account : item))
        : [...accounts, account];
      if (action.activate) activeAccountId = action.id;
      else if (activeAccountId === action.id) activeAccountId = null;
    }
    return {
      settings: {
        ...settings,
        providerApiKeyAccounts: {
          ...settings.providerApiKeyAccounts,
          [instanceId]: { accounts, activeAccountId },
        },
      },
      commit,
      rollback,
    };
  });
  return { resolve, prepare };
});
