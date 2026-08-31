const test = require('node:test');
const assert = require('node:assert/strict');

const dbPath = require.resolve('../lib/db');
const authPath = require.resolve('../lib/auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function loadAuth(user) {
  const pool = { query: async () => ({ rows: user ? [user] : [] }) };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { createPool: () => pool }
  };
  delete require.cache[authPath];
  return require('../lib/auth');
}

test('acesso vencido entra na conta, mas não nas APIs do Radar', async () => {
  const auth = loadAuth({
    id: 2,
    role: 'USER',
    status: 'APPROVED',
    access_until: new Date(Date.now() - 86400000),
    session_id: 10
  });
  const req = { headers: { cookie: 'radar_session=token' } };
  const blocked = response();
  assert.equal(await auth.requireUser(req, blocked), null);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.code, 'EXPIRED');
  assert.equal((await auth.requireAccountUser(req, response())).id, 2);
});

test('cadastro pendente pode acompanhar e reenviar comprovante', async () => {
  const auth = loadAuth({ id: 3, role: 'USER', status: 'PENDING', access_until: null, session_id: 11 });
  const req = { headers: { cookie: 'radar_session=token' } };
  assert.equal((await auth.requireAccountUser(req, response())).id, 3);
});
