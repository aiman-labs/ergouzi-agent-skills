import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPlugin } from '../scripts/create-plugin.mjs';
import { createSkill } from '../scripts/create-skill.mjs';

const templatesRoot = path.resolve('templates');

async function makeRoot() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ergouzi-scaffold-test-'),
  );
  await fs.mkdir(path.join(root, 'skills'));
  await fs.mkdir(path.join(root, 'plugins'));
  return root;
}

test('createSkill rejects non-standard names', async () => {
  const root = await makeRoot();
  await assert.rejects(
    createSkill({
      root,
      templatesRoot,
      name: 'ergouzi:unsafe',
      description: 'Use when testing invalid names.',
    }),
    /invalid artifact name/i,
  );
});

test('createSkill writes a complete portable Skill without overwriting', async () => {
  const root = await makeRoot();
  const options = {
    root,
    templatesRoot,
    name: 'review-new-api',
    description:
      'Reviews New API configuration. Use when auditing a deployment.',
  };
  const target = await createSkill(options);
  const content = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8');
  assert.match(content, /^name: review-new-api$/m);
  assert.doesNotMatch(content, /\{\{|TODO/);
  await assert.rejects(createSkill(options), /already exists/i);
});

for (const [target, expected] of [
  [
    'cross-platform',
    ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'],
  ],
  ['claude-code', ['.claude-plugin/plugin.json']],
  ['codex', ['.codex-plugin/plugin.json']],
]) {
  test(`createPlugin supports ${target}`, async () => {
    const root = await makeRoot();
    const pluginRoot = await createPlugin({
      root,
      templatesRoot,
      name: `${target}-example`,
      target,
      description: `Use the ${target} example plugin.`,
    });
    const files = (await fs.readdir(pluginRoot, { recursive: true })).map(
      (file) => file.split(path.sep).join('/'),
    );
    for (const expectedPath of expected) {
      assert.ok(files.includes(expectedPath), `missing ${expectedPath}`);
    }
    assert.equal(
      files.some((file) => file.endsWith('.tmpl')),
      false,
    );
  });
}

test('createPlugin rejects an unknown target', async () => {
  const root = await makeRoot();
  await assert.rejects(
    createPlugin({
      root,
      templatesRoot,
      name: 'unknown-target',
      target: 'all-platforms',
      description: 'Invalid target.',
    }),
    /unsupported plugin target/i,
  );
});
