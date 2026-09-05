# Claude connections

Each Claude chat uses a local proxy owned by that session. Starting or updating Solla Code from an
agent restores the configured API upstream before launching the backend or other providers. The
temporary proxy address is never reused as the next app's API upstream. This prevents connection
refusals after the original session exits.

Version 0.1.433 also repairs the untagged local proxy environment inherited from earlier releases on
startup. Provider-specific environment settings are applied after that repair, so an explicitly
configured `ANTHROPIC_BASE_URL` still takes precedence. Remote clients use their server's connection
settings; they do not need new pairing credentials for this repair.
