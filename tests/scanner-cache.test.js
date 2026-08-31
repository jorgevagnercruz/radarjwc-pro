const test = require('node:test');
const assert = require('node:assert/strict');

const authPath = require.resolve('../lib/auth');
const footballPath = require.resolve('../lib/football-data');
const scannerPath = require.resolve('../api/scanner');

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

function legacyRow() {
  return {
    id: 99,
    starting_at: new Date('2026-08-19T19:00:00Z'),
    raw_data: { league: 'Liga', home: 'Casa', away: 'Fora' },
    sample_size: 20,
    home_sample_size: 10,
    away_sample_size: 10,
    over05_ht_rate: '0.65',
    over15_ft_rate: '0.85',
    over25_ft_rate: '0.55',
    btts_rate: '0.50',
    avg_total_goals: '2.5',
    home_avg_scored: '1.5',
    home_avg_conceded: '1.0',
    away_avg_scored: '1.2',
    away_avg_conceded: '1.1',
    jwc_prematch_score: '70',
    computed_at: new Date('2026-08-19T12:00:00Z')
  };
}

function loadHandler({ fullRows = [], legacyRows = [], providerError = null }) {
  let providerCalls = 0;
  const client = {
    async query(sql) {
      const text = String(sql);
      if (text.includes('WITH cached AS')) return { rows: fullRows };
      if (text.includes('DISTINCT ON (f.id)')) return { rows: legacyRows };
      if (text.includes("MAX((raw_data->>'football_data_retry_at')")) return { rows: [{ retry_at: null }] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = { connect: async () => client };

  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: { pool, requireUser: async () => ({ id: 1 }) }
  };
  require.cache[footballPath] = {
    id: footballPath,
    filename: footballPath,
    loaded: true,
    exports: {
      lockFootballDataProvider: async () => {},
      reserveFootballDataSlot: async () => ({ waitedMs: 0 }),
      fetchFootballData: async () => {
        providerCalls++;
        if (providerError) throw providerError;
        return { trends: [] };
      }
    }
  };
  globalThis.__radarScannerCache = new Map();
  globalThis.__radarFootballDataBackoff = 0;
  delete require.cache[scannerPath];
  return { handler: require('../api/scanner'), providerCalls: () => providerCalls };
}

test('cache completo e recente evita nova chamada ao fornecedor', async () => {
  const game = { id: 7, jwc: 72, metrics: {} };
  const loaded = loadHandler({
    fullRows: [{ payload: game, cached_at: new Date().toISOString() }]
  });
  const res = response();
  await loaded.handler({ query: { date: '2026-08-19' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cache.status, 'HIT');
  assert.equal(res.body.games[0].id, 7);
  assert.equal(loaded.providerCalls(), 0);
});

test('HTTP 429 devolve métricas salvas no Neon em vez de falhar', async () => {
  const error = Object.assign(new Error('limite'), { status: 429, retryAfter: 60 });
  const loaded = loadHandler({ legacyRows: [legacyRow()], providerError: error });
  const res = response();
  await loaded.handler({ query: { date: '2026-08-19' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.cache.status, 'STALE');
  assert.equal(res.body.cache.source, 'neon-legacy');
  assert.equal(res.body.games[0].metrics.o15.pct, 85);
  assert.match(res.body.warning, /métricas já salvas no Neon/);
  assert.equal(loaded.providerCalls(), 1);
});
