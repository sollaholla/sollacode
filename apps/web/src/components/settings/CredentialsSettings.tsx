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
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** What the settings screen needs from wherever the passwords are kept. */
export type CredentialsVault = Pick<
  DesktopPreviewBridge["credentials"],
  "list" | "save" | "remove"
>;

/**
 * Settings → Credentials: the passwords, PINs, and codes agents can fill into
 * preview pages.
 *
 * They are kept by the desktop app on the environment's machine. That desktop
 * edits its vault directly; any other client, such as a phone or a browser on
 * the tailnet, asks this environment's server to relay the change to it.
 */
export function CredentialsSettingsPanel() {
  const desktopVault = previewBridge?.credentials;
  const environmentId = usePrimaryEnvironmentId();
  if (desktopVault) return <CredentialsSettingsView bridge={desktopVault} />;
  if (environmentId === null) return <CredentialsSettingsView bridge={undefined} />;
  return <RelayedCredentialsSettings key={environmentId} environmentId={environmentId} />;
}

function RelayedCredentialsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const list = useAtomCommand(previewEnvironment.listCredentials, { reportFailure: false });
  const save = useAtomCommand(previewEnvironment.saveCredential, { reportFailure: false });
  const remove = useAtomCommand(previewEnvironment.removeCredential, { reportFailure: false });
  const vault = useMemo<CredentialsVault>(
    () => ({
      list: async () => settled(await list({ environmentId, input: {} })),
      save: async (input) => settled(await save({ environmentId, input })),
      remove: async (id) => settled(await remove({ environmentId, input: { id } })),
    }),
    [environmentId, list, remove, save],
  );
  return <CredentialsSettingsView bridge={vault} />;
}

function settled<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function CredentialsSettingsView({ bridge }: { bridge: CredentialsVault | undefined }) {
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
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
        <KeyRoundIcon className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">No saved credentials</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Save a login or PIN here and agents can use it on that site in the browser panel without
          ever seeing it.
        </p>
        <Button className="mt-4" size="sm" onClick={() => setEditor({ kind: "add" })}>
          <PlusIcon />
          Add credential
        </Button>
      </div>
    );
  } else {
    content = (
      <ul className="space-y-2" aria-label="Saved credentials">
        {sortCredentials(credentials).map((credential) => (
          <li
            key={credential.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
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
      <SettingsSection
        id="setting-saved-passwords"
        title="Credentials"
        icon={<KeyRoundIcon className="size-5" />}
        headerAction={
          bridge && credentials && credentials.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setEditor({ kind: "add" })}>
              <PlusIcon />
              Add credential
            </Button>
          ) : null
        }
      >
        <p className="mb-4 max-w-2xl px-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Logins, PINs, and codes agents can use on sites in the browser panel. Agents see each
          entry's label, type, username, and site. Solla Code types the secret into the page itself,
          only on the exact site it was saved for, so it never reaches an agent, a chat, or a log. A
          password fills only password boxes; a PIN or code also fills the plain text and number
          boxes many sites use for one.
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
