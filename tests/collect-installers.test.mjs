import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('release installers retain their bytes and identify system and architecture; missing formats fail', () => {
  const cases = [
    ['x86_64-pc-windows-msvc', 'windows_x86_64', ['msi', 'exe']],
    ['x86_64-unknown-linux-gnu', 'linux_x86_64', ['deb', 'rpm']],
    ['universal-apple-darwin', 'macos_universal', ['dmg']],
  ];
  for (const [target, platform, formats] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'realingo-installers-'));
    try {
      const bundle = join(root, 'src-tauri/target', target, 'release/bundle');
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(root, 'src-tauri/Cargo.toml'), '[package]\nversion = "0.7.1"\n');
      const run = () => spawnSync(process.execPath, [resolve('scripts/collect-installers.mjs'), target, root], { encoding: 'utf8' });
      assert.notEqual(run().status, 0, 'an empty bundle must fail');
      for (const format of formats) {
        mkdirSync(join(bundle, format));
        writeFileSync(join(bundle, format, `original.${format}`), `signed ${format} bytes`);
      }
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readdirSync(join(root, 'installers')).length, formats.length);
      for (const format of formats) {
        const suffix = format === 'exe' ? '-setup' : '';
        const file = join(root, 'installers', `ReaLingo_0.7.1_${platform}${suffix}.${format}`);
        assert.equal(readFileSync(file, 'utf8'), `signed ${format} bytes`);
      }
      assert.notEqual(run().status, 0, 'must not overwrite an existing installer');
      if (formats.length > 1) {
        rmSync(join(bundle, formats[0]), { recursive: true });
        assert.notEqual(run().status, 0, 'a missing installer format must fail');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
