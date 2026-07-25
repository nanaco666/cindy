import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  findBaselineMigrationChanges,
  findFrozenMigrationChanges,
  normalizedSha256,
  resolveMainBaseline,
} from '../../apps/desktop/scripts/lib/migration-freeze.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function createFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-migration-freeze-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Migration Freeze Test');
  git(repo, 'config', 'user.email', 'migration-freeze@example.invalid');
  const drizzleDir = path.join(repo, 'apps', 'desktop', 'drizzle');
  fs.mkdirSync(drizzleDir, { recursive: true });
  const initialSql = 'CREATE TABLE sample (id TEXT PRIMARY KEY);\n';
  fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), initialSql);
  const scriptsDir = path.join(drizzleDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, '0000_init.ts'),
    'function run() {}\nmodule.exports = { run };\n',
  );
  fs.writeFileSync(
    path.join(drizzleDir, 'migration-baseline.json'),
    `${JSON.stringify({
      version: 1,
      algorithm: 'sha256',
      lineEndings: 'lf',
      sourceCommit: '1'.repeat(40),
      migrations: { '0000_init.sql': normalizedSha256(initialSql) },
    }, null, 2)}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial migration');
  const anchor = git(repo, 'rev-parse', 'HEAD');
  return {
    repo,
    anchor,
    cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

test('fixed baseline allows new migrations while migrated SQL stays unchanged', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.repo, 'apps', 'desktop', 'drizzle', '0001_new.sql'),
      'ALTER TABLE sample ADD COLUMN name TEXT;\n',
    );
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, []);
  } finally {
    fixture.cleanup();
  }
});

test('fixed baseline rejects modifying or deleting migrated SQL', () => {
  const fixture = createFixture();
  const migrationPath = path.join(fixture.repo, 'apps', 'desktop', 'drizzle', '0000_init.sql');
  try {
    fs.writeFileSync(migrationPath, 'CREATE TABLE sample (id TEXT PRIMARY KEY, name TEXT);\n');
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, [
      { path: 'apps/desktop/drizzle/0000_init.sql', kind: 'modified' },
    ]);
    fs.rmSync(migrationPath);
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, [
      { path: 'apps/desktop/drizzle/0000_init.sql', kind: 'deleted' },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('new repository main baseline keeps freezing committed migrations', () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, []);
    assert.deepEqual(
      resolveMainBaseline(fixture.repo, { XDT_MIGRATION_BASE_REF: fixture.anchor }),
      { ref: fixture.anchor, commit: fixture.anchor },
    );
  } finally {
    fixture.cleanup();
  }
});

test('new repository main baseline freezes companion runtime scripts', () => {
  const fixture = createFixture();
  const scriptPath = path.join(
    fixture.repo,
    'apps',
    'desktop',
    'drizzle',
    'scripts',
    '0000_init.ts',
  );
  try {
    fs.writeFileSync(
      scriptPath,
      'function run() { return 1; }\nmodule.exports = { run };\n',
    );
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, [
      { path: 'apps/desktop/drizzle/scripts/0000_init.ts', kind: 'modified' },
    ]);

    fs.rmSync(scriptPath);
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, [
      { path: 'apps/desktop/drizzle/scripts/0000_init.ts', kind: 'deleted' },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('adding a runtime script to an already-frozen SQL changes its identity', () => {
  const fixture = createFixture();
  const scriptPath = path.join(
    fixture.repo,
    'apps',
    'desktop',
    'drizzle',
    'scripts',
    '0000_init.ts',
  );
  try {
    fs.rmSync(scriptPath);
    git(fixture.repo, 'add', '-u');
    git(fixture.repo, 'commit', '-m', 'baseline without runtime script');
    const noScriptAnchor = git(fixture.repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(scriptPath, 'function run() {}\nmodule.exports = { run };\n');
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, noScriptAnchor).violations, [
      {
        path: 'apps/desktop/drizzle/scripts/0000_init.ts',
        kind: 'added-runtime-script',
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a new migration may add its companion runtime script', () => {
  const fixture = createFixture();
  try {
    const drizzleDir = path.join(fixture.repo, 'apps', 'desktop', 'drizzle');
    fs.writeFileSync(path.join(drizzleDir, '0001_new.sql'), 'SELECT 1;\n');
    fs.writeFileSync(
      path.join(drizzleDir, 'scripts', '0001_new.ts'),
      'function run() {}\nmodule.exports = { run };\n',
    );
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, []);
  } finally {
    fixture.cleanup();
  }
});
