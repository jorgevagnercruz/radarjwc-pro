class FootballDataError extends Error {
  constructor(message, { status = 502, retryAfter = null } = {}) {
    super(message);
    this.name = 'FootballDataError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = status === 429 ? 'FOOTBALL_DATA_RATE_LIMIT' : 'FOOTBALL_DATA_ERROR';
  }
}

const PROVIDER_LOCK_KEY = 'radar:football-data:global';
const MIN_REQUEST_INTERVAL_MS = 7000;

function retryAfterSeconds(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Math.max(1, Number(text));
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - now) / 1000)) : null;
}

async function fetchFootballData(url, options = {}) {
  const token = options.token || process.env.FOOTBALL_DATA_TOKEN;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 12000;

  if (!token) {
    throw new FootballDataError('FOOTBALL_DATA_TOKEN não configurado.', { status: 500 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetchImpl(url, {
      headers: { 'X-Auth-Token': token },
      signal: controller.signal
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    throw new FootballDataError(
      timedOut ? 'A consulta ao football-data.org demorou além do limite.' : 'Não foi possível consultar o football-data.org.',
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }

  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    body = {};
  }

  if (response.ok) return body;

  const retryAfter = retryAfterSeconds(response.headers?.get?.('retry-after'));
  if (response.status === 429) {
    const wait = retryAfter || 60;
    console.warn('[football-data] rate limit', {
      path: new URL(String(url)).pathname,
      retryAfter: wait
    });
    throw new FootballDataError(
      `O football-data.org atingiu o limite temporário. Nova tentativa em cerca de ${wait} segundos.`,
      { status: 429, retryAfter: wait }
    );
  }

  throw new FootballDataError(
    body?.message || body?.error || `football-data.org HTTP ${response.status}`,
    { status: response.status }
  );
}

async function lockFootballDataProvider(client) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [PROVIDER_LOCK_KEY]
  );
}

async function reserveFootballDataSlot(client, options = {}) {
  const minIntervalMs = options.minIntervalMs || MIN_REQUEST_INTERVAL_MS;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());
  const result = await client.query(`
    SELECT MAX((raw_data->>'football_data_last_request_at')::timestamptz) AS requested_at
      FROM fixtures
     WHERE raw_data ? 'football_data_last_request_at'
  `);
  const lastRequest = Date.parse(result.rows[0]?.requested_at || '') || 0;
  const waitMs = Math.max(0, minIntervalMs - (now() - lastRequest));
  if (waitMs) await sleep(waitMs);

  const requestedAt = new Date(now()).toISOString();
  await client.query(`
    UPDATE fixtures
       SET raw_data=COALESCE(raw_data,'{}'::jsonb)||jsonb_build_object('football_data_last_request_at',$1::text)
     WHERE id=(SELECT id FROM fixtures WHERE source='football-data.org' ORDER BY updated_at DESC LIMIT 1)
  `, [requestedAt]);
  return { requestedAt, waitedMs: waitMs };
}

module.exports = {
  FootballDataError,
  retryAfterSeconds,
  fetchFootballData,
  lockFootballDataProvider,
  reserveFootballDataSlot,
  MIN_REQUEST_INTERVAL_MS
};
