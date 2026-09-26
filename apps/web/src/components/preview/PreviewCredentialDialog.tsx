"use client";

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { CredentialEditorDialog } from "~/components/credentials/CredentialEditorDialog";
import { credentialOriginFromInput } from "@t3tools/client-runtime/preview/credential-form";
import { Button } from "~/components/ui/button";

import { previewBridge } from "./previewBridge";

/**
 * "Save password or PIN…" from the preview menu: the shared credential editor, with
 * the website prefilled from the tab. Listing, editing, and deleting live in
 * Settings → Credentials, linked from the footer.
 */
export function PreviewCredentialDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tabId: string | null;
}) {
  const { open, onOpenChange, tabId } = props;
  const navigate = useNavigate();
  // `undefined` while the tab's address is loading, so the form mounts once
  // with the site already filled in instead of reinitialising under the user.
  const [origin, setOrigin] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open || !previewBridge) return;
    let active = true;
    setOrigin(undefined);
    const status = tabId ? previewBridge.automation.status(tabId) : Promise.resolve(null);
    status.then(
      (tab) => {
        if (active) setOrigin((tab?.url && credentialOriginFromInput(tab.url)) || "");
      },
      () => {
        if (active) setOrigin("");
      },
    );
    return () => {
      active = false;
    };
  }, [open, tabId]);

  if (!previewBridge) return null;
  return (
    <CredentialEditorDialog
      open={open && origin !== undefined}
      onOpenChange={onOpenChange}
      mode={{ kind: "add", ...(origin ? { origin } : {}) }}
      save={previewBridge.credentials.save}
      footerStart={
        <Button
          type="button"
          variant="link"
          className="px-0"
          onClick={() => {
            onOpenChange(false);
            void navigate({ to: "/settings/credentials" });
          }}
        >
          All saved credentials
        </Button>
      }
    />
  );
}
