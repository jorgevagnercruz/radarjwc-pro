const test = require('node:test');
const assert = require('node:assert/strict');

const dbPath = require.resolve('../lib/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { createPool: () => null }
};

const {
  normalizeEmail,
  validateIdentity,
  validatePassword,
  hashPassword,
  verifyPassword,
  sameOrigin
} = require('../lib/auth');

test('normaliza e valida a identidade', () => {
  assert.equal(normalizeEmail('  Pessoa@Example.COM '), 'pessoa@example.com');
  assert.deepEqual(
    validateIdentity(' Pessoa ', 'Pessoa@Example.COM', 'SenhaForte123'),
    { name: 'Pessoa', email: 'pessoa@example.com' }
  );
  assert.match(validateIdentity('P', 'x', 'fraca').error, /nome/i);
  assert.match(validatePassword('sem-numero-A'), /número/i);
});

test('gera hash scrypt individual e verifica a senha', async () => {
  const first = await hashPassword('SenhaForte123');
  const second = await hashPassword('SenhaForte123');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('SenhaForte123', first), true);
  assert.equal(await verifyPassword('SenhaErrada123', first), false);
  assert.equal(await verifyPassword('x'.repeat(201), first), false);
});

test('bloqueia requisições mutáveis vindas de outra origem', () => {
  assert.equal(sameOrigin({ headers: { origin: 'https://radarjwc-pro.vercel.app', host: 'radarjwc-pro.vercel.app' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'https://malicioso.example', host: 'radarjwc-pro.vercel.app' } }), false);
  assert.equal(sameOrigin({ headers: { host: 'radarjwc-pro.vercel.app' } }), true);
});
