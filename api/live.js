const { requireUser, pool } = require('../lib/auth');
const {
  apiFootballKey,
  pressureScore,
  dedupeGames,
  isStatsCandidate,
  mapApiFootballFixture,
  fetchSportmonksLive,
  fetchApiFootballFixtures,
  fetchApiFootballStatistics
} = require('../lib/live-radar');
const { isAuthorizedCron, cronConfigured } = require('../lib/cron-auth');
const { telegramConfigured } = require('../lib/telegram');
const { analyzeLiveGoalSignals, deliverGoalAlerts } = require('../lib/live-goal-signals');

const VERSION = '2.5.0';
const RESPONSE_CACHE_MS = 4 * 60 * 1000;
const STATS_FRESH_MS = 150 * 1000;
const STATS_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_STATS_CALLS = 6;
const CACHE_PROVIDER = 'live-radar-v2.5';
const CACHE_FIXTURE_ID = 0;
const LIVE_LOCK_ID = 1940260823;

function ageOf(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? Date.now() - time : Infinity;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRaw(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function readMemoryCache() {
  const cached = globalThis.__radarLiveCache25;
  if (!cached || ageOf(cached.cachedAt) >= RESPONSE_CACHE_MS) return null;
  return { ...cached.payload, cache: { status: 'HIT', source: 'memory', cachedAt: cached.cachedAt } };
}

function remember(payload, cachedAt) {
  globalThis.__radarLiveCache25 = { payload, cachedAt };
}

async function loadSharedCache(client) {
  const result = await client.query(`
    SELECT raw_data,computed_at
      FROM scanner_results
     WHERE provider=$1 AND fixture_id=$2
     LIMIT 1
  `, [CACHE_PROVIDER, CACHE_FIXTURE_ID]);
  const row = result.rows[0];
  const raw = parseRaw(row?.raw_data);
  const payload = raw?.live_cache;
  if (!payload) return null;
  return {
    payload,
    cachedAt: row.computed_at ? new Date(row.computed_at).toISOString() : payload.updatedAt,
    ageMs: ageOf(row.computed_at || payload.updatedAt)
  };
}

async function saveSharedCache(client, payload) {
  await client.query(`
    INSERT INTO scanner_results(
      provider,fixture_id,fixture_date,status,computed_at,raw_data
    ) VALUES(
      $1,$2,(NOW() AT TIME ZONE 'America/Sao_Paulo')::date,'CACHE',NOW(),$3
    )
    ON CONFLICT (provider,fixture_id) DO UPDATE SET
      fixture_date=EXCLUDED.fixture_date,
      status='CACHE',
      computed_at=NOW(),
      raw_data=EXCLUDED.raw_data
  `, [CACHE_PROVIDER, CACHE_FIXTURE_ID, JSON.stringify({ live_cache: payload })]);
}

function cachedTeamStats(row, side) {
  const prefix = `${side}_`;
  return {
    shots: numberOrNull(row[`${prefix}shots`]),
    sot: numberOrNull(row[`${prefix}shots_on_target`]),
    off: numberOrNull(row[`${prefix}shots_off_target`]),
    inside: numberOrNull(row[`${prefix}shots_inside_box`]),
    big: numberOrNull(row.raw_data?.[`${side}BigChances`]),
    xg: numberOrNull(row[`${prefix}xg`]),
    attacks: numberOrNull(row[`${prefix}attacks`]),
    danger: numberOrNull(row[`${prefix}dangerous_attacks`]),
    corners: numberOrNull(row[`${prefix}corners`]),
    possession: numberOrNull(row[`${prefix}possession`]),
    red: numberOrNull(row[`${prefix}red_cards`])
  };
}

async function loadApiFootballStatsCache(client, dbIds) {
  if (!dbIds.length) return new Map();
  const result = await client.query(`
    SELECT DISTINCT ON (fixture_id)
           fixture_id,captured_at,home_possession,away_possession,
           home_shots,away_shots,home_shots_on_target,away_shots_on_target,
           home_shots_off_target,away_shots_off_target,
           home_shots_inside_box,away_shots_inside_box,
           home_attacks,away_attacks,
           home_dangerous_attacks,away_dangerous_attacks,
           home_corners,away_corners,home_red_cards,away_red_cards,
           home_xg,away_xg,raw_data
      FROM fixture_snapshots
     WHERE fixture_id=ANY($1::bigint[])
       AND captured_at>NOW()-INTERVAL '10 minutes'
     ORDER BY fixture_id,captured_at DESC
  `, [dbIds]);
  const cache = new Map();
  for (const row of result.rows) {
    const raw = parseRaw(row.raw_data) || {};
    row.raw_data = raw;
    cache.set(Number(row.fixture_id), {
      capturedAt: new Date(row.captured_at).toISOString(),
      homeStats: cachedTeamStats(row, 'home'),
      awayStats: cachedTeamStats(row, 'away')
    });
  }
  return cache;
}

function applyNormalizedStats(game, cached, freshness) {
  if (!cached) return { ...game, statsFreshness: 'awaiting', statsUpdatedAt: null };
  const index = pressureScore(cached.homeStats, cached.awayStats, game.minute);
  return {
    ...game,
    homeStats: cached.homeStats,
    awayStats: cached.awayStats,
    ...index,
    statsFreshness: freshness,
    statsUpdatedAt: cached.capturedAt || new Date().toISOString()
  };
}

function safeProviderError(error) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return 'Chave recusada pelo fornecedor.';
  if (status === 429) return 'Limite temporário de consultas atingido.';
  if (status >= 500) return 'Fornecedor temporariamente indisponível.';
  return 'Não foi possível consultar o fornecedor.';
}

async function persistGame(client, game) {
  if (!Number.isFinite(game.dbId) || !Number.isFinite(game.pressure)) return;
  const raw = {
    live_payload: game,
    source: game.provider,
    external_id: game.externalId
  };
  await client.query(`
    INSERT INTO fixtures(
      id,source,league_id,starting_at,status,home_score,away_score,raw_data
    ) VALUES($1,$2,NULL,$3,'LIVE',$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET
      source=EXCLUDED.source,
      starting_at=EXCLUDED.starting_at,
      status='LIVE',
      home_score=EXCLUDED.home_score,
      away_score=EXCLUDED.away_score,
      raw_data=EXCLUDED.raw_data,
      updated_at=NOW()
  `, [
    game.dbId,
    game.provider,
    game.starting_at || new Date().toISOString(),
    game.score[0],
    game.score[1],
    JSON.stringify(raw)
  ]);

  await client.query(`
    INSERT INTO fixture_snapshots(
      fixture_id,minute,period,home_score,away_score,
      home_possession,away_possession,home_shots,away_shots,
      home_shots_on_target,away_shots_on_target,
      home_shots_off_target,away_shots_off_target,
      home_shots_inside_box,away_shots_inside_box,
      home_attacks,away_attacks,
      home_dangerous_attacks,away_dangerous_attacks,
      home_corners,away_corners,home_red_cards,away_red_cards,
      home_xg,away_xg,raw_data
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,$25,$26
    )
  `, [
    game.dbId,
    game.minute,
    game.period,
    game.score[0],
    game.score[1],
    game.homeStats.possession,
    game.awayStats.possession,
    game.homeStats.shots,
    game.awayStats.shots,
    game.homeStats.sot,
    game.awayStats.sot,
    game.homeStats.off,
    game.awayStats.off,
    game.homeStats.inside,
    game.awayStats.inside,
    game.homeStats.attacks,
    game.awayStats.attacks,
    game.homeStats.danger,
    game.awayStats.danger,
    game.homeStats.corners,
    game.awayStats.corners,
    game.homeStats.red,
    game.awayStats.red,
    game.homeStats.xg,
    game.awayStats.xg,
    JSON.stringify({
      pressure: game.pressure,
      statsCoverage: game.statsCoverage,
      signal: game.signal,
      source: game.provider,
      externalId: game.externalId,
      homeBigChances: game.homeStats.big,
      awayBigChances: game.awayStats.big
    })
  ]);
}

async function collectProviders(client) {
  const sportmonksToken = String(process.env.SPORTMONKS_TOKEN || '').trim();
  const footballKey = apiFootballKey();
  const providers = {
    sportmonks: {
      label: 'Sportmonks',
      configured: Boolean(sportmonksToken),
      state: sportmonksToken ? 'checking' : 'missing',
      live: 0,
      analyzed: 0
    },
    apiFootball: {
      label: 'API-Football',
      configured: Boolean(footballKey),
      state: footballKey ? 'checking' : 'missing',
      live: 0,
      analyzed: 0,
      hint: footballKey ? null : 'Cadastre a chave como API_FOOTBALL_KEY. FOOTBALL_DATA_TOKEN pertence a outro serviço.'
    }
  };

  const sportmonksPromise = sportmonksToken
    ? fetchSportmonksLive(sportmonksToken)
    : Promise.resolve([]);
  const apiFootballPromise = footballKey
    ? fetchApiFootballFixtures(footballKey)
    : Promise.resolve([]);
  const [sportResult, apiResult] = await Promise.allSettled([sportmonksPromise, apiFootballPromise]);

  let sportmonksGames = [];
  if (sportResult.status === 'fulfilled') {
    sportmonksGames = sportResult.value;
    providers.sportmonks.state = sportmonksToken ? 'ok' : 'missing';
    providers.sportmonks.live = sportmonksGames.length;
    providers.sportmonks.analyzed = sportmonksGames.filter(game => Number.isFinite(game.pressure)).length;
  } else {
    providers.sportmonks.state = 'error';
    providers.sportmonks.error = safeProviderError(sportResult.reason);
  }

  let apiFixtures = [];
  let statsCallLimit = MAX_STATS_CALLS;
  let warning = null;
  if (apiResult.status === 'fulfilled') {
    apiFixtures = apiResult.value;
    providers.apiFootball.state = footballKey ? 'ok' : 'missing';
    providers.apiFootball.live = apiFixtures.length;
    const rateLimit = apiFixtures.rateLimit || {};
    providers.apiFootball.rateLimit = {
      dailyLimit: numberOrNull(rateLimit.dailyLimit),
      dailyRemaining: numberOrNull(rateLimit.dailyRemaining),
      minuteLimit: numberOrNull(rateLimit.minuteLimit),
      minuteRemaining: numberOrNull(rateLimit.minuteRemaining)
    };
    if (providers.apiFootball.rateLimit.dailyLimit && providers.apiFootball.rateLimit.dailyLimit <= 200) {
      statsCallLimit = 1;
      warning = 'A chave da API-Football está em um plano de teste com limite baixo. Para monitoramento contínuo, será necessário um plano com mais consultas.';
    } else if (providers.apiFootball.rateLimit.dailyLimit && providers.apiFootball.rateLimit.dailyLimit < 50000) {
      statsCallLimit = 3;
    }
    if (providers.apiFootball.rateLimit.dailyRemaining !== null && providers.apiFootball.rateLimit.dailyRemaining <= 5) {
      statsCallLimit = 0;
      warning = 'A cota diária da API-Football está quase esgotada. O Radar preservou as últimas estatísticas salvas no Neon.';
    }
  } else {
    providers.apiFootball.state = 'error';
    providers.apiFootball.error = safeProviderError(apiResult.reason);
  }

  const candidates = apiFixtures.filter(isStatsCandidate);
  const dbIds = candidates.map(fixture => -Math.abs(Number(fixture.fixture.id)));
  const cachedStats = await loadApiFootballStatsCache(client, dbIds);
  const toRefresh = candidates
    .filter(fixture => {
      const cached = cachedStats.get(-Math.abs(Number(fixture.fixture.id)));
      return !cached || ageOf(cached.capturedAt) >= STATS_FRESH_MS;
    })
    .sort((a, b) => {
      const aCache = cachedStats.get(-Math.abs(Number(a.fixture.id)));
      const bCache = cachedStats.get(-Math.abs(Number(b.fixture.id)));
      if (!aCache && bCache) return -1;
      if (aCache && !bCache) return 1;
      const aPreferred = Number(a.fixture.status?.elapsed || 0) >= 55 ? 1 : 0;
      const bPreferred = Number(b.fixture.status?.elapsed || 0) >= 55 ? 1 : 0;
      return bPreferred - aPreferred || ageOf(bCache?.capturedAt) - ageOf(aCache?.capturedAt);
    })
    .slice(0, statsCallLimit);

  const freshStats = new Map();
  if (footballKey && providers.apiFootball.state === 'ok') {
    const statResults = await Promise.allSettled(toRefresh.map(async fixture => {
      const id = Number(fixture.fixture.id);
      const rows = await fetchApiFootballStatistics(footballKey, id);
      return { id, rows };
    }));
    for (const result of statResults) {
      if (result.status !== 'fulfilled') continue;
      freshStats.set(result.value.id, result.value.rows);
    }
  }

  const apiGames = apiFixtures.map(fixture => {
    const externalId = Number(fixture.fixture.id);
    const dbId = -Math.abs(externalId);
    const freshRows = freshStats.get(externalId);
    if (freshRows) {
      const mapped = mapApiFootballFixture(fixture, freshRows);
      return mapped ? { ...mapped, statsFreshness: 'fresh', statsUpdatedAt: new Date().toISOString() } : null;
    }
    const cached = cachedStats.get(dbId);
    const mapped = mapApiFootballFixture(fixture, []);
    if (!mapped) return null;
    if (cached && ageOf(cached.capturedAt) < STATS_MAX_AGE_MS) {
      return applyNormalizedStats(mapped, cached, ageOf(cached.capturedAt) < STATS_FRESH_MS ? 'fresh-cache' : 'stale-cache');
    }
    return { ...mapped, statsFreshness: 'awaiting', statsUpdatedAt: null };
  }).filter(Boolean);

  providers.apiFootball.analyzed = apiGames.filter(game => Number.isFinite(game.pressure)).length;
  providers.apiFootball.detailedThisCycle = freshStats.size;

  const freshApiGames = apiGames.filter(game => freshStats.has(game.externalId) && Number.isFinite(game.pressure));
  const gamesToPersist = [
    ...sportmonksGames.filter(game => Number.isFinite(game.pressure)),
    ...freshApiGames
  ];
  for (const game of gamesToPersist) {
    await persistGame(client, game);
  }

  return { games: dedupeGames([...sportmonksGames, ...apiGames]), providers, warning };
}

function makePayload(games, providers, warning = null, goalSignals = {}) {
  const analyzed = games.filter(game => Number.isFinite(game.pressure)).length;
  const monitoring = games.filter(game => Number.isFinite(game.pressure) && game.pressure >= 50).length;
  const strong = games.filter(game => Number.isFinite(game.pressure) && game.pressure >= 80).length;
  return {
    ok: true,
    version: VERSION,
    updatedAt: new Date().toISOString(),
    count: games.length,
    coverage: {
      live: games.length,
      analyzed,
      monitoring,
      strong,
      goalWatching: Number(goalSignals.watching || 0),
      goalConfirmed: Number(goalSignals.confirmed || 0)
    },
    providers,
    games,
    goalSignals,
    warning,
    note: 'Pressão JWC ao vivo é um índice heurístico em validação, não probabilidade nem garantia de gol.'
  };
}

async function refreshLiveData() {
  if (!pool) {
    return {
      ok: false,
      version: VERSION,
      error: 'DATABASE_URL não configurada.'
    };
  }

  const client = await pool.connect();
  let transactionOpen = false;
  let fallback = null;
  try {
    fallback = await loadSharedCache(client);
    if (fallback && fallback.ageMs < RESPONSE_CACHE_MS) {
      remember(fallback.payload, fallback.cachedAt);
      return { ...fallback.payload, cache: { status: 'HIT', source: 'neon', cachedAt: fallback.cachedAt } };
    }

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [LIVE_LOCK_ID]);

    const afterLock = await loadSharedCache(client);
    if (afterLock && afterLock.ageMs < RESPONSE_CACHE_MS) {
      await client.query('COMMIT');
      transactionOpen = false;
      remember(afterLock.payload, afterLock.cachedAt);
      return { ...afterLock.payload, cache: { status: 'HIT', source: 'neon', cachedAt: afterLock.cachedAt } };
    }

    const result = await collectProviders(client);
    const goalAnalysis = await analyzeLiveGoalSignals(client, result.games);
    const payload = makePayload(goalAnalysis.games, result.providers, result.warning, goalAnalysis.summary);
    await saveSharedCache(client, payload);
    await client.query('COMMIT');
    transactionOpen = false;
    const delivery = await deliverGoalAlerts(pool, goalAnalysis.alerts);
    payload.goalSignals = { ...payload.goalSignals, delivery };
    remember(payload, payload.updatedAt);
    return { ...payload, cache: { status: 'MISS', source: 'providers', cachedAt: payload.updatedAt } };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    console.error('[live] refresh failed', { message: error.message, status: error.status || 500 });
    if (fallback && fallback.ageMs < STATS_MAX_AGE_MS) {
      const payload = {
        ...fallback.payload,
        warning: 'As fontes ao vivo oscilaram. Exibindo a última leitura salva no Neon.'
      };
      remember(payload, fallback.cachedAt);
      return { ...payload, cache: { status: 'STALE', source: 'neon', cachedAt: fallback.cachedAt } };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function liveData() {
  const memory = readMemoryCache();
  if (memory) return memory;
  if (globalThis.__radarLiveInFlight25) return globalThis.__radarLiveInFlight25;
  const promise = refreshLiveData();
  globalThis.__radarLiveInFlight25 = promise;
  try {
    return await promise;
  } finally {
    if (globalThis.__radarLiveInFlight25 === promise) {
      globalThis.__radarLiveInFlight25 = null;
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }
  const cronRequest = isAuthorizedCron(req);
  if (!cronRequest) {
    const user = await requireUser(req, res);
    if (!user) return;
  }
  try {
    const payload = await liveData();
    return res.status(payload.ok ? 200 : 500).json({
      ...payload,
      automation: {
        trigger: cronRequest ? 'scheduler' : 'user',
        cronConfigured: cronConfigured(),
        telegramConfigured: telegramConfigured()
      }
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      version: VERSION,
      error: 'Não foi possível atualizar o Radar ao vivo agora.'
    });
  }
};

module.exports._private = {
  ageOf,
  applyNormalizedStats,
  makePayload
};
