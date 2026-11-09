import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/core/update.ts';

test('release checks order prereleases numerically and offer stable to beta users', () => {
  const versions = ['v0.7.1', 'v0.8.0-alpha.1', 'v0.8.0-beta.1', 'v0.8.0-beta.2', 'v0.8.0-beta.10', 'v0.8.0-rc.1', 'v0.8.0', 'v0.8.1', 'v0.8.10'];
  for (let i = 0; i < versions.length; i++) {
    assert.equal(isNewer(versions[i], versions[i]), false);
    if (!i) continue;
    assert.equal(isNewer(versions[i], versions[i - 1]), true);
    assert.equal(isNewer(versions[i - 1], versions[i]), false);
  }
  assert.equal(isNewer('v0.8.0+build.2', '0.8.0+build.1'), false);
});
