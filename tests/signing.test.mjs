import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureSigning } from '../scripts/configure-android-signing.mjs';

function envFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'realingo-signing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { RUNNER_TEMP: dir, GITHUB_ENV: join(dir, 'env'), GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
}
test('upgradeable builds require persistent signing instead of silently changing identity', (t) => {
  assert.throws(() => configureSigning({ ...envFor(t), ANDROID_REQUIRE_SIGNING: 'true' }), /persistent signing key/);
});
test('all four configured secrets select the existing keystore alias without leaking passwords', (t) => {
  const env = { ...envFor(t), ANDROID_REQUIRE_SIGNING: 'true', ANDROID_KEYSTORE_BASE64: Buffer.from('test keystore').toString('base64'),
    ANDROID_KEYSTORE_PASSWORD: 'test-store-password', ANDROID_KEY_ALIAS: ' Release\n', ANDROID_KEY_PASSWORD: 'test-key-password' };
  assert.equal(configureSigning(env, () => ['release']), true);
  const output = readFileSync(env.GITHUB_ENV, 'utf8');
  assert.match(output, /ANDROID_SIGNING_ALIAS=release/);
  assert.doesNotMatch(output, /test-store-password|test-key-password/);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /signed=true/);
});
test('a partial secret set fails before generating an incompatible APK', (t) => {
  assert.throws(() => configureSigning({ ...envFor(t), ANDROID_KEY_ALIAS: 'release' }), /all four/);
});
