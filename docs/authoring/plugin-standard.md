# Plugin Authoring Standard

## Target Classes

| Target           | Required manifest                                            |
| ---------------- | ------------------------------------------------------------ |
| `cross-platform` | `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` |
| `claude-code`    | `.claude-plugin/plugin.json` only                            |
| `codex`          | `.codex-plugin/plugin.json` only                             |

Manifest presence is the source of truth. Do not add a parallel target field
that can drift from the actual package.

## Isolation

An installed marketplace plugin is copied into a platform cache. Everything
needed at runtime must live under `plugins/<name>/`.

Forbidden dependencies include:

- `../` paths leaving the plugin;
- absolute paths from a contributor machine;
- symlinks, which make public review and packaged contents ambiguous;
- imports from root `scripts/`, `skills/`, or another plugin;
- private services or credentials not declared to the user.

Cross-platform plugins share common content inside one plugin directory. Put
platform-only components in explicit platform directories or manifests, and
test both ingestion paths.

## Components

Use the platform defaults where possible:

```text
plugins/example-plugin/
├── .claude-plugin/plugin.json      # When Claude Code is supported
├── .codex-plugin/plugin.json       # When Codex is supported
├── skills/                         # Standard Skill directories
├── agents/                         # Platform agent definitions when supported
├── hooks/                          # Platform hooks when supported
├── scripts/                        # Runtime helpers
├── assets/                         # Icons and output resources
├── .mcp.json                       # Claude Code MCP servers when required
├── .codex.mcp.json                 # Codex MCP servers when host semantics differ
└── .app.json                       # Codex app metadata when required
```

Only declare a component in a manifest when its file or directory exists.
Unknown or ignored fields are errors in repository review even if one client
tolerates them.

## Metadata And Versions

Plugin folder names and manifest names use the same kebab-case value. Versions
use strict SemVer. A cross-platform plugin has the same version in both
manifests.

Descriptions explain user value, not implementation history. Declare developer,
license, repository, category, and user-facing interface metadata. Icon and
screenshot paths must resolve inside the plugin.

## Catalogs

Do not edit marketplace plugin arrays by hand. Run:

```bash
npm run catalog
npm run catalog:check
```

The generator includes a plugin only in marketplaces whose platform manifest
exists. Catalog order is deterministic by plugin name.

## Verification

```bash
npm run check
claude plugin validate --strict .
```

For Codex, run repository schema validation and perform a local marketplace
install in a disposable environment before release. For cross-platform MCPs,
execute each host's declared command from a copied plugin and complete an MCP
`initialize`/`tools/list` handshake; do not assume one host's variable
expansion works on the other. Start a new agent session after reinstall so
updated plugin components are loaded.
