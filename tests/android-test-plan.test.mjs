import assert from 'node:assert/strict';
import test from 'node:test';
import { androidTestPlan, androidReleaseReady } from '../scripts/android-test-plan.mjs';

test('documentation-only changes skip heavy Android jobs, including deleted notes', () => {
  assert.equal(androidTestPlan(['README.md', '.github/release-notes/v0.8.0.md'], { event: 'push' }).run, false);
});

test('PRs build ARM64 and x86_64 APKs and exercise Android 15', () => {
  const plan = androidTestPlan(['src/mobile/MobileApp.vue', 'README.md'], { event: 'pull_request' });
  assert.equal(plan.run, true);
  assert.deepEqual(plan.targets, ['x86_64', 'aarch64']);
  assert.deepEqual(plan.devices.map(device => device.api), [35]);
});

test('main builds both architectures and retains 4 KB and 16 KB device coverage', () => {
  const plan = androidTestPlan(['src-tauri/Cargo.lock'], { event: 'push' });
  assert.equal(plan.run, true);
  assert.deepEqual(plan.targets, ['x86_64', 'aarch64']);
  assert.deepEqual(plan.devices.map(device => device['page-size']), [4096, 16384]);
  for (const file of ['tests/native.test.mjs', 'scripts/smoke-android.mjs', '.github/workflows/android-test.yml', 'brand/android-icon.svg']) {
    assert.equal(androidTestPlan([file], { event: 'push' }).run, true, file);
  }
});

test('manual full validation runs even without app changes and covers both page sizes', () => {
  const plan = androidTestPlan([], { event: 'workflow_dispatch', full: true });
  assert.equal(plan.run, true);
  assert.deepEqual(plan.targets, ['x86_64', 'aarch64']);
  assert.equal(plan.devices.length, 2);
});

test('a skipped documentation run or partial PR run cannot satisfy the release smoke gate', () => {
  const api35 = { name: 'launch (35, google_apis, 4096)', conclusion: 'success' };
  const api36 = { name: 'launch (36, google_apis_ps16k, 16384)', conclusion: 'success' };
  assert.equal(androidReleaseReady([]), false);
  assert.equal(androidReleaseReady([api35]), false);
  assert.equal(androidReleaseReady([api35, { ...api36, conclusion: 'skipped' }]), false);
  assert.equal(androidReleaseReady([api35, { ...api36, conclusion: 'failure' }]), false);
  assert.equal(androidReleaseReady([api35, api36]), true);
});
