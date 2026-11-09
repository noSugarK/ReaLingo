import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchGradle } from '../scripts/fetch-gradle.mjs';

test('Gradle uses the exact official asset and refuses unverified downloads', t => {
  const root = mkdtempSync(join(tmpdir(), 'gradle-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wrapper = join(root, 'wrapper.properties');
  const original = 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\nnetworkTimeout=120000\n';
  const zip = Buffer.from('fixture distribution');
  const asset = { digest: 'sha256:' + createHash('sha256').update(zip).digest('hex') };
  let downloads = 0;
  const gh = args => {
    if (args[0] === 'api') { assert.match(args[1], /v8\.14\.3$/); return JSON.stringify(asset); }
    assert.ok(args.includes('gradle/gradle-distributions'));
    assert.ok(args.includes('gradle-8.14.3-bin.zip'));
    downloads++;
    writeFileSync(join(root, 'gradle-8.14.3-bin.zip'), zip);
  };
  writeFileSync(wrapper, original);
  fetchGradle(wrapper, root, gh);
  assert.ok(readFileSync(wrapper, 'utf8').includes(pathToFileURL(join(root, 'gradle-8.14.3-bin.zip')).href));
  assert.match(readFileSync(wrapper, 'utf8'), /networkTimeout=120000/);
  writeFileSync(wrapper, original);
  fetchGradle(wrapper, root, gh);
  assert.equal(downloads, 1, 'a verified cached distribution is reused');
  writeFileSync(wrapper, original);
  asset.digest = 'sha256:' + '0'.repeat(64);
  assert.throws(() => fetchGradle(wrapper, root, gh), /SHA-256 mismatch/);
  assert.equal(readFileSync(wrapper, 'utf8'), original, 'bad downloads never reach the wrapper');
});
