# Third-party notices

The implementation was independently written for this repository. The
project structure, tool surface, and security test ideas were reviewed against
the MIT-licensed reference project:

<https://github.com/miao111994/codex-ergouzi-media-mcp>

No source files or runtime dependencies from that repository are redistributed
by this plugin.

The generated `scripts/server.mjs` bundle includes the MIT-licensed
`@modelcontextprotocol/sdk` package and its bundled runtime dependencies.
Exact dependency versions are recorded in the repository `package-lock.json`;
the corresponding notices and complete license texts are generated in
`THIRD_PARTY_LICENSES.txt` from the packages actually included in the bundle.
