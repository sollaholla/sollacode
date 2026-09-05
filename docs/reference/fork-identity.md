# Fork identity and compatibility

Solla Code is maintained in [sollaholla/sollacode](https://github.com/sollaholla/sollacode), independently of upstream [T3 Code](https://github.com/pingdotgg/t3code). Upstream authorship and the MIT copyright notice remain in [LICENSE](../../LICENSE) and Git history.

## Distribution

- Solla installers come from this fork's GitHub releases, or from a local build of this repository.
- `npx t3`, upstream package-manager installers, `t3.codes`, and `app.t3.codes` refer to upstream distributions and infrastructure. They are not Solla installation instructions or Solla-operated services.
- The workspace still calls its server package and executable `t3`, and uses `@t3tools/*` package names, `T3CODE_*` environment variables, the `t3code://` desktop protocol, and `t3.json` project files. Renaming these requires a compatibility migration, not a prose replacement.
- The inherited pinned-runtime installer targets npm package `t3`. Background-service installation and npm self-updates are not a Solla distribution path until an owned package and the associated installer configuration are established. See [Server updates](../user/server-updates.md).
- The release workflow can publish desktop artifacts independently of npm publishing. Hosted web deployment is optional; its upstream domain defaults must be replaced with domains owned by the fork before enabling it. T3 Connect infrastructure is absent from this fork.

## State directories

| Launch path                                            | Default runtime state     |
| ------------------------------------------------------ | ------------------------- |
| Packaged Solla desktop                                 | `~/.solla-code/userdata`  |
| Standalone CLI from this source tree                   | `~/.t3/userdata`          |
| Development from the main checkout                     | `~/.t3/dev`               |
| Development from a linked Git worktree                 | `<worktree>/.t3/userdata` |
| Explicit `--home-dir <base>` or selected `T3CODE_HOME` | `<base>/userdata`         |

An explicit `--home-dir` takes priority. In a linked worktree, the worktree-local home takes priority over an ambient `T3CODE_HOME`. Read the runner's output when diagnosing a launch. Keybindings, settings, logs, and the SQLite database live under the selected runtime state directory.

Source: [desktop environment](../../apps/desktop/src/app/DesktopEnvironment.ts), [development runner](../../scripts/dev-runner.ts), [server paths](../../apps/server/src/config.ts).

## Documentation and attribution

Describe this product as Solla Code. Preserve upstream attribution, dependency names, wire identifiers, migration keys, and historical issue links. Do not reuse upstream adoption metrics, testimonials, hosted-service promises, legal contacts, or release numbers as claims about this fork. Documentation mockups must be labeled as illustrations rather than runtime verification.
