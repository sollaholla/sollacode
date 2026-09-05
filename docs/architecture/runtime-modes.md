# Runtime and interaction modes

Runtime mode is stored per thread and passed to the selected provider when its session starts or resumes. It is separate from interaction mode. The defaults and wire values live in [the orchestration contracts](../../packages/contracts/src/orchestration.ts).

| Runtime value       | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `approval-required` | Require provider approvals for privileged work.                |
| `auto-accept-edits` | Permit workspace edits while retaining command approval rules. |
| `auto`              | Use provider-supported automatic approval review.              |
| `full-access`       | Run with the provider's broadest access; the default.          |

These are adapter inputs, not identical security boundaries across providers. The selected CLI implements the actual sandbox and approval behavior.

For Codex, [CodexSessionRuntime](../../apps/server/src/provider/Layers/CodexSessionRuntime.ts) maps the modes as follows:

| Mode                | Approval policy | Sandbox              | Reviewer         |
| ------------------- | --------------- | -------------------- | ---------------- |
| `approval-required` | `untrusted`     | `read-only`          | user             |
| `auto-accept-edits` | `on-request`    | `workspace-write`    | user             |
| `auto`              | `on-request`    | `workspace-write`    | automatic review |
| `full-access`       | `never`         | `danger-full-access` | user             |

Claude maps the modes to its default, `acceptEdits`, `auto`, and `bypassPermissions` settings respectively. OpenCode currently allows all permissions in full access and requests approval in the other modes. Consult the [provider overview](../providers/README.md) and adapter source before assuming a mode has the same behavior in another provider.

Interaction mode uses `default`, `plan`, or `agent`. Default is ordinary conversation; plan requests planning behavior; agent enables autonomous continuation according to the thread and scheduler rules. It does not grant extra filesystem permissions. Explicit Stop cancels current and already queued work; a fresh user action can start work again. See the [composer guide](../user/composer.md).
