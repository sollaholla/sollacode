import type {
  DesktopPreviewBridge,
  EnvironmentId,
  PreviewCredentialSummary,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  HashIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { CredentialEditorDialog } from "../credentials/CredentialEditorDialog";
import {
  credentialErrorMessage,
  credentialKindOf,
  credentialSecretName,
  sortCredentials,
  upsertCredential,
  type CredentialEditorMode,
} from "@t3tools/client-runtime/preview/credential-form";
import { previewBridge } from "../preview/previewBridge";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { confirmInApp } from "../ui/appConfirm";
import { Button } from "../ui/button";
import { AccountsSections, type AccountsSource } from "./AccountsSections";
import { PasskeysSection, type PasskeysSource } from "./PasskeysSection";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** What the settings screen needs from wherever the passwords are kept. */
export type CredentialsVault = Pick<
  DesktopPreviewBridge["credentials"],
  "list" | "save" | "remove"
>;

/**
 * Settings → Accounts: the passwords, PINs, and codes agents can fill into
 * preview pages.
 *
 * They are kept by the desktop app on the environment's machine. That desktop
 * edits its vault directly; any other client, such as a phone or a browser on
 * the tailnet, asks this environment's server to relay the change to it.
 */
export function CredentialsSettingsPanel() {
  const desktopVault = previewBridge?.credentials;
  const desktopAccounts = previewBridge?.accounts;
  const desktopPasskeys = previewBridge?.passkeys;
  const environmentId = usePrimaryEnvironmentId();
  if (desktopVault && desktopAccounts && desktopPasskeys) {
    return (
      <CredentialsSettingsView
        bridge={desktopVault}
        before={
          <>
            <AccountsSections source={desktopAccounts} environmentId={environmentId} />
            <PasskeysSection source={desktopPasskeys} />
          </>
        }
      />
    );
  }
  if (environmentId === null) return <CredentialsSettingsView bridge={undefined} />;
  return <RelayedCredentialsSettings key={environmentId} environmentId={environmentId} />;
}

function RelayedCredentialsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const list = useAtomCommand(previewEnvironment.listCredentials, { reportFailure: false });
  const save = useAtomCommand(previewEnvironment.saveCredential, { reportFailure: false });
  const remove = useAtomCommand(previewEnvironment.removeCredential, { reportFailure: false });
  const accountsSnapshot = useAtomCommand(previewEnvironment.accountsSnapshot, {
    reportFailure: false,
  });
  const accountsSignOut = useAtomCommand(previewEnvironment.accountsSignOut, {
    reportFailure: false,
  });
  const accountsLink = useAtomCommand(previewEnvironment.accountsLink, { reportFailure: false });
  const passkeysSnapshot = useAtomCommand(previewEnvironment.passkeysSnapshot, {
    reportFailure: false,
  });
  const passkeysSetSite = useAtomCommand(previewEnvironment.passkeysSetSite, {
    reportFailure: false,
  });
  const passkeysRemove = useAtomCommand(previewEnvironment.passkeysRemove, {
    reportFailure: false,
  });
  const vault = useMemo<CredentialsVault>(
    () => ({
      list: async () => settled(await list({ environmentId, input: {} })),
      save: async (input) => settled(await save({ environmentId, input })),
      remove: async (id) => settled(await remove({ environmentId, input: { id } })),
    }),
    [environmentId, list, remove, save],
  );
  const accountsSource = useMemo<AccountsSource>(
    () => ({
      snapshot: async (input) =>
        settled(await accountsSnapshot({ environmentId, input: input ?? {} })),
      signOut: async (input) => settled(await accountsSignOut({ environmentId, input })),
      link: async (input) => settled(await accountsLink({ environmentId, input })),
    }),
    [accountsLink, accountsSignOut, accountsSnapshot, environmentId],
  );
  const passkeysSource = useMemo<PasskeysSource>(
    () => ({
      snapshot: async () => settled(await passkeysSnapshot({ environmentId, input: {} })),
      setSite: async (input) => settled(await passkeysSetSite({ environmentId, input })),
      remove: async (input) => settled(await passkeysRemove({ environmentId, input })),
    }),
    [environmentId, passkeysRemove, passkeysSetSite, passkeysSnapshot],
  );
  return (
    <CredentialsSettingsView
      bridge={vault}
      before={
        <>
          <AccountsSections source={accountsSource} environmentId={environmentId} />
          <PasskeysSection source={passkeysSource} />
        </>
      }
    />
  );
}

function settled<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function CredentialsSettingsView({
  bridge,
  before,
}: {
  bridge: CredentialsVault | undefined;
  before?: ReactNode;
}) {
  const [credentials, setCredentials] = useState<readonly PreviewCredentialSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<CredentialEditorMode | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    setLoadError(null);
    bridge.list().then(
      (saved) => {
        if (active) setCredentials(saved);
      },
      (cause: unknown) => {
        if (!active) return;
        setCredentials(null);
        setLoadError(credentialErrorMessage(cause, "Could not load saved credentials."));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, loadAttempt]);

  const remove = useCallback(
    async (credential: PreviewCredentialSummary) => {
      if (!bridge) return;
      const confirmed = await confirmInApp(
        `Delete the saved ${credentialSecretName(credentialKindOf(credential))} "${credential.label}" for ${credential.origin}? Agents will no longer be able to fill it.`,
        { confirmLabel: "Delete" },
      );
      if (!confirmed) return;
      setRemovingId(credential.id);
      setError(null);
      try {
        await bridge.remove(credential.id);
        setCredentials((current) => current?.filter((item) => item.id !== credential.id) ?? null);
      } catch (cause) {
        setError(credentialErrorMessage(cause, "Could not delete it."));
      } finally {
        setRemovingId(null);
      }
    },
    [bridge],
  );

  let content;
  if (bridge && loadError !== null) {
    // Not the empty state: nothing here says there is nothing saved,
    // only that they could not be reached, which is usually a desktop that is
    // closed or asleep.
    content = (
      <Alert variant="error">
        <LockKeyholeIcon />
        <AlertTitle>Couldn't load saved credentials</AlertTitle>
        <AlertDescription>
          <p>{loadError}</p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            <RefreshCwIcon />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (!bridge || credentials === null) {
    content = (
      <div className="py-10 text-center text-sm text-muted-foreground">
        Loading saved credentials…
      </div>
    );
  } else if (credentials.length === 0) {
    content = (
      <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center">
        <KeyRoundIcon className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">No saved logins</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Save a login or PIN here and agents can use it on that site in the browser panel without
          ever seeing it.
        </p>
        <Button className="mt-4" size="sm" onClick={() => setEditor({ kind: "add" })}>
          <PlusIcon />
          Add login
        </Button>
      </div>
    );
  } else {
    content = (
      <ul
        className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70 bg-card"
        aria-label="Saved credentials"
      >
        {sortCredentials(credentials).map((credential) => (
          <li key={credential.id} className="flex items-center gap-3 px-4 py-2.5">
            {credentialKindOf(credential) === "code" ? (
              <HashIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{credential.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {credentialKindOf(credential) === "code" ? "PIN or code · " : ""}
                {credential.username ? `${credential.username} · ` : ""}
                {credential.origin}
              </p>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${credential.label}`}
              onClick={() => setEditor({ kind: "edit", credential })}
            >
              <PencilIcon />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${credential.label}`}
              disabled={removingId === credential.id}
              onClick={() => void remove(credential)}
            >
              <Trash2Icon />
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SettingsPageContainer>
      {before}
      <SettingsSection
        id="setting-saved-passwords"
        title="Saved logins"
        icon={<KeyRoundIcon className="size-5" />}
        headerAction={
          bridge && credentials && credentials.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setEditor({ kind: "add" })}>
              <PlusIcon />
              Add login
            </Button>
          ) : null
        }
      >
        <p className="mb-3 max-w-2xl px-3 text-sm text-muted-foreground sm:px-4">
          Logins, PINs, and codes agents can use on the exact site they're saved for. Agents never
          see the secret, only the label and username. Saved Google passwords only you can fill.
        </p>
        {error ? (
          <Alert variant="error" className="mb-3">
            <LockKeyholeIcon />
            <AlertTitle>Saved credentials</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {content}
      </SettingsSection>
      {bridge ? (
        <CredentialEditorDialog
          open={editor !== null}
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          mode={editor ?? { kind: "add" }}
          save={bridge.save}
          onSaved={(saved) => setCredentials((current) => upsertCredential(current ?? [], saved))}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
