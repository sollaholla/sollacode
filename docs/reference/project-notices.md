# Solla Code project notices

Solla Code is an independently maintained fork of [T3 Code](https://github.com/pingdotgg/t3code). Upstream T3 Tools services, privacy contacts, and policies do not represent the operator of this fork.

## License

The source is distributed under the repository's [MIT License](../../LICENSE), including its copyright and warranty notices. Original upstream attribution remains in the license and history.

## Data and connected services

The environment host stores conversations, settings, attachments, and provider state. Clients connect to that environment; prompts and other task inputs may be sent to the providers and tools you configure. Those services and any operator hosting an environment have their own data practices. See [storage](../user/storage.md) and [remote access](../user/remote-access.md).

This notice describes the open-source project, not a particular hosted deployment. The marketing website serves its fonts locally and retrieves release information from GitHub. Mobile opens these repository notices by default; builds can set `EXPO_PUBLIC_MARKETING_SITE_URL` to their operator's own website.

## Security

Provider and tool permissions govern access to the host and workspace. Pair only with intended environments. See [runtime modes](../architecture/runtime-modes.md) and [remote access](../user/remote-access.md) for the implementation boundaries.

Check the [fork's security page](https://github.com/sollaholla/sollacode/security) for reporting options. Do not post credentials or private conversation data in public issues. This notice does not promise a bounty, response deadline, or operations for upstream infrastructure.
