import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['main.js', 'styles.css', 'manifest.json'];

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claudian-deploy-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const vault = join(home, 'Documents/KnowledgeBase/Main');
  const destination = join(vault, '.obsidian/plugins/claudian');
  for (const path of [project, bin, destination]) mkdirSync(path, { recursive: true });
  copyFileSync(join(root, 'deploy.sh'), join(project, 'deploy.sh'));
  for (const file of files) {
    writeFileSync(join(project, file), `new ${file}`);
    writeFileSync(join(destination, file), `old ${file}`);
  }
  writeFileSync(join(destination, 'data.json'), 'user settings');
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(process.env.BUILD_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), vault: process.env.OBSIDIAN_VAULT }));
if (process.env.FAIL_BUILD === '1') process.exit(7);
if (process.env.OBSIDIAN_VAULT && process.env.SKIP_COPY !== '1') {
  const destination = path.join(process.env.OBSIDIAN_VAULT, '.obsidian/plugins/claudian');
  fs.mkdirSync(destination, {recursive: true});
  for (const file of ['main.js', 'styles.css', 'manifest.json']) fs.copyFileSync(path.join(process.cwd(), file), path.join(destination, file));
}
`, { mode: 0o755 });
  const log = join(dir, 'build.json');
  return {
    project, vault, destination, log,
    run(args = [], env = {}, cwd = project) {
      return spawnSync('bash', [join(project, 'deploy.sh'), ...args], {
        cwd, encoding: 'utf8',
        env: { ...process.env, HOME: home, OBSIDIAN_VAULT: '', PATH: `${bin}:${process.env.PATH}`, BUILD_LOG: log, ...env },
      });
    },
  };
}

const options = { skip: process.platform === 'win32' };

test('deployment stops on build failure and preserves installed files', options, t => {
  const f = fixture(t);
  const result = f.run([f.vault], { FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0);
  for (const file of files) assert.equal(readFileSync(join(f.destination, file), 'utf8'), `old ${file}`);
});

test('deployment requires a configured Obsidian vault before building', options, t => {
  const f = fixture(t);
  assert.notEqual(f.run().status, 0);
  assert.equal(existsSync(f.log), false);
  assert.notEqual(f.run([join(f.project, 'missing')]).status, 0);
  assert.equal(existsSync(f.log), false);
});

for (const source of ['argument', 'environment', 'local config']) {
  test(`deployment uses the ${source} path and runs from the project directory`, options, t => {
    const f = fixture(t);
    const vault = join(f.project, 'Vault with spaces');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    writeFileSync(join(f.project, '.env.local'), `OBSIDIAN_VAULT="${source === 'local config' ? vault : join(f.project, 'invalid config')}"\n`);
    const args = source === 'argument' ? [vault] : [];
    const env = source === 'argument' ? { OBSIDIAN_VAULT: join(f.project, 'invalid environment') }
      : source === 'environment' ? { OBSIDIAN_VAULT: vault } : {};
    const result = f.run(args, env, f.destination);
    assert.equal(result.status, 0, result.stderr);
    const build = JSON.parse(readFileSync(f.log, 'utf8'));
    assert.equal(build.cwd, f.project);
    assert.deepEqual(build.args, ['run', 'build']);
    assert.equal(build.vault, vault);
    for (const file of files) assert.equal(readFileSync(join(vault, '.obsidian/plugins/claudian', file), 'utf8'), `new ${file}`);
    assert.equal(readFileSync(join(f.destination, 'data.json'), 'utf8'), 'user settings');
  });
}

test('deployment rejects a successful build when installed artifacts do not match', options, t => {
  const f = fixture(t);
  const result = f.run([f.vault], { OBSIDIAN_VAULT: f.vault, SKIP_COPY: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(f.destination, 'main.js'), 'utf8'), 'old main.js');
});
