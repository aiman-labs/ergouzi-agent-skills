# AGENTS.md

## Repository Role

This is the public source of truth for Ergouzi community Agent Skills and
Claude Code / Codex plugins. It is independently authored and must never be
generated from, or depend on, private Ergouzi or personal repositories.

## Language

- English is normative for repository policy and technical documentation.
- Keep `README.zh-CN.md` and `CONTRIBUTING.zh-CN.md` aligned with their English
  counterparts when user-facing behavior changes.
- Code, scripts, configuration, and comments use English.

## Artifact Boundaries

- `skills/<name>/` contains portable Agent Skills. The directory name must
  exactly match the standard kebab-case `name` in `SKILL.md`.
- `plugins/<name>/` contains self-contained plugins. Manifest presence declares
  support: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, or both.
- `templates/` contains scaffold inputs only. Template manifests use `.tmpl`
  suffixes and must never be published or cataloged.
- `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` are
  generated catalogs. Do not edit their plugin arrays by hand.
- Do not add placeholder, demo, or private-only artifacts to `skills/` or
  `plugins/` merely to exercise the framework.

## Skill Rules

- Follow the Agent Skills specification.
- Keep `SKILL.md` concise and use progressive disclosure through `scripts/`,
  `references/`, and `assets/` only when those resources are needed.
- Link supporting resources directly from `SKILL.md`; avoid deep reference
  chains and orphan files.
- Public Skills require `license: MIT`, `metadata.author`, and a strict SemVer
  `metadata.version` in addition to standard `name` and `description`.
- Do not use colon-prefixed names such as `ergouzi:example`; they are not valid
  standard Skill names.

## Plugin Rules

- Every plugin is an isolated distribution unit and must work after being
  copied into a platform cache.
- Do not reference files outside a plugin with `../`, absolute local paths, or
  repository-only symlinks.
- Cross-platform plugins share common resources within one plugin directory but
  keep platform manifests and platform-only components explicit.
- Keep versions aligned across the Claude Code and Codex manifests of a
  cross-platform plugin.

## Public Safety

- Never commit credentials, tokens, webhooks, private endpoints, production
  account data, internal server paths, or private repository content.
- Declare network, authentication, executable, destructive, and external-side-
  effect requirements in the artifact documentation and contribution record.
- Minimize tool scope, validate untrusted input, avoid shell interpolation, and
  require explicit user confirmation before destructive or external actions.
- Record third-party source and license provenance before redistribution.

## Workflow

- Scaffold with `npm run create:skill -- ...` or
  `npm run create:plugin -- ...`; do not copy an unrelated artifact as a base.
- Develop executable behavior test-first.
- Regenerate catalogs with `npm run catalog` after plugin changes.
- Run `npm run check` before requesting review.
- Add or update evaluation cases for real Skills and Plugins; do not treat
  structural validation as behavioral proof.
- Do not create branches, commit, push, publish, or change GitHub settings
  unless the user explicitly authorizes that external action.

## Review

- Treat executable scripts, hooks, MCP servers, apps, and authentication flows
  as high-risk review surfaces.
- Reject contributions that hide private dependencies, over-broaden tool access,
  bypass user confirmation, or cannot be tested reproducibly.
- A maintainer review and passing required checks are necessary before merge.

## Pull Request Template

- Every PR creation or body edit must use the target repository's applicable PR template
  and contribution requirements. Read the template and fill it directly; do not substitute
  a workspace template or a custom outline.
- Preserve every template heading, field and checklist item. Do not delete, rename, merge
  or simplify them. Fill each item with actual results; use N/A with a reason when inapplicable.
- Check items only when supported by evidence. Never check human confirmation, human
  authorship or maintainer approval on the user's behalf.
- If no applicable template is available, report and resolve the template gap before
  creating the PR; do not bypass it with a free-form body. Choose the matching template
  when multiple templates exist.
- After creation or editing, read back the remote PR body and compare its structure,
  checklist and factual status with the template. A local draft or successful command is insufficient.
