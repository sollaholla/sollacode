# Workspace layout

Solla Code retains upstream package names for import and build compatibility. See [Fork identity](./fork-identity.md).

| Directory                            | Responsibility                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                        | Node.js server, HTTP/WebSocket transport, provider adapters, orchestration, persistence, terminals, agents, and MCP tools |
| `apps/web`                           | React/Vite client used by browsers and the desktop shell                                                                  |
| `apps/desktop`                       | Electron lifecycle, native integrations, browser surfaces, and bundled backend                                            |
| `apps/mobile`                        | React Native iOS/Android clients and native modules                                                                       |
| `apps/marketing`                     | Astro marketing site and release download pages                                                                           |
| `packages/contracts`                 | Shared Effect schemas and wire contracts                                                                                  |
| `packages/client-runtime`            | Connection, state, and query logic shared by web and mobile                                                               |
| `packages/shared`                    | Runtime utilities with explicit subpath exports                                                                           |
| `packages/effect-acp`                | Agent Client Protocol runtime                                                                                             |
| `packages/effect-codex-app-server`   | Codex app-server protocol/runtime                                                                                         |
| `packages/ssh`, `packages/tailscale` | Remote transport and host integration                                                                                     |
| `native/resource-monitor`            | Rust resource-monitor process                                                                                             |
| `oxlint-plugin-t3code`               | Repository-specific lint rules                                                                                            |
| `scripts`                            | Development, packaging, release, and verification tooling                                                                 |
| `tools/motion`                       | Production-client media captures and original film renderer                                                               |
| `docs`                               | User, provider, architecture, operations, and reference guides                                                            |
| `.repos`                             | Vendored read-only reference repositories; not application source                                                         |
| `.plans`, `docs/project`             | Historical plans and design notes; not guarantees of shipped behavior                                                     |
