# Thread artifact architecture

Thread artifacts are environment-local, revisioned file bundles. Their schema and RPCs live in
`packages/contracts/src/artifacts.ts` and `packages/contracts/src/rpc.ts`; they are separate from
the declarative `VmAgentArtifact` workspace model.

## Read model and live updates

`threadArtifacts.subscribe` sends an initial whole-thread snapshot and a replacement snapshot after
publish, archive, or restore. Clients do not poll. List entries include the artifact identity, its
current revision metadata, and exact `entryResource` and `iconResource` descriptors. Detail adds
the bounded revision history.

The environment id is part of client selection and deep links, not the per-host RPC payload. The
selected connection supplies the authority boundary, and every payload still names the owning
thread and artifact.

## Assets and isolation

Clients pass the server-provided resource descriptor - including the artifact entry path - to the
existing `assets.createUrl` RPC. Returned host-relative signed URLs are short-lived conveniences and
are never persisted. Stable identity is the environment, thread, artifact id, revision, and entry
path.

Web renders web bundles in an opaque iframe sandbox with scripts as the only capability. Mobile
uses a WebView restricted to the signed entry subtree with multiple windows and external navigation
disabled. Server CSP is defense in depth. Icons are served through the same signed asset path and
rendered as images rather than injected SVG.

Archive and restore are reversible mutations. Publishing remains agent/MCP-owned; clients list,
open, deep-link, archive, and restore.
