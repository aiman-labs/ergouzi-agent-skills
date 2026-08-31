#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';

import {
  directoryNames,
  isMain,
  NAME_PATTERN,
  pathExists,
  readJson,
  SEMVER_PATTERN,
} from './lib/artifacts.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, '..');
const schemaRoot = path.join(repositoryRoot, 'schemas');
const TEXT_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.py',
  '.sh',
  '.toml',
]);

function parseFrontmatter(content, filePath) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Missing YAML frontmatter: ${filePath}`);
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid YAML frontmatter in ${filePath}: ${document.errors.map((item) => item.message).join('; ')}`,
    );
  }
  return { data: document.toJS(), body: content.slice(match[0].length) };
}

async function validateSkill(skillRoot, directory, location) {
  const errors = [];
  const warnings = [];
  const skillPath = path.join(skillRoot, 'SKILL.md');
  const label = location ?? `Skill ${directory}`;
  let parsed;
  try {
    parsed = parseFrontmatter(await fs.readFile(skillPath, 'utf8'), skillPath);
  } catch (error) {
    errors.push(
      `${label} is missing or has an invalid SKILL.md: ${error.message}`,
    );
    return { directory, errors, warnings, metadata: null };
  }

  const metadata = parsed.data;
  if (!NAME_PATTERN.test(directory) || directory.length > 64) {
    errors.push(`${label} has an invalid directory name.`);
  }
  if (metadata.name !== directory) {
    errors.push(
      `${label} name "${metadata.name ?? '(missing)'}" must match its directory "${directory}".`,
    );
  }
  if (
    typeof metadata.description !== 'string' ||
    metadata.description.trim() === ''
  ) {
    errors.push(`${label} requires a nonempty description.`);
  } else if (metadata.description.length > 1024) {
    errors.push(`${label} description exceeds 1024 characters.`);
  }
  if (metadata.license !== 'MIT') {
    errors.push(`${label} must declare license: MIT.`);
  }
  if (
    typeof metadata.metadata?.author !== 'string' ||
    !metadata.metadata.author
  ) {
    errors.push(`${label} requires string metadata.author.`);
  }
  if (
    typeof metadata.metadata?.version !== 'string' ||
    !SEMVER_PATTERN.test(metadata.metadata.version)
  ) {
    errors.push(`${label} metadata.version must use strict SemVer.`);
  }

  const lineCount = parsed.body.split(/\r?\n/).length;
  if (lineCount > 500) {
    warnings.push(`${label} SKILL.md body exceeds 500 lines.`);
  }

  const linkPattern = /\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  for (const match of parsed.body.matchAll(linkPattern)) {
    const rawTarget = match[1].split('#')[0].trim().replace(/^<|>$/g, '');
    if (!rawTarget) continue;
    const normalizedTarget = normalizeArchivePath(
      decodeURIComponent(rawTarget),
    );
    if (normalizedTarget === null) {
      errors.push(`${label} link escapes the Skill directory: ${rawTarget}`);
      continue;
    }
    const resolved = path.resolve(skillRoot, normalizedTarget);
    if (!resolved.startsWith(`${skillRoot}${path.sep}`)) {
      errors.push(`${label} link escapes the Skill directory: ${rawTarget}`);
    } else if (!(await pathExists(resolved))) {
      errors.push(`${label} has a missing linked resource: ${rawTarget}`);
    }
  }

  for (const forbidden of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
    if (await pathExists(path.join(skillRoot, forbidden))) {
      errors.push(`${label} must not contain ${forbidden}.`);
    }
  }

  for (const linkPath of await findSymlinks(skillRoot)) {
    errors.push(
      `${label} must not contain symlinks: ${path.relative(skillRoot, linkPath)}.`,
    );
  }

  return { directory, errors, warnings, metadata };
}

function normalizeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;
  const normalized = rawPath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }
  const parts = normalized.split('/');
  if (parts.includes('..')) return null;
  return normalized;
}

function describeAjvErrors(errors) {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

async function validateComponentPaths(pluginRoot, manifest, errors, label) {
  const paths = [];
  for (const key of ['skills', 'apps']) {
    if (typeof manifest[key] === 'string') paths.push([key, manifest[key]]);
  }
  if (typeof manifest.mcpServers === 'string') {
    paths.push(['mcpServers', manifest.mcpServers]);
  }
  for (const key of ['composerIcon', 'logo', 'logoDark']) {
    if (typeof manifest.interface?.[key] === 'string') {
      paths.push([`interface.${key}`, manifest.interface[key]]);
    }
  }
  for (const screenshot of manifest.interface?.screenshots ?? []) {
    paths.push(['interface.screenshots', screenshot]);
  }
  for (const [field, relative] of paths) {
    const normalized = normalizeArchivePath(relative);
    if (normalized === null) {
      errors.push(`${label} ${field} contains path traversal: ${relative}`);
      continue;
    }
    const resolved = path.resolve(pluginRoot, normalized);
    if (!resolved.startsWith(`${pluginRoot}${path.sep}`)) {
      errors.push(`${label} ${field} contains path traversal: ${relative}`);
    } else if (!(await pathExists(resolved))) {
      errors.push(`${label} ${field} points to a missing path: ${relative}`);
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateMcpServers(servers, source, errors) {
  if (!isObject(servers)) {
    errors.push(`${source} mcpServers must be an object.`);
    return;
  }
  for (const [name, server] of Object.entries(servers)) {
    if (!name.trim()) errors.push(`${source} server names must be nonempty.`);
    if (!isObject(server)) {
      errors.push(`${source} mcpServers server ${name} must be an object.`);
    }
  }
}

async function validateCompanionJson(pluginRoot, fileName, errors) {
  try {
    const payload = await readJson(path.join(pluginRoot, fileName));
    if (!isObject(payload)) {
      errors.push(`${fileName} must contain a JSON object.`);
      return null;
    }
    return payload;
  } catch (error) {
    errors.push(error.message);
    return null;
  }
}

async function validatePluginSkills(pluginRoot, errors, warnings) {
  const skillsRoot = path.join(pluginRoot, 'skills');
  for (const directory of await directoryNames(skillsRoot)) {
    const result = await validateSkill(
      path.join(skillsRoot, directory),
      directory,
      `Plugin ${path.basename(pluginRoot)} Skill ${directory}`,
    );
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
}

async function validateCodexComponents(pluginRoot, manifest, errors) {
  if (
    manifest.skills !== undefined &&
    normalizeArchivePath(manifest.skills) !== './skills/'
  ) {
    errors.push('Codex manifest skills must resolve to ./skills/.');
  }
  if (typeof manifest.mcpServers === 'string') {
    const normalized = normalizeArchivePath(manifest.mcpServers);
    if (normalized === null) {
      errors.push('Codex manifest mcpServers path contains traversal.');
    } else {
      const payload = await validateCompanionJson(
        pluginRoot,
        normalized,
        errors,
      );
      if (payload) {
        const extra = Object.keys(payload).filter(
          (key) => key !== 'mcpServers',
        );
        if (extra.length > 0) {
          errors.push(
            `${normalized} contains unsupported fields: ${extra.join(', ')}.`,
          );
        }
        validateMcpServers(payload.mcpServers, normalized, errors);
      }
    }
  } else if (manifest.mcpServers !== undefined) {
    validateMcpServers(manifest.mcpServers, 'Codex manifest', errors);
  }

  if (manifest.apps !== undefined) {
    if (normalizeArchivePath(manifest.apps) !== './.app.json') {
      errors.push('Codex manifest apps path must resolve to ./.app.json.');
    }
    const payload = await validateCompanionJson(
      pluginRoot,
      '.app.json',
      errors,
    );
    if (payload) {
      const extra = Object.keys(payload).filter((key) => key !== 'apps');
      if (extra.length > 0) {
        errors.push(
          `.app.json contains unsupported fields: ${extra.join(', ')}.`,
        );
      }
      if (!isObject(payload.apps)) {
        errors.push('.app.json field apps must be an object.');
      } else {
        for (const [name, app] of Object.entries(payload.apps)) {
          if (!isObject(app)) {
            errors.push(`.app.json app ${name} must be an object.`);
            continue;
          }
          const appExtra = Object.keys(app).filter(
            (key) => !['id', 'category'].includes(key),
          );
          if (appExtra.length > 0) {
            errors.push(
              `.app.json app ${name} contains unsupported fields: ${appExtra.join(', ')}.`,
            );
          }
          if (typeof app.id !== 'string' || !app.id.trim()) {
            errors.push(`.app.json app ${name} requires a nonempty id.`);
          }
          if (
            app.category !== undefined &&
            (typeof app.category !== 'string' || !app.category.trim())
          ) {
            errors.push(`.app.json app ${name} category must be nonempty.`);
          }
        }
      }
    }
  }
}

async function walkTextFiles(root) {
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name)))
        files.push(entryPath);
    }
  }
  await visit(root);
  return files;
}

async function findSymlinks(root) {
  const links = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) links.push(entryPath);
      else if (entry.isDirectory()) await visit(entryPath);
    }
  }
  await visit(root);
  return links;
}

async function findDirectSymlinks(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function findPersonalAbsolutePaths(root) {
  const findings = [];
  const skippedDirectories = new Set(['.git', 'node_modules', 'coverage']);
  const pattern =
    /(?:\/Users\/[^/<\s]+\/|\/home\/[^/<\s]+\/|[A-Za-z]:\\Users\\[^\\<\s]+\\)/;
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (
        entry.isFile() &&
        TEXT_EXTENSIONS.has(path.extname(entry.name))
      ) {
        const content = await fs.readFile(entryPath, 'utf8');
        if (pattern.test(content))
          findings.push(path.relative(root, entryPath));
      }
    }
  }
  await visit(root);
  return findings;
}

async function validatePlugin(root, directory, validateCodexManifest) {
  const errors = [];
  const warnings = [];
  const pluginRoot = path.join(root, 'plugins', directory);
  let claude;
  let codex;
  try {
    claude = await readJson(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    );
    codex = await readJson(
      path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    );
  } catch (error) {
    errors.push(error.message);
    return { directory, errors, warnings, claude: null, codex: null };
  }

  if (!claude && !codex) {
    errors.push(
      `Plugin ${directory} requires at least one supported plugin manifest.`,
    );
    return { directory, errors, warnings, claude, codex };
  }
  if (!NAME_PATTERN.test(directory) || directory.length > 64) {
    errors.push(`Plugin directory has an invalid name: plugins/${directory}`);
  }

  for (const [label, manifest] of [
    ['Claude Code manifest', claude],
    ['Codex manifest', codex],
  ]) {
    if (!manifest) continue;
    if (manifest.name !== directory) {
      errors.push(`${label} name must match plugin directory ${directory}.`);
    }
    if (
      typeof manifest.version !== 'string' ||
      !SEMVER_PATTERN.test(manifest.version)
    ) {
      errors.push(`${label} version must use strict SemVer.`);
    }
    if (
      typeof manifest.description !== 'string' ||
      !manifest.description.trim()
    ) {
      errors.push(`${label} requires a description.`);
    }
    if (typeof manifest.author?.name !== 'string' || !manifest.author.name) {
      errors.push(`${label} requires author.name.`);
    }
    if (manifest.license !== 'MIT') {
      errors.push(`${label} must declare license MIT.`);
    }
    await validateComponentPaths(pluginRoot, manifest, errors, label);
  }

  if (codex && !validateCodexManifest(codex)) {
    errors.push(
      `Codex manifest schema error: ${describeAjvErrors(validateCodexManifest.errors)}`,
    );
  }
  await validatePluginSkills(pluginRoot, errors, warnings);
  if (codex) await validateCodexComponents(pluginRoot, codex, errors);
  if (claude && codex && claude.version !== codex.version) {
    errors.push(
      `Cross-platform plugin ${directory} manifest versions must match.`,
    );
  }

  for (const linkPath of await findSymlinks(pluginRoot)) {
    errors.push(
      `Plugin ${directory} must not contain symlinks: ${path.relative(pluginRoot, linkPath)}.`,
    );
  }

  for (const filePath of await walkTextFiles(pluginRoot)) {
    const content = await fs.readFile(filePath, 'utf8');
    if (/(?:^|["'\s:=,(])\.\.[\\/]/m.test(content)) {
      errors.push(
        `Plugin ${directory} contains path traversal in ${path.relative(pluginRoot, filePath)}.`,
      );
    }
  }

  return { directory, errors, warnings, claude, codex };
}

async function loadCodexValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const [pluginSchema, marketplaceSchema] = await Promise.all([
    readJson(path.join(schemaRoot, 'codex-plugin.schema.json')),
    readJson(path.join(schemaRoot, 'codex-marketplace.schema.json')),
  ]);
  return {
    plugin: ajv.compile(pluginSchema),
    marketplace: ajv.compile(marketplaceSchema),
  };
}

export async function validateRepository(
  root = repositoryRoot,
  { checkCatalogs = true } = {},
) {
  const errors = [];
  const warnings = [];
  const validators = await loadCodexValidators();
  const skills = [];
  const plugins = [];

  for (const linkPath of await findDirectSymlinks(path.join(root, 'skills'))) {
    errors.push(
      `Skills collection must not contain symlinks: ${path.basename(linkPath)}.`,
    );
  }
  for (const linkPath of await findDirectSymlinks(path.join(root, 'plugins'))) {
    errors.push(
      `Plugins collection must not contain symlinks: ${path.basename(linkPath)}.`,
    );
  }

  for (const directory of await directoryNames(path.join(root, 'skills'))) {
    const result = await validateSkill(
      path.join(root, 'skills', directory),
      directory,
    );
    skills.push(result);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  for (const directory of await directoryNames(path.join(root, 'plugins'))) {
    const result = await validatePlugin(root, directory, validators.plugin);
    plugins.push(result);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  const codexMarketplacePath = path.join(
    root,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  const codexMarketplace = await readJson(codexMarketplacePath);
  if (!codexMarketplace) {
    errors.push('Missing Codex marketplace: .agents/plugins/marketplace.json');
  } else if (!validators.marketplace(codexMarketplace)) {
    errors.push(
      `Codex marketplace schema error: ${describeAjvErrors(validators.marketplace.errors)}`,
    );
  }

  if (
    !(await pathExists(path.join(root, '.claude-plugin', 'marketplace.json')))
  ) {
    errors.push(
      'Missing Claude Code marketplace: .claude-plugin/marketplace.json',
    );
  }

  for (const file of await findPersonalAbsolutePaths(root)) {
    errors.push(
      `Public repository file contains a personal absolute path: ${file}`,
    );
  }

  if (checkCatalogs) {
    const { checkCatalogs: checkGeneratedCatalogs } =
      await import('./generate-catalog.mjs');
    errors.push(...(await checkGeneratedCatalogs(root)));
  }

  return { errors, warnings, skills, plugins };
}

async function main() {
  const result = await validateRepository();
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Repository validation passed: ${result.skills.length} portable Skill${result.skills.length === 1 ? '' : 's'}, ${result.plugins.length} plugin${result.plugins.length === 1 ? '' : 's'}.`,
  );
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`validate-repository: ${error.message}`);
    process.exitCode = 1;
  });
}
