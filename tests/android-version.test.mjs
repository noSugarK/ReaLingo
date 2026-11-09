import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBadging } from '../scripts/verify-android-package.mjs';
test('the installable package must expose the same version as the application', () => {
  assert.deepEqual(verifyBadging("package: name='com.nosugark.realingo' versionCode='9000101' versionName='0.8.0-beta.1'", 'com.nosugark.realingo', '0.8.0-beta.1'),
    { packageId: 'com.nosugark.realingo', versionName: '0.8.0-beta.1', versionCode: 9000101 });
  assert.throws(() => verifyBadging("package: name='com.nosugark.realingo' versionCode='1000000' versionName='1.0'", 'com.nosugark.realingo', '0.7.2'), /system sees version/);
  assert.throws(() => verifyBadging("package: name='com.nosugark.realingo.debug' versionCode='1007002' versionName='0.7.2'", 'com.nosugark.realingo', '0.7.2'), /application id/);
});
