#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { directoryNames, isMain } from './lib/artifacts.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, '..');
const SKILLS_REF_COMMIT = '38a2ff82958afee88dadf4831509e6f7e9d8ef4e';
const SKILLS_REF_SOURCE = `git+https://github.com/agentskills/agentskills.git@${SKILLS_REF_COMMIT}#subdirectory=skills-ref`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? { PYTHONUTF8: '1' } : {}),
      },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

export async function discoverSkillPaths(root = repositoryRoot) {
  const skillPaths = [];
  for (const skill of await directoryNames(path.join(root, 'skills'))) {
    skillPaths.push(path.join(root, 'skills', skill));
  }
  for (const plugin of await directoryNames(path.join(root, 'plugins'))) {
    const pluginSkillsRoot = path.join(root, 'plugins', plugin, 'skills');
    for (const skill of await directoryNames(pluginSkillsRoot)) {
      skillPaths.push(path.join(pluginSkillsRoot, skill));
    }
  }
  return skillPaths;
}

export async function validateSpecification(root = repositoryRoot) {
  const skillPaths = await discoverSkillPaths(root);
  if (skillPaths.length === 0) {
    console.log(
      'Agent Skills specification validation skipped: no portable Skills yet.',
    );
    return 0;
  }
  for (const skillPath of skillPaths) {
    const code = await run('uvx', [
      '--from',
      SKILLS_REF_SOURCE,
      'skills-ref',
      'validate',
      skillPath,
    ]);
    if (code !== 0) return code;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  validateSpecification()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`validate-spec: ${error.message}`);
      process.exitCode = 1;
    });
}
