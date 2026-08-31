import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assertArtifactName(name) {
  if (
    typeof name !== 'string' ||
    name.length > 64 ||
    !NAME_PATTERN.test(name)
  ) {
    throw new Error(
      `Invalid artifact name "${name}". Use at most 64 lowercase letters, digits, and single hyphens.`,
    );
  }
}

export function titleFromName(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function directoryNames(parent) {
  try {
    return (await fs.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseCliArguments(argv) {
  const values = {};
  const flags = new Set();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    if (argument === '--with-openai-metadata' || argument === '--check') {
      flags.add(argument.slice(2));
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value.`);
    }
    values[argument.slice(2)] = value;
    index += 1;
  }
  return { values, flags, positionals };
}

export function isMain(importMetaUrl) {
  return (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(importMetaUrl))
  );
}
