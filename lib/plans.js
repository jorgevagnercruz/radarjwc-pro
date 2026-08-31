const PLANS = Object.freeze({
  MONTHLY: Object.freeze({
    code: 'MONTHLY',
    name: 'Plano mensal',
    durationDays: 30,
    amountCents: 1500
  }),
  ANNUAL: Object.freeze({
    code: 'ANNUAL',
    name: 'Plano anual',
    durationDays: 365,
    amountCents: 10000
  })
});

const PIX = Object.freeze({
  type: 'E-mail',
  key: 'radarjwcpro@gmail.com',
  beneficiary: 'Jorge Vagner Vieira da Cruz',
  merchantName: 'JORGE VAGNER V DA CRUZ',
  city: 'BRASILIA'
});

function getPlan(value) {
  return PLANS[String(value || '').trim().toUpperCase()] || null;
}

function publicCommercialConfig() {
  return {
    plans: Object.values(PLANS).map(plan => ({ ...plan })),
    pix: { ...PIX }
  };
}

module.exports = { PLANS, PIX, getPlan, publicCommercialConfig };
