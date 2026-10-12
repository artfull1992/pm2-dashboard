import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { deriveScramKeys, isScramVerifier, redactScramVerifiers, scramVerifier } from '../../scripts/lib/scram.js';

// RFC 7677 section 3 example exchange.
const RFC = {
  password: 'pencil',
  salt: Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'),
  authMessage: [
    'n=user,r=rOprNGfwEbeRWgbNEkqO',
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
  ].join(','),
  clientProof: 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
  serverSignature: '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
};

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

test('derived keys reproduce the RFC 7677 client proof and server signature', () => {
  const { clientKey, storedKey, serverKey } = deriveScramKeys(RFC.password, RFC.salt, 4096);
  const clientSignature = hmac(storedKey, RFC.authMessage);
  const clientProof = Buffer.from(clientKey.map((byte, i) => byte ^ clientSignature[i]));
  assert.equal(clientProof.toString('base64'), RFC.clientProof);
  assert.equal(hmac(serverKey, RFC.authMessage).toString('base64'), RFC.serverSignature);
});

test('verifier has PostgreSQL format and embeds iterations and salt', () => {
  const verifier = scramVerifier('pencil', { salt: RFC.salt });
  assert.ok(isScramVerifier(verifier));
  assert.ok(verifier.startsWith(`SCRAM-SHA-256$4096:${RFC.salt.toString('base64')}$`));
  assert.ok(!verifier.includes('pencil'));
});

test('random salt makes verifiers for the same password differ', () => {
  assert.notEqual(scramVerifier('samePassword123'), scramVerifier('samePassword123'));
});

test('rejects non-ASCII, empty or whitespace passwords', () => {
  assert.throws(() => scramVerifier(''), TypeError);
  assert.throws(() => scramVerifier('with space'), TypeError);
  assert.throws(() => scramVerifier('пароль'), TypeError);
});

test('isScramVerifier rejects md5 and plaintext', () => {
  assert.equal(isScramVerifier('md5abcdef0123456789'), false);
  assert.equal(isScramVerifier('plaintext'), false);
});

test('redactScramVerifiers hides verifiers in error text', () => {
  const verifier = scramVerifier('pencil');
  const redacted = redactScramVerifiers(`LINE 1: ... PASSWORD '${verifier}';`);
  assert.ok(!redacted.includes(verifier));
  assert.match(redacted, /\[redacted\]/);
});
