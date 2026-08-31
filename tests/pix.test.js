const test = require('node:test');
const assert = require('node:assert/strict');

const { PIX, PLANS } = require('../lib/plans');
const { createPixPayload, validatePixPayload } = require('../lib/pix');

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function payloadFor(plan) {
  return createPixPayload({
    key: PIX.key,
    amountCents: plan.amountCents,
    merchantName: PIX.merchantName,
    city: PIX.city
  });
}

test('Pix mensal e anual possuem chave, valor e CRC válidos', () => {
  const monthly = payloadFor(PLANS.MONTHLY);
  const annual = payloadFor(PLANS.ANNUAL);

  assert.equal(validatePixPayload(monthly), true);
  assert.equal(validatePixPayload(annual), true);
  assert.match(monthly, /0121radarjwcpro@gmail\.com/);
  assert.match(monthly, /540515\.00/);
  assert.match(annual, /5406100\.00/);
  assert.notEqual(monthly, annual);
});

test('configuração pública gera QR SVG sem exigir sessão', async () => {
  const handler = require('../api/payments');
  const res = response();
  await handler({ method: 'GET', query: { config: '1' }, url: '/api/payments?config=1' }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.pix.key, PIX.key);
  assert.deepEqual(res.body.plans.map(plan => [plan.code, plan.amountCents]), [
    ['MONTHLY', 1500],
    ['ANNUAL', 10000]
  ]);
  for (const plan of res.body.plans) {
    assert.equal(validatePixPayload(plan.pix.payload), true);
    assert.match(plan.pix.qrSvg, /^<svg[^>]+>/);
    assert.match(plan.pix.qrSvg, /<path/);
  }
});
