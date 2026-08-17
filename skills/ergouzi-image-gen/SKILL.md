---
name: ergouzi-image-gen
description: 'Submit and complete Ergouzi image generation, editing, virtual try-on, and upscaling tasks through ergouzi.life, including tasks that use local image files or HTTPS URLs. Use when Codex must call an ergouzi/e-image* model, poll the asynchronous task, download its outputs, resume a task ID, or cancel an image task.'
license: MIT
compatibility: 'Requires Python 3.10+ and network access to https://ergouzi.life.'
metadata:
  version: '0.3.1'
  author: aiman-labs
---

# Ergouzi Image Gen

Use this Skill as a thin adapter between Codex and the existing Ergouzi image
API. Codex prepares the model input; the scripts only handle credentials, local
file conversion, request submission, task polling, and result download.

## Prerequisites

- Require Python 3.10 or newer and network access to `https://ergouzi.life`.
- Use the initialized user config by default. `ERGOUZI_MEDIA_API_KEY` and
  `ERGOUZI_MEDIA_BASE_URL` are explicit runtime overrides; generic
  `ERGOUZI_API_KEY` and `ERGOUZI_BASE_URL` are accepted when no config exists.
- If credentials are missing, ask the user to initialize them locally with
  `python scripts/configure.py`. Never ask the user to paste a key into chat.
- If the optional `ergouzi-media-mcp` Codex plugin is installed, prefer its
  `check_configuration`, `list_models`, `get_model_schema`,
  `create_prediction`, `get_prediction`, `cancel_prediction`, and
  `download_prediction` tools for the API lifecycle. Keep the Python runner
  as the fallback when the MCP tools are unavailable.
- Accept JPEG, PNG, and WebP inputs as directly downloadable HTTPS URLs, data
  URIs, or local files that fit the existing 4 MiB JSON request limit. Use `--image`, `--person-image`,
  `--garment-image`, or `--reference-pose` for common local-file workflows.
  In input JSON, put `{ "$local_file": "C:/path/image.png" }` in place of a
  media URL. The runner converts local files to data URIs; use an HTTPS URL
  when the expanded request would exceed the API limit.

## Workflow

1. Submit a paid prediction only when the user explicitly asks to generate,
   edit, try on, or upscale an image.
2. Honor an explicit model choice. Otherwise let Codex select one of the five
   models from the task's required input/output capability; do not hide models
   or apply server-routing policy.
3. Read `references/model-reference.md` for the selected model's objective API
   contract. Use `--prompt` only when that model exposes a `prompt` field. Use
   `--input-file`, `--input-json`, or stdin for the complete model `input`
   object, without the outer `{ "input": ... }` envelope. Convenience arguments
   override the corresponding JSON fields. The runner resolves `$local_file`
   objects before submission and otherwise leaves input values unchanged. Prefer
   a UTF-8 JSON file for structured input across operating systems; files and
   stdin may include a UTF-8 BOM.
4. Prefer the MCP tools when available. Otherwise run `scripts/run.py predict`.
   Both paths create one logical task, reuse the same idempotency key for
   bounded transport retries, record the `task_*` ID, poll to a terminal state,
   and download successful outputs.
5. Report the model, task ID, terminal status, and absolute saved paths.
6. If execution was interrupted or timed out, resume with
   `status --wait --download`. Do not create a replacement task unless the user
   explicitly asks.

## Commands

```bash
python scripts/configure.py
python scripts/configure.py --check
python scripts/run.py predict --model ergouzi/e-image --prompt "<prompt>"
python scripts/run.py predict --model ergouzi/e-image-edit --prompt "<prompt>" --image <path-or-url>
python scripts/run.py predict --model ergouzi/e-image-try-on --person-image <path-or-url> --garment-image <path-or-url>
python scripts/run.py predict --model ergouzi/e-image-edit --input-file <input.json> --output <result.png>
python scripts/run.py status --task-id <task_id> --wait --download --output <result.png>
python scripts/run.py cancel --task-id <task_id>
```

For structured stdin, detect the active shell and use its native JSON command.
On Windows PowerShell, set the native pipe encoding first so non-ASCII prompts
survive Windows PowerShell 5.1 as well as PowerShell 7:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@{ prompt = '生成一张图片'; aspect_ratio = '9:16' } | ConvertTo-Json -Compress |
  python scripts/run.py predict --model ergouzi/e-image --input-file -
```

On macOS/Linux with zsh, bash, or sh:

```bash
printf '%s' '{"prompt":"Create an image","aspect_ratio":"9:16"}' |
  python3 scripts/run.py predict --model ergouzi/e-image --input-file -
```

Use `python3` on macOS/Linux and `python` on Windows unless the environment
exposes Python 3.10+ under a different command. Keep `--input-json` for direct
argv callers; avoid nested shell quoting when `--input-file` or stdin is available.

Use `--output` for an exact `.jpg`, `.jpeg`, `.png`, or `.webp` path, or
`--output-dir` for automatic result naming. Otherwise keep outputs under
`output/ergouzi-image-gen/` in the current working directory.

## Adapter Boundary

- Keep the scripts transport-only. Do not add prompt rewriting, model ranking,
  aesthetic defaults, pricing, scheduling, billing, channel selection, or
  service-side behavior.
- Support local files by inlining data URIs only. Do not add upload, hosting,
  proxy-storage, or persistent media-management capabilities.
- Let Codex decide the model and construct the request from user intent. The API
  remains responsible for model validation and generation.
- Do not pass upstream provider tokens such as `hf_api_token`.
- Do not send the Ergouzi Authorization header to external output URLs.
- Treat `references/ai-guide.md` as optional advice. Read it only when the user
  asks for model-selection or prompting advice; it never overrides user input.
