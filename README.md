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
