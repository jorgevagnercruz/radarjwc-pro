const test = require('node:test');
const assert = require('node:assert/strict');

const authPath = require.resolve('../lib/auth');
const handlerPath = require.resolve('../api/admin/users');

function response() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function loadHandler(target, onUpdate = () => {}) {
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT * FROM app_users')) return { rows: [target] };
      if (sql.includes('UPDATE app_users')) {
        onUpdate(params);
        return { rows: [{ ...target, status: 'APPROVED', access_until: params[1] }] };
      }
      return { rows: [] };
    }
  };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      pool,
      requireAdmin: async () => ({ id: 1, role: 'ADMIN' }),
      sameOrigin: () => true,
      bodyOf: req => req.body,
      publicUser: row => row,
      audit: async () => {}
    }
  };
  delete require.cache[handlerPath];
  return require('../api/admin/users');
}

test('renovação acrescenta dias ao período ainda ativo', async () => {
  const current = new Date(Date.now() + 10 * 86400000);
  let updatedUntil;
  const handler = loadHandler(
    { id: 2, role: 'USER', status: 'APPROVED', access_until: current },
    params => { updatedUntil = new Date(params[1]); }
  );
  const res = response();
  await handler({ method: 'PATCH', body: { userId: 2, action: 'renew', days: 30 } }, res);
  assert.equal(res.statusCode, 200);
  const addedDays = (updatedUntil - current) / 86400000;
  assert.ok(addedDays > 29.99 && addedDays < 30.01);
});

test('recusa vencimento personalizado inválido ou passado', async () => {
  let updated = false;
  const handler = loadHandler(
    { id: 2, role: 'USER', status: 'PENDING', access_until: null },
    () => { updated = true; }
  );
  const res = response();
  await handler({ method: 'PATCH', body: { userId: 2, action: 'renew', accessUntil: '2020-01-01' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(updated, false);
});
