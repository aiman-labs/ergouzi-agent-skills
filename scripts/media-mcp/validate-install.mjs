#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, '..', '..');
const defaultPluginRoot = path.join(
  repositoryRoot,
  'plugins',
  'ergouzi-media-mcp',
);
const EXPECTED_SERVER_NAME = 'ergouzi-media-mcp';

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to read ${path.relative(repositoryRoot, filePath)}: ${error.message}`,
    );
  }
}

function expandPluginRoot(value, pluginRoot) {
  return value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${PLUGIN_ROOT}', pluginRoot);
}

function isWithinRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function assertManifest(manifest, platform, pluginRoot) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error(`${platform} manifest must be a JSON object`);
  if (manifest.name !== EXPECTED_SERVER_NAME)
    throw new Error(
      `${platform} manifest name must be ${EXPECTED_SERVER_NAME}`,
    );
  if (typeof manifest.version !== 'string' || !manifest.version)
    throw new Error(`${platform} manifest must declare a version`);
  if (typeof manifest.description !== 'string' || !manifest.description.trim())
    throw new Error(`${platform} manifest must declare a description`);
  if (
    platform === 'Codex' &&
    (typeof manifest.mcpServers !== 'string' ||
      !manifest.mcpServers.startsWith('./'))
  )
    throw new Error(
      'Codex manifest mcpServers must point to a relative JSON file',
    );
  if (platform === 'Claude' && manifest.mcpServers !== undefined)
    throw new Error(
      'Claude manifest must use the plugin-root .mcp.json companion file',
    );
  if (!path.isAbsolute(pluginRoot))
    throw new Error('Plugin root must be absolute');
}

function assertMcpConfiguration(
  configuration,
  pluginRoot,
  { expand = false } = {},
) {
  const servers = configuration?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    throw new Error('.mcp.json must contain an mcpServers object');
  const server = servers[EXPECTED_SERVER_NAME];
  if (!server || typeof server !== 'object' || Array.isArray(server))
    throw new Error(`.mcp.json is missing ${EXPECTED_SERVER_NAME}`);
  if (typeof server.command !== 'string' || !server.command.trim())
    throw new Error('MCP server command must be a nonempty string');
  if (
    !Array.isArray(server.args) ||
    server.args.some((arg) => typeof arg !== 'string')
  )
    throw new Error('MCP server args must be an array of strings');
  if (
    server.cwd !== undefined &&
    (typeof server.cwd !== 'string' || !server.cwd.trim())
  )
    throw new Error('MCP server cwd must be a nonempty string when provided');
  const cwd = path.resolve(pluginRoot, server.cwd || '.');
  if (!isWithinRoot(cwd, pluginRoot))
    throw new Error('MCP server cwd escapes the plugin root');
  const scriptArgument = server.args.find((arg) =>
    /(?:^|[\\/])scripts[\\/]server\.mjs$/.test(arg),
  );
  if (!scriptArgument)
    throw new Error('MCP server args must include scripts/server.mjs');
  const resolvedArgument = expand
    ? expandPluginRoot(scriptArgument, pluginRoot)
    : scriptArgument;
  const serverPath = path.resolve(pluginRoot, resolvedArgument);
  if (!isWithinRoot(serverPath, pluginRoot))
    throw new Error('MCP server path escapes the plugin root');
  return { server, serverPath, cwd, expand };
}

function initializeRequest() {
  return [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'ergouzi-media-mcp-install-check',
          version: '1.0.0',
        },
      },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ].join('\n');
}

function assertBundledServer(
  server,
  serverPath,
  serverName,
  serverVersion,
  serverRoot,
  { expand = false, cwd = serverRoot } = {},
) {
  const args = server.args.map((arg) =>
    expand ? expandPluginRoot(arg, serverRoot) : arg,
  );
  const result = spawnSync(server.command, args, {
    cwd,
    env: {
      ...process.env,
      ...(expand ? { CLAUDE_PLUGIN_ROOT: serverRoot } : {}),
    },
    input: `${initializeRequest()}\n`,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error)
    throw new Error(
      `Bundled MCP server failed to start: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(
      `Bundled MCP server exited with ${result.status}: ${result.stderr}`,
    );
  const responses = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `MCP stdout contained a non-JSON line: ${error.message}`,
        );
      }
    });
  const initialize = responses.find((response) => response.id === 1);
  const tools = responses.find((response) => response.id === 2)?.result?.tools;
  if (initialize?.result?.serverInfo?.name !== serverName)
    throw new Error('MCP initialize response has the wrong server name');
  if (initialize?.result?.serverInfo?.version !== serverVersion)
    throw new Error('MCP initialize response has the wrong server version');
  if (!Array.isArray(tools) || tools.length === 0)
    throw new Error('MCP tools/list returned no tools');
  if (tools.some((tool) => !tool.outputSchema))
    throw new Error('Every MCP tool must declare an outputSchema');
  return { toolCount: tools.length };
}

export async function validateMediaMcpInstall(pluginRoot = defaultPluginRoot) {
  const resolvedRoot = path.resolve(pluginRoot);
  const [claude, codex, claudeMcp, codexMcp] = await Promise.all([
    readJson(path.join(resolvedRoot, '.claude-plugin', 'plugin.json')),
    readJson(path.join(resolvedRoot, '.codex-plugin', 'plugin.json')),
    readJson(path.join(resolvedRoot, '.mcp.json')),
    readJson(path.join(resolvedRoot, '.codex.mcp.json')),
  ]);
  assertManifest(claude, 'Claude', resolvedRoot);
  assertManifest(codex, 'Codex', resolvedRoot);
  if (claude.version !== codex.version)
    throw new Error('Claude and Codex manifest versions must match');
  const claudeConfig = assertMcpConfiguration(claudeMcp, resolvedRoot, {
    expand: true,
  });
  const codexConfig = assertMcpConfiguration(codexMcp, resolvedRoot);
  assertBundledServer(
    claudeConfig.server,
    claudeConfig.serverPath,
    EXPECTED_SERVER_NAME,
    claude.version,
    resolvedRoot,
    { expand: true, cwd: claudeConfig.cwd },
  );
  const result = assertBundledServer(
    codexConfig.server,
    codexConfig.serverPath,
    EXPECTED_SERVER_NAME,
    codex.version,
    resolvedRoot,
    { cwd: codexConfig.cwd },
  );
  return {
    pluginRoot: resolvedRoot,
    command: codexConfig.server.command,
    serverPath: codexConfig.serverPath,
    ...result,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  validateMediaMcpInstall(process.argv[2] || defaultPluginRoot)
    .then((result) => {
      console.log(
        `Media MCP install check passed: ${result.toolCount} tools from ${result.pluginRoot}`,
      );
    })
    .catch((error) => {
      console.error(`Media MCP install check failed: ${error.message}`);
      process.exitCode = 1;
    });
}
