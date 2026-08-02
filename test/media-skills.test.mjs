import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('portable media Skill scripts pass their behavioral suite', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['test/test_media_skills.py'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
  });

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
});
