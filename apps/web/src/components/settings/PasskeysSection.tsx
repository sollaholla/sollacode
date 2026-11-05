import {
  credentialErrorMessage,
  passkeyAccountName,
  passkeySiteRows,
} from "@t3tools/client-runtime/preview/credential-form";
import type { DesktopPreviewBridge, PreviewPasskeysSnapshot } from "@t3tools/contracts";
import { passkeySiteFromInput } from "@t3tools/shared/passkeySites";
import { FingerprintIcon, LockKeyholeIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { confirmInApp } from "../ui/appConfirm";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

/** What this section needs from wherever the passkeys are kept. */
export type PasskeysSource = DesktopPreviewBridge["passkeys"];

/**
 * Settings → Accounts: the sites where the browser may create and use passkeys
 * Solla holds, and the passkeys it holds for them. Their keys never reach a client.
 */
export function PasskeysSection({ source }: { readonly source: PasskeysSource }) {
  const [snapshot, setSnapshot] = useState<PreviewPasskeysSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const draftSite = passkeySiteFromInput(draft);

  const act = useCallback(async (action: () => Promise<PreviewPasskeysSnapshot>) => {
    setBusy(true);
    try {
      setSnapshot(await action());
      setError(null);
      return true;
    } catch (cause) {
      setError(credentialErrorMessage(cause, "Could not change passkeys."));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void act(() => source.snapshot());
  }, [act, source]);

  const rows = snapshot ? passkeySiteRows(snapshot) : [];

  return (
    <SettingsSection
      id="setting-passkeys"
      title="Passkeys"
      icon={<FingerprintIcon className="size-5" />}
    >
      <p className="mb-3 max-w-2xl px-3 text-sm text-muted-foreground sm:px-4">
        Turn this on for a site, then add a new passkey in that site's security settings. Solla
        keeps it encrypted here and uses it for you and your agents. Passkeys in iCloud Keychain or
        on your phone can't be reached, and Google can't use this.
      </p>
      {error ? (
        <Alert variant="error" className="mb-3">
          <LockKeyholeIcon />
          <AlertTitle>Passkeys</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {rows.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.site} className="rounded-xl border border-border/70 bg-card px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{row.site}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.enabled ? "On" : "Off"} ·{" "}
                    {row.passkeys.length === 1 ? "1 passkey" : `${row.passkeys.length} passkeys`}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() => source.setSite({ site: row.site, enabled: !row.enabled }))
                  }
                >
                  {row.enabled ? "Turn off" : "Turn on"}
                </Button>
              </div>
              {row.passkeys.length > 0 ? (
                <ul className="mt-2 space-y-1 border-t border-border/50 pt-2">
                  {row.passkeys.map((passkey) => (
                    <li key={passkey.id} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {passkeyAccountName(passkey)}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          void confirmInApp(
                            `Remove the passkey for ${passkeyAccountName(passkey)} on ${row.site}? It can't be recovered, so make sure you have another way to sign in to the site.`,
                            { confirmLabel: "Remove" },
                          ).then((confirmed) => {
                            if (confirmed) void act(() => source.remove({ id: passkey.id }));
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex max-w-md items-center gap-2 px-3 sm:px-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draftSite) return;
          void act(() => source.setSite({ site: draftSite, enabled: true })).then((done) => {
            if (done) setDraft("");
          });
        }}
      >
        <Input
          aria-label="Site to use passkeys on"
          placeholder="example.com"
          autoCapitalize="none"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={busy || draftSite === null}>
          Turn on
        </Button>
      </form>
    </SettingsSection>
  );
}
