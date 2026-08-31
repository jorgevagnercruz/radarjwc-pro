const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authPath = require.resolve('../lib/auth');
const footballPath = require.resolve('../lib/football-data');
const performancePath = require.resolve('../api/performance');

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function row(index) {
  const lowScore = index < 5;
  return {
    id: index + 1,
    starting_at: new Date(`2026-08-${String(index + 1).padStart(2, '0')}T18:00:00Z`),
    home_score: lowScore ? 1 : 2,
    away_score: 0,
    ht_home_score: 1,
    ht_away_score: 0,
    over05_ht_rate: '0.70',
    over15_ft_rate: '0.85',
    over25_ft_rate: '0.50',
    btts_rate: '0.40',
    computed_at: new Date('2026-08-01T12:00:00Z')
  };
}

function loadPublicHandler(rows) {
  let sqlSeen = '';
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      pool: { async query(sql) { sqlSeen = String(sql); return { rows }; } },
      requireUser: async () => { throw new Error('a rota pública não deve exigir login'); }
    }
  };
  require.cache[footballPath] = {
    id: footballPath,
    filename: footballPath,
    loaded: true,
    exports: {
      fetchFootballData: async () => ({}),
      lockFootballDataProvider: async () => {},
      reserveFootballDataSlot: async () => ({ waitedMs: 0 })
    }
  };
  delete require.cache[performancePath];
  return { handler: require('../api/performance'), sql: () => sqlSeen };
}

test('resumo público usa somente registros anteriores ao jogo e exige amostra mínima', async () => {
  const loaded = loadPublicHandler(Array.from({ length: 15 }, (_, index) => row(index)));
  const res = response();
  await loaded.handler({ method: 'GET', query: { public: '1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.status, 'PUBLISHED');
  assert.equal(res.body.results.signals, 30);
  assert.equal(res.body.results.hits, 25);
  assert.equal(res.body.results.accuracy, 83.3);
  assert.equal(res.body.commercial.plans.find(plan => plan.code === 'ANNUAL').amountCents, 10000);
  assert.equal(res.body.commercial.pix.key, 'radarjwcpro@gmail.com');
  assert.match(loaded.sql(), /pm\.computed_at<f\.starting_at/);
  assert.match(res.headers['Cache-Control'], /s-maxage/);
  assert.doesNotMatch(JSON.stringify(res.body), /home_score|away_score|password|email/i);
});

test('a página não publica percentual durante a formação da amostra', async () => {
  const pending = [row(0), row(1)].map(item => ({ ...item, home_score: null, away_score: null, ht_home_score: null, ht_away_score: null }));
  const loaded = loadPublicHandler(pending);
  const res = response();
  await loaded.handler({ method: 'GET', query: { public: '1' } }, res);

  assert.equal(res.body.results.status, 'COLLECTING');
  assert.equal(res.body.results.publishable, false);
  assert.equal(res.body.results.accuracy, null);
  assert.equal(res.body.results.pendingGames, 2);
});

test('apresentação mostra planos, Pix, avisos e cadastro pré-selecionado', () => {
  const root = path.join(__dirname, '..');
  const landing = fs.readFileSync(path.join(root, 'apresentacao.html'), 'utf8');
  const login = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
  assert.match(landing, /R\$ 15/);
  assert.match(landing, /R\$ 100/);
  assert.match(landing, /radarjwcpro@gmail\.com/);
  assert.match(landing, /Jorge Vagner Vieira da Cruz/);
  assert.match(landing, /performance\?public=1/);
  assert.match(landing, /não garante resultado futuro/i);
  assert.match(landing, /plan=MONTHLY/);
  assert.match(landing, /plan=ANNUAL/);
  assert.match(login, /requestedPlan/);
});
