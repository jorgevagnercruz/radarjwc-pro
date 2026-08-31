const test = require('node:test');
const assert = require('node:assert/strict');

const authPath = require.resolve('../lib/auth');
const registerPath = require.resolve('../api/auth/register');
const paymentsPath = require.resolve('../api/payments');

function response() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const receipt = {
  name: 'comprovante.pdf',
  data: Buffer.from('%PDF-1.7\nplano').toString('base64')
};

test('cadastro anual grava no comprovante o plano e o valor definidos pelo servidor', async () => {
  let paymentParams;
  let auditDetails;
  const client = {
    async query(sql, params) {
      const text = String(sql);
      if (text.includes('INSERT INTO app_users')) return { rows: [{ id: 17 }] };
      if (text.includes('INSERT INTO payment_receipts')) { paymentParams = params; return { rows: [] }; }
      if (text.includes('INSERT INTO auth_audit_log')) { auditDetails = JSON.parse(params[2]); return { rows: [] }; }
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async query() { return { rows: [{ total: 0 }] }; },
    async connect() { return client; }
  };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      pool,
      validateIdentity: (name, email) => ({ name, email }),
      hashPassword: async () => 'hash',
      bodyOf: req => req.body,
      sameOrigin: () => true,
      clientIp: () => '127.0.0.1'
    }
  };
  delete require.cache[registerPath];
  const handler = require('../api/auth/register');
  const res = response();
  await handler({ method: 'POST', body: { name: 'Pessoa', email: 'pessoa@example.com', password: 'SenhaForte1', plan: 'ANNUAL', amountCents: 1, receipt } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(paymentParams[1], 'ANNUAL');
  assert.equal(paymentParams[2], 10000);
  assert.equal(auditDetails.plan, 'ANNUAL');
  assert.equal(auditDetails.amountCents, 10000);
});

test('renovação mensal ignora valor enviado pelo navegador', async () => {
  let insertParams;
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (text.includes('COUNT(*) FILTER')) return { rows: [{ recent: 0, pending: 0, total: 0 }] };
      if (text.includes('INSERT INTO payment_receipts')) {
        insertParams = params;
        return { rows: [{
          id: 9,user_id: 4,plan_type: params[1],amount_cents: params[2],reference_label: params[3],
          original_filename: params[4],content_type: params[5],file_size: params[6],status: 'PENDING',created_at: new Date()
        }] };
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
      requireAccountUser: async () => ({ id: 4, role: 'USER' }),
      sameOrigin: () => true,
      bodyOf: req => req.body,
      audit: async () => {}
    }
  };
  delete require.cache[paymentsPath];
  const handler = require('../api/payments');
  const res = response();
  await handler({ method: 'POST', body: { plan: 'MONTHLY', amountCents: 1, receipt } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(insertParams[1], 'MONTHLY');
  assert.equal(insertParams[2], 1500);
  assert.equal(res.body.payment.amountCents, 1500);
});
