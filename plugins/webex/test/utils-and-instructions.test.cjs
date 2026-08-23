'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { asArray } = require('../utils/normalise');

// Category: Normalisation helpers.
// asArray is the one export left in this module — cleanString/unique and
// utils/parse-json.js's parseJsonObjectFromText were dropped in the phase-6
// deletion pass along with the pre-v3 pipeline that was their only caller.
describe('normalisation helpers', () => {
  test('normalises arrays, leaving valid arrays untouched', () => {
    const values = ['a', 'a', '', null, 'b'];

    assert.deepEqual(asArray(values), values);
    assert.deepEqual(asArray('not-an-array'), []);
    assert.deepEqual(asArray(undefined), []);
  });
});
