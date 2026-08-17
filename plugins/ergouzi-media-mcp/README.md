# Ergouzi Media MCP

[简体中文](README.zh-CN.md)

This Codex plugin exposes the Ergouzi asynchronous image and video API as
local MCP tools. Codex chooses the model and constructs the model-specific
`input`; the MCP server owns credentials, HTTP requests, task polling,
cancellation, local media conversion, and result downloads.

## Requirements

- Codex with local plugin/MCP support.
- Node.js 22 or newer.
- A media API key that is authorized for the target Ergouzi image/video
  models. This is separate from the GPT/text-model key used by Codex.

The server reads credentials from the same ignored user config as the media
Skills:

- macOS/Linux: `~/.config/ergouzi/credentials.json`
- Windows: `%APPDATA%\\ergouzi\\credentials.json`

```json
{
  "api_key": "YOUR_MEDIA_API_KEY",
  "base_url": "https://ergouzi.life"
}
```

The following environment variables override the file:

- `ERGOUZI_MEDIA_API_KEY`
- `ERGOUZI_MEDIA_BASE_URL`
- `ERGOUZI_CONFIG_FILE`

Never put a key in MCP tool arguments, prompts, source files, or logs.

## MCP tools

| Tool                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `check_configuration` | Verify local credentials, permissions, and API access.           |
| `list_models`         | List models visible to the configured media key.                 |
| `get_model_schema`    | Read a model's current input and output schema.                  |
| `create_prediction`   | Create one asynchronous image/video task and return its task ID. |
| `get_prediction`      | Read a task, with an optional bounded wait.                      |
| `cancel_prediction`   | Cancel a task after explicit user confirmation.                  |
| `download_prediction` | Download successful outputs and write a local receipt.           |

`create_prediction` accepts model-specific fields in `input`. Local media is
explicit and limited to documented fields:

```json
{
  "prompt": "A rainy Shanghai street at night",
  "images": [{ "$local_file": "/absolute/path/reference.png" }]
}
```

Use HTTPS media URLs when an inline data URI would exceed the request limit.
The server reuses one idempotency key for a bounded transport retry so a
transient failure does not intentionally create a second billable task.
Ask for explicit user confirmation before creating a billable task or
cancelling an existing task.
It returns structured MCP content as well as readable JSON text, so task IDs,
statuses, saved paths, and receipt paths remain directly usable by Codex.

Each local file is limited to 3 MiB, and the complete JSON `input` is limited
to 4 MiB after local files are expanded as base64 data URIs. One downloaded
output file is limited to 2 GiB. For `ergouzi/e-video`, local `image`,
`last_frame_image`, and `audio` inputs are supported.

## First run

Start a new Codex task after the plugin is installed, then ask:

```text
Call ergouzi-media-mcp check_configuration and show the configuration result without exposing my API key.
```

Then inspect the exact input schema for the selected model:

```text
Call get_model_schema for ergouzi/e-image and use its current input schema.
```

After the check succeeds, use an explicit output directory:

```text
Use ergouzi/e-image to create a rainy Shanghai street at night, then download the completed result to /path/to/outputs.
```

For local image, video, or audio input, provide an absolute path or a
`~/...` home-relative path in the
request to Codex. It passes the path only through the documented
`$local_file` media fields, rather than treating arbitrary JSON fields as files.

## Installation and startup

The plugin manifest and `.mcp.json` start the isolated server with:

```bash
node scripts/server.mjs
```

The server uses the official Model Context Protocol SDK. Its runtime and
licenses are bundled into `server.mjs`, so plugin users do not run `npm install`.

Add the marketplace and install the plugin:

```bash
codex plugin marketplace add aiman-labs/ergouzi-agent-skills
codex plugin add ergouzi-media-mcp@ergouzi-agent-skills
```

After installation, start a new Codex task so the MCP tool list is refreshed.

By default, `download_prediction` writes to
`outputs/ergouzi-media-mcp` under the MCP process working directory. Pass an
explicit `output_dir` when a different local directory is required. Existing
files are never overwritten; each download is written through a temporary
file and then atomically renamed.

## Security boundary

- The server uses `stdio`; it does not expose a public HTTP listener.
- Authorization is sent only to the configured Ergouzi API origin, never to
  external output URLs or cross-origin redirects.
- Output URLs must use HTTPS. Loopback HTTP is accepted only when the API base
  URL itself is a loopback test endpoint.
- Every output hostname is resolved before download and after each redirect;
  private, local, reserved, and mixed public/private DNS answers are rejected.
- The 120-second download timeout remains active while response bytes are
  streamed to disk, and partial files are removed on failure.
- Local media paths, including `~/...` home-relative paths, must resolve to regular files and are signature-checked
  before conversion to a data URI.
- Upstream provider tokens, including `hf_api_token`, are rejected before the
  request is submitted.
- A `$local_file` placeholder is accepted only as the sole value of a documented
  media field; every other occurrence is rejected before the request is sent.
- API validation details and `Retry-After` guidance are returned with failed
  requests after secret redaction.
- The remote Ergouzi task is canonical; the plugin does not create a local
  billing queue or duplicate task database.

The existing `ergouzi-image-gen` and `ergouzi-video-gen` Skills remain usable
without this optional plugin. When this MCP is installed, those Skills can
prefer the MCP tools and retain their Python runners as a fallback.
