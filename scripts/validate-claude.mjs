#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { directoryNames, isMain, pathExists } from './lib/artifacts.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, '..');

export async function validateClaude(root = repositoryRoot) {
  const pluginNames = await directoryNames(path.join(root, 'plugins'));
  const compatible = [];
  for (const name of pluginNames) {
    if (
      await pathExists(
        path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json'),
      )
    ) {
      compatible.push(name);
    }
  }
  if (compatible.length === 0) {
    console.log(
      'Claude Code validation skipped: no Claude-compatible plugins yet.',
    );
    return 0;
  }

  return new Promise((resolve, reject) => {
    const executable =
      process.platform === 'win32'
        ? path.join(
            root,
            'node_modules',
            '@anthropic-ai',
            'claude-code',
            'bin',
            'claude.exe',
          )
        : path.join(root, 'node_modules', '.bin', 'claude');
    const child = spawn(executable, ['plugin', 'validate', '--strict', root], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`claude terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

if (isMain(import.meta.url)) {
  validateClaude()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`validate-claude: ${error.message}`);
      process.exitCode = 1;
    });
}
