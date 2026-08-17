# Ergouzi Media MCP Design

Status: Implemented; production-hardening in progress

## Decision

Run the MCP server locally as a child process of Codex or Claude Code, using
MCP over stdio. The local MCP calls the remote New API at `ergouzi.life`.

Do not deploy the MCP server to the Ergouzi application server for the initial
version. A remote MCP cannot directly read user-selected local media or save
generated files to the user's requested local directory. Solving that would
add upload storage, per-user authentication, tenancy, cleanup, and download
delivery concerns that do not belong in this thin adapter.

## Boundary

```text
Codex or Claude Code
  -> Skill: understand intent, choose a model, construct input, confirm paid work
    -> Local MCP: credentials, local files, HTTP transport, task control, downloads
      -> Remote New API: validation, authorization, billing, task state, generation
```

The Skill remains responsible for reasoning and user interaction. The MCP does
not rewrite prompts, rank models, set aesthetic defaults, calculate prices, or
implement provider routing. New API remains the canonical owner of model input
validation, billing, and task state.

## Minimal Tool Surface

Use generic tools rather than one tool per model:

1. `check_configuration()` verifies local credentials, file permissions, and
   API access without returning the API key.
2. `list_models()` returns the media models visible to the current API key.
3. `get_model_schema(model)` returns the current input and output schema with a
   short local cache.
4. `create_prediction(model, input)` resolves explicit `$local_file` values,
   performs one logical idempotent submission, and returns the local `task_*`
   ID without waiting indefinitely.
5. `get_prediction(task_id, wait_seconds?)` returns canonical task state. A
   bounded wait may poll for at most the configured tool-call budget.
6. `cancel_prediction(task_id)` requests cancellation for an existing task.
7. `download_prediction(task_id, output_dir?)` downloads only outputs associated
   with that task and returns absolute local paths.

The ten models share these tools. Model-specific fields stay in the generic
`input` object and are validated by New API.

## Required Safeguards

- Read credentials only from the existing local ignored config or environment;
  never accept or return an API key in MCP tool arguments.
- Send the Authorization header only to the configured Ergouzi API origin.
  Never forward it to external output URLs or redirects.
- Accept local files only through an explicit `$local_file` object, enforce the
  current media and request-size limits, and reject directories.
- Reuse one idempotency key across bounded retries for a logical submission.
- Treat the remote `task_*` record as canonical. Do not add a local database,
  queue, scheduler, webhook service, or duplicate billing state.
- Use unique output names by default and never overwrite an existing local file
  unless a future explicit option authorizes it.

## Packaging

Keep the current portable Skills usable on their own. Add the MCP later as a
self-contained optional plugin in this repository. When the MCP tools are
available, the Skills should prefer them; otherwise their existing Python
scripts remain the fallback. This avoids making portable Skill installation
depend on a separately hosted service.

## Deferred Remote Mode

A server-hosted MCP is justified only if there is a concrete multi-client use
case that does not require local-path access, or after a separate upload and
asset-delivery contract exists. That mode would require user authentication,
tenant isolation, rate limits, storage lifecycle, audit logs, and an HTTPS MCP
transport. It is explicitly outside the first version.

## Implementation Sequence

1. Scaffold an `ergouzi-media-mcp` plugin and add behavioral contract tests.
2. Implement the local stdio tools by reusing the validated request and
   media-handling behavior of the current Skills.
3. Update both Skills to prefer MCP tools with the current scripts as fallback.
4. Test create, resume, cancel, external-URL download, local-file conversion,
   idempotent retry, timeout, and secret-redaction behavior on Windows and Unix.
