import assert from 'node:assert/strict';
import test from 'node:test';
import { filterOptions } from '../src/core/options.ts';

test('option search consistently matches ids, localized labels, notes and alternate keywords', () => {
  const options = [
    { value: 'ja', label: '日语', note: 'Japanese', keywords: '日本語', icon: 'keep-metadata' },
    { value: 'Tina', label: '甜甜', note: '温柔女声', keywords: 'Sweet Female' },
  ];
  for (const query of [' JA ', '日语', 'JAPANESE', '日本語']) assert.deepEqual(filterOptions(options, query), [options[0]]);
  for (const query of ['tina', '温柔', 'female']) assert.deepEqual(filterOptions(options, query), [options[1]]);
  assert.equal(filterOptions(options, 'japanese')[0], options[0]);
});

test('empty search preserves the source array and absent fields do not become searchable text', () => {
  const options = [{ value: 'en', label: 'English' }];
  assert.equal(filterOptions(options, '  '), options);
  assert.deepEqual(filterOptions(options, 'undefined'), []);
  assert.deepEqual(filterOptions(options, 'missing'), []);
  assert.deepEqual(options, [{ value: 'en', label: 'English' }]);
});
