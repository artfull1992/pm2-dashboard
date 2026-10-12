import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePassword, MIN_PASSWORD_LENGTH, PASSWORD_ALPHABET } from '../../scripts/lib/password.js';

test('generates 48 alphanumeric characters by default', () => {
  const password = generatePassword();
  assert.equal(password.length, 48);
  assert.match(password, /^[A-Za-z0-9]+$/);
});

test('honours a custom length >= minimum', () => {
  assert.equal(generatePassword(64).length, 64);
  assert.equal(generatePassword(MIN_PASSWORD_LENGTH).length, MIN_PASSWORD_LENGTH);
});

test('rejects lengths below 32 or non-integers', () => {
  assert.throws(() => generatePassword(31), RangeError);
  assert.throws(() => generatePassword(40.5), RangeError);
});

test('produces unique values with a broad character spread', () => {
  const samples = Array.from({ length: 200 }, () => generatePassword());
  assert.equal(new Set(samples).size, samples.length);
  const used = new Set(samples.join(''));
  assert.ok(used.size > PASSWORD_ALPHABET.length * 0.9, `only ${used.size} distinct characters used`);
});
