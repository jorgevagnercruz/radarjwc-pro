const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchFootballData,
  retryAfterSeconds,
  lockFootballDataProvider,
  reserveFootballDataSlot
} = require('../lib/football-data');

test('interpreta Retry-After em segundos e data HTTP', () => {
  assert.equal(retryAfterSeconds('45'), 45);
  assert.equal(retryAfterSeconds(new Date(70000).toUTCString(), 10000), 60);
  assert.equal(retryAfterSeconds('inválido'), null);
});

test('transforma HTTP 429 em erro controlado com tempo de espera', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => '37' },
    json: async () => ({ message: 'Too many requests' })
  });

  await assert.rejects(
    fetchFootballData('https://api.football-data.org/v4/trends/', { token: 'teste', fetchImpl }),
    error => error.status === 429 && error.retryAfter === 37 && error.code === 'FOOTBALL_DATA_RATE_LIMIT'
  );
});

test('retorna o JSON quando o fornecedor responde com sucesso', async () => {
  const expected = { trends: [{ id: 1 }] };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => expected
  });
  assert.deepEqual(
    await fetchFootballData('https://api.football-data.org/v4/trends/', { token: 'teste', fetchImpl }),
    expected
  );
});

test('a fila usa uma trava global compartilhada por todas as datas', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('SELECT MAX')) {
        return { rows: [{ requested_at: new Date(3000).toISOString() }] };
      }
      return { rows: [] };
    }
  };

  await lockFootballDataProvider(client);
  const slot = await reserveFootballDataSlot(client, {
    minIntervalMs: 7000,
    now: () => 10000,
    sleep: async () => { throw new Error('não deveria aguardar'); }
  });

  assert.equal(slot.waitedMs, 0);
  assert.match(queries[0].sql, /pg_advisory_xact_lock/);
  assert.equal(queries[0].params[0], 'radar:football-data:global');
  assert.match(queries.at(-1).sql, /football_data_last_request_at/);
});

test('a fila aguarda o intervalo restante antes da próxima chamada', async () => {
  let waitedMs = 0;
  const client = {
    async query(sql) {
      if (String(sql).includes('SELECT MAX')) {
        return { rows: [{ requested_at: new Date(8000).toISOString() }] };
      }
      return { rows: [] };
    }
  };
  const slot = await reserveFootballDataSlot(client, {
    minIntervalMs: 7000,
    now: () => 10000,
    sleep: async ms => { waitedMs = ms; }
  });
  assert.equal(waitedMs, 5000);
  assert.equal(slot.waitedMs, 5000);
});
