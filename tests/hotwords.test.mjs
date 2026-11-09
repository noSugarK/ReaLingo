import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHotwords } from '../src/core/hotwords.ts';
test('hotwords accept bilingual terms, CRLF, duplicates and equals in translations while ignoring drafts', () => {
  assert.deepEqual(parseHotwords(' 人工智能 = AI\r\nmissing\n = empty\nempty=\nformula=x=1\n人工智能=Artificial Intelligence'),
    { 人工智能: 'Artificial Intelligence', formula: 'x=1' });
  assert.equal(Object.keys(parseHotwords(Array.from({length: 1002}, (_, i) => `term${i}=value`).join('\n'))).length, 1000);
  assert.deepEqual(parseHotwords(''), {});
});
