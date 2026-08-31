import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateRepository } from '../scripts/validate-repository.mjs';
import { createRepository, writePlugin, writeSkill } from './helpers.mjs';

async function withRepository(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ergouzi-skills-test-'));
  await createRepository(root);
  return run(root);
}

async function createSymlinkForTest(t, target, linkPath) {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch (error) {
    if (
      process.platform === 'win32' &&
      ['EACCES', 'EPERM'].includes(error.code)
    ) {
      t.skip(`Windows symlink privileges unavailable (${error.code})`);
      return false;
    }
    throw error;
  }
}

test('an empty repository is valid', async () => {
  await withRepository(async (root) => {
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.deepEqual(result.errors, []);
  });
});

test('a valid portable Skill passes', async () => {
  await withRepository(async (root) => {
    await writeSkill(root, 'review-new-api');
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.deepEqual(result.errors, []);
    assert.equal(result.skills.length, 1);
  });
});

test('Skill directory and name must match standard kebab-case', async () => {
  await withRepository(async (root) => {
    await writeSkill(root, 'review-new-api', {
      name: 'ergouzi:review-new-api',
    });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(
      result.errors.join('\n'),
      /must match its directory|invalid name/i,
    );
  });
});

test('Skill version must use strict SemVer', async () => {
  await withRepository(async (root) => {
    await writeSkill(root, 'review-new-api', { version: 'version-one' });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /SemVer/i);
  });
});

test('SemVer numeric prerelease identifiers cannot have leading zeroes', async () => {
  await withRepository(async (root) => {
    await writeSkill(root, 'review-new-api', { version: '1.0.0-alpha.01' });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /SemVer/i);
  });
});

test('missing linked Skill resources are rejected', async () => {
  await withRepository(async (root) => {
    await writeSkill(root, 'review-new-api', {
      body: '# Example Skill\n\nRead [the contract](references/contract.md).\n',
    });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /missing linked resource/i);
  });
});

test('plugin directories require at least one supported manifest', async () => {
  await withRepository(async (root) => {
    await writePlugin(root, 'empty-plugin');
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /supported plugin manifest/i);
  });
});

test('cross-platform plugin versions must match', async () => {
  await withRepository(async (root) => {
    await writePlugin(root, 'versioned-plugin', {
      claude: true,
      codex: true,
      version: '1.0.0',
      codexVersion: '1.1.0',
    });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /versions must match/i);
  });
});

test('plugin runtime files cannot traverse outside the plugin', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'unsafe-plugin', {
      claude: true,
    });
    await fs.writeFile(
      path.join(pluginRoot, 'runtime.json'),
      '{"command":"../shared/run.mjs"}\n',
    );
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /path traversal/i);
  });
});

test('plugins cannot use symlinks as hidden external dependencies', async (t) => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'linked-plugin', {
      claude: true,
    });
    const external = path.join(root, 'shared-runtime.mjs');
    await fs.writeFile(external, 'export const value = true;\n');
    if (
      !(await createSymlinkForTest(
        t,
        external,
        path.join(pluginRoot, 'runtime.mjs'),
      ))
    )
      return;
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /must not contain symlinks/i);
  });
});

test('portable Skills cannot use symlinks as hidden external dependencies', async (t) => {
  await withRepository(async (root) => {
    const skillRoot = await writeSkill(root, 'linked-skill');
    const external = path.join(root, 'private-reference.md');
    await fs.writeFile(external, '# Private reference\n');
    if (
      !(await createSymlinkForTest(
        t,
        external,
        path.join(skillRoot, 'reference.md'),
      ))
    )
      return;
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(
      result.errors.join('\n'),
      /Skill linked-skill must not contain symlinks/i,
    );
  });
});

test('the portable Skills collection cannot contain symlinked directories', async (t) => {
  await withRepository(async (root) => {
    const externalRoot = path.join(root, 'external-skill');
    await fs.mkdir(externalRoot);
    await fs.writeFile(path.join(externalRoot, 'SKILL.md'), '# Hidden Skill\n');
    if (
      !(await createSymlinkForTest(
        t,
        externalRoot,
        path.join(root, 'skills', 'hidden-skill'),
      ))
    )
      return;
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(
      result.errors.join('\n'),
      /skills collection must not contain symlinks/i,
    );
  });
});

test('Windows-style traversal is rejected in plugin paths and content', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'windows-traversal', {
      codex: true,
    });
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.skills = './..\\shared';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(
      path.join(pluginRoot, 'runtime.json'),
      '{"command":"..\\\\shared\\\\run.mjs"}\n',
    );
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /path traversal|schema error/i);
  });
});

test('Codex plugin Skills must contain a valid SKILL.md', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'missing-plugin-skill', {
      codex: true,
    });
    await fs.mkdir(path.join(pluginRoot, 'skills', 'broken-skill'), {
      recursive: true,
    });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /missing.*SKILL\.md/i);
  });
});

test('Claude-only plugin Skills must contain a valid SKILL.md', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'missing-claude-skill', {
      claude: true,
    });
    await fs.mkdir(path.join(pluginRoot, 'skills', 'broken-skill'), {
      recursive: true,
    });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /missing.*SKILL\.md/i);
  });
});

test('Codex plugin MCP companion manifests must be valid', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'broken-mcp-plugin', {
      codex: true,
    });
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.mcpServers = './.mcp.json';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(pluginRoot, '.mcp.json'), '{"wrong":{}}\n');
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /\.mcp\.json.*mcpServers/i);
  });
});

test('Codex plugin MCP companions may use a safe relative filename', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'custom-mcp-plugin', {
      codex: true,
    });
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.mcpServers = './.codex.mcp.json';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(
      path.join(pluginRoot, '.codex.mcp.json'),
      JSON.stringify({
        mcpServers: { primary: { command: 'node', args: [] } },
      }),
    );
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.deepEqual(result.errors, []);
  });
});

test('Codex plugin inline MCP servers must contain object entries', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'broken-inline-mcp', {
      codex: true,
    });
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.mcpServers = { primary: 'not-an-object' };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /mcpServers.*primary.*object/i);
  });
});

test('Codex plugin app companion manifests must be valid', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'broken-app-plugin', {
      codex: true,
    });
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.apps = './.app.json';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(pluginRoot, '.app.json'), '{"apps":[]}\n');
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /\.app\.json.*apps.*object/i);
  });
});

test('Codex plugin manifests must satisfy the repository schema', async () => {
  await withRepository(async (root) => {
    const pluginRoot = await writePlugin(root, 'codex-plugin', { codex: true });
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    delete manifest.interface.category;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /category/i);
  });
});

test('Codex plugin schema rejects numeric prerelease leading zeroes', async () => {
  await withRepository(async (root) => {
    await writePlugin(root, 'invalid-semver-plugin', {
      codex: true,
      version: '1.0.0-01',
    });
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /SemVer|schema error/i);
  });
});

test('public repository files reject personal absolute home paths', async () => {
  await withRepository(async (root) => {
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(
      path.join(root, 'docs', 'unsafe.md'),
      `Run \`${'/Users'}/example/private-tool\` before using this artifact.\n`,
    );
    const result = await validateRepository(root, { checkCatalogs: false });
    assert.match(result.errors.join('\n'), /personal absolute path/i);
  });
});
