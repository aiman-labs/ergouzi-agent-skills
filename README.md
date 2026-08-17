# Ergouzi Agent Skills

[English](README.md) | [简体中文](README.zh-CN.md)

Public, community-maintained Agent Skills and Claude Code / Codex plugins for
New API and other reusable workflows.

This repository is the direct public source of truth. It does not mirror or
publish private Ergouzi operations Skills.

## What Lives Here

| Path                               | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `skills/`                          | Portable Agent Skills following the Agent Skills specification |
| `plugins/`                         | Self-contained cross-platform or platform-specific plugins     |
| `templates/`                       | Inputs used by the repository scaffold commands                |
| `docs/`                            | Authoring, governance, security, and design documentation      |
| `.claude-plugin/marketplace.json`  | Claude Code marketplace catalog                                |
| `.agents/plugins/marketplace.json` | Codex marketplace catalog                                      |

Available portable Skills:

- `ergouzi-image-gen` submits and manages Ergouzi image generation, editing,
  virtual try-on, and upscaling tasks.
- `ergouzi-video-gen` submits and manages Ergouzi video generation, animation,
  avatar, and person-replacement tasks.

Both Skills require Python 3.10+, network access to `https://ergouzi.life`, and
an Ergouzi API key configured locally.

## Installation

The remote commands below become usable after the repository is published.

### Portable Skills

```bash
npx skills add aiman-labs/ergouzi-agent-skills --list
npx skills add aiman-labs/ergouzi-agent-skills --skill <skill-name>
```

### Claude Code Plugins

```text
/plugin marketplace add aiman-labs/ergouzi-agent-skills
/plugin install <plugin-name>@ergouzi-agent-skills
```

### Codex Plugins

```bash
codex plugin marketplace add aiman-labs/ergouzi-agent-skills
codex plugin add <plugin-name>@ergouzi-agent-skills
```

Only install Skills and Plugins you trust. Artifacts may contain executable
scripts or tool integrations; inspect their manifests, instructions, and source
before enabling them.

## Ergouzi Media MCP Quick Start

`ergouzi-media-mcp` is a local Codex plugin that exposes the Ergouzi
asynchronous image and video API as tools for configuration diagnostics, model
listing and schema discovery, task creation, task status, cancellation, and
result download.

1. Install it through the Codex marketplace commands above:

   ```bash
   codex plugin add ergouzi-media-mcp@ergouzi-agent-skills
   ```

2. Install Node.js 22 or newer and configure a separate media API key. This
   key must be authorized for the intended image/video models; it is not the
   GPT/text-model key used by Codex. Save it locally at
   `~/.config/ergouzi/credentials.json` on macOS/Linux or
   `%APPDATA%\\ergouzi\\credentials.json` on Windows:

   ```json
   {
     "api_key": "YOUR_MEDIA_API_KEY",
     "base_url": "https://ergouzi.life"
   }
   ```

3. Start a new Codex task and verify the connection:

   ```text
   Call ergouzi-media-mcp check_configuration and show the configuration result without exposing my media API key.
   ```

4. Ask Codex to create and download media with an explicit destination:

   ```text
   Use ergouzi/e-image to create a rainy Shanghai street at night, then download the completed result to ~/outputs.
   ```

The MCP handles task submission, polling, and download. Codex chooses the
model and model input. Read the [full plugin guide](plugins/ergouzi-media-mcp/README.md)
for local file inputs, tool details, output behavior, and troubleshooting.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing an artifact. New Skills
and Plugins require a clear user problem, trigger examples, security and
dependency disclosure, provenance, and reproducible validation.

Useful commands:

```bash
npm install
npm run create:skill -- <name> --description "..."
npm run create:plugin -- <name> --target cross-platform --description "..."
npm run catalog
npm run check
```

## Standards

- [Skill authoring standard](docs/authoring/skill-standard.md)
- [Plugin authoring standard](docs/authoring/plugin-standard.md)
- [Versioning policy](docs/governance/versioning.md)
- [Security review checklist](docs/security/review-checklist.md)

## License

MIT. Third-party material remains subject to its original license and must be
documented before redistribution.
