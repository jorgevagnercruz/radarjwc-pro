const { requireUser, pool } = require('../lib/auth');
const {
  fetchFootballData,
  lockFootballDataProvider,
  reserveFootballDataSlot
} = require('../lib/football-data');

const TZ = 'America/Sao_Paulo';
const CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_SECONDS = 60;
const memoryCache = globalThis.__radarScannerCache || new Map();
globalThis.__radarScannerCache = memoryCache;
let providerBackoffUntil = globalThis.__radarFootballDataBackoff || 0;

function avg2(a, b) {
  const vals = [a, b].filter(v => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
}
const pct = (a, b) => Math.round(avg2(a ?? 0, b ?? 0) * 100);
const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
const num = value => value == null ? null : Number(value);

function jwcScore(m) {
  const avgGoalScore = Math.min((m.avgGoals / 3) * 100, 100);
  return Math.round(
    m.ht.pct * 0.20 +
    m.o15.pct * 0.35 +
    m.o25.pct * 0.20 +
    m.btts.pct * 0.10 +
    m.sh15.pct * 0.10 +
    avgGoalScore * 0.05
  );
}

function statusFor(score) {
  if (score >= 65) return 'A';
  if (score >= 55) return 'B+';
  return 'CAUTELA';
}

function mapTrends(body) {
  const raw = Array.isArray(body?.trends) ? body.trends : [];
  return raw.map(t => {
    const h = t.trend?.home || {};
    const a = t.trend?.away || {};
    const homeN = Array.isArray(h.match_ids) ? h.match_ids.length : 10;
    const awayN = Array.isArray(a.match_ids) ? a.match_ids.length : 10;
    const sample = homeN + awayN;

    const metrics = {
      sample,
      homeSample: homeN,
      awaySample: awayN,
      ht: { pct: pct(h.pct_1st_hf_o_05, a.pct_1st_hf_o_05) },
      o15: { pct: pct(h.pct_o_15, a.pct_o_15) },
      o25: { pct: pct(h.pct_o_25, a.pct_o_25) },
      btts: { pct: pct(h.pct_bts, a.pct_bts) },
      sh15: { pct: pct(h.pct_2nd_hf_o_15, a.pct_2nd_hf_o_15) },
      avgGoals: r1(avg2(h.avg_goals, a.avg_goals))
    };
    for (const key of ['ht', 'o15', 'o25', 'btts', 'sh15']) {
      metrics[key].hits = Math.round(metrics[key].pct / 100 * sample);
    }

    const jwc = jwcScore(metrics);
    return {
      id: t.id,
      source: 'football-data.org',
      league: t.competition?.name || 'Competição',
      leagueCode: t.competition?.code || '',
      home: t.homeTeam?.name || 'Mandante',
      away: t.awayTeam?.name || 'Visitante',
      starting_at: t.utcDate,
      jwc,
      bingo: Math.round(Math.sqrt(metrics.ht.pct * metrics.sh15.pct)),
      status: statusFor(jwc),
      forms: { home: h.form || '', away: a.form || '' },
      teamAverages: {
        home: { scored: r1(h.avg_goals_scored), conceded: r1(h.avg_goals_conceded), points: r1(h.avg_points) },
        away: { scored: r1(a.avg_goals_scored), conceded: r1(a.avg_goals_conceded), points: r1(a.avg_points) }
      },
      metrics
    };
  }).sort((x, y) => y.jwc - x.jwc);
}

function cacheAge(cachedAt) {
  const time = Date.parse(cachedAt || '');
  return Number.isFinite(time) ? Math.max(0, Date.now() - time) : Infinity;
}

function isFresh(cache) {
  return Boolean(cache?.games && cache.cachedAt && cacheAge(cache.cachedAt) < CACHE_TTL_MS);
}

function remember(date, games, cachedAt) {
  memoryCache.set(date, { games, cachedAt, source: 'memory' });
}

function readMemory(date) {
  const cached = memoryCache.get(date);
  return isFresh(cached) ? cached : null;
}

async function loadFullCache(client, date) {
  const result = await client.query(`
    WITH cached AS (
      SELECT raw_data->'scanner_payload' AS payload,
             raw_data->>'scanner_cached_at' AS cached_at
        FROM fixtures
       WHERE source='football-data.org'
         AND raw_data->>'scanner_date'=$1
         AND jsonb_typeof(raw_data->'scanner_payload')='object'
    ), latest AS (
      SELECT MAX(cached_at) AS cached_at FROM cached
    )
    SELECT payload,cached_at
      FROM cached
     WHERE cached_at=(SELECT cached_at FROM latest)
     ORDER BY payload->>'starting_at',payload->>'id'
  `, [date]);
  return {
    games: result.rows.map(row => row.payload).filter(Boolean).sort((a, b) => b.jwc - a.jwc),
    cachedAt: result.rows[0]?.cached_at || null,
    source: 'neon-full'
  };
}

function rateMetric(value, sample) {
  const rate = num(value);
  if (!Number.isFinite(rate)) return { pct: null, hits: null };
  const percent = Math.round(rate * 100);
  return { pct: percent, hits: Math.round(percent / 100 * sample) };
}

async function loadLegacyCache(client, date) {
  const result = await client.query(`
    SELECT DISTINCT ON (f.id)
           f.id,f.starting_at,f.raw_data,pm.sample_size,pm.home_sample_size,
           pm.away_sample_size,pm.over05_ht_rate,pm.over15_ft_rate,
           pm.over25_ft_rate,pm.btts_rate,pm.avg_total_goals,
           pm.home_avg_scored,pm.home_avg_conceded,pm.away_avg_scored,
           pm.away_avg_conceded,pm.jwc_prematch_score,pm.computed_at
      FROM fixtures f
      JOIN prematch_metrics pm ON pm.fixture_id=f.id
     WHERE f.source='football-data.org'
       AND (f.starting_at AT TIME ZONE '${TZ}')::date=$1::date
       AND pm.score_version LIKE 'jwc-prematch-%'
     ORDER BY f.id,pm.computed_at DESC
  `, [date]);

  const games = result.rows.map(row => {
    const sample = Number(row.sample_size || 0);
    const jwc = Number(row.jwc_prematch_score || 0);
    return {
      id: row.id,
      source: 'football-data.org',
      league: row.raw_data?.league || 'Competição',
      leagueCode: row.raw_data?.leagueCode || '',
      home: row.raw_data?.home || 'Mandante',
      away: row.raw_data?.away || 'Visitante',
      starting_at: row.starting_at,
      jwc,
      bingo: null,
      status: statusFor(jwc),
      forms: { home: '', away: '' },
      teamAverages: {
        home: { scored: num(row.home_avg_scored), conceded: num(row.home_avg_conceded), points: null },
        away: { scored: num(row.away_avg_scored), conceded: num(row.away_avg_conceded), points: null }
      },
      metrics: {
        sample,
        homeSample: Number(row.home_sample_size || 0),
        awaySample: Number(row.away_sample_size || 0),
        ht: rateMetric(row.over05_ht_rate, sample),
        o15: rateMetric(row.over15_ft_rate, sample),
        o25: rateMetric(row.over25_ft_rate, sample),
        btts: rateMetric(row.btts_rate, sample),
        sh15: { pct: null, hits: null },
        avgGoals: num(row.avg_total_goals)
      }
    };
  }).sort((a, b) => b.jwc - a.jwc);

  const timestamps = result.rows.map(row => Date.parse(row.computed_at)).filter(Number.isFinite);
  return {
    games,
    cachedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    source: 'neon-legacy'
  };
}

async function loadFallback(client, date) {
  const full = await loadFullCache(client, date);
  return full.games.length ? full : loadLegacyCache(client, date);
}

async function providerBackoff(client) {
  const result = await client.query(`
    SELECT MAX((raw_data->>'football_data_retry_at')::timestamptz) AS retry_at
      FROM fixtures
     WHERE raw_data ? 'football_data_retry_at'
  `);
  const stored = Date.parse(result.rows[0]?.retry_at || '');
  return Math.max(providerBackoffUntil, Number.isFinite(stored) ? stored : 0);
}

async function saveProviderBackoff(client, retryAfter) {
  const seconds = Math.min(Math.max(Number(retryAfter) || DEFAULT_RETRY_SECONDS, 30), 15 * 60);
  providerBackoffUntil = Date.now() + seconds * 1000;
  globalThis.__radarFootballDataBackoff = providerBackoffUntil;
  const retryAt = new Date(providerBackoffUntil).toISOString();
  await client.query(`
    UPDATE fixtures
       SET raw_data=COALESCE(raw_data,'{}'::jsonb)||jsonb_build_object('football_data_retry_at',$1::text)
     WHERE id=(SELECT id FROM fixtures WHERE source='football-data.org' ORDER BY updated_at DESC LIMIT 1)
  `, [retryAt]);
  return retryAt;
}

async function persist(client, games, date, cachedAt) {
  for (const game of games) {
    await client.query(`
      INSERT INTO fixtures(id,source,league_id,starting_at,status,raw_data)
      VALUES($1,'football-data.org',NULL,$2,'SCHEDULED',$3)
      ON CONFLICT (id) DO UPDATE SET
        source=EXCLUDED.source,
        starting_at=EXCLUDED.starting_at,
        raw_data=COALESCE(fixtures.raw_data,'{}'::jsonb)||EXCLUDED.raw_data,
        updated_at=NOW()
    `, [game.id, game.starting_at, JSON.stringify({
      league: game.league,
      leagueCode: game.leagueCode,
      home: game.home,
      away: game.away,
      scanner_date: date,
      scanner_cached_at: cachedAt,
      scanner_payload: game
    })]);

    await client.query(`
      INSERT INTO prematch_metrics(
        fixture_id,sample_size,home_sample_size,away_sample_size,
        over05_ht_rate,over15_ft_rate,over25_ft_rate,btts_rate,
        avg_total_goals,home_avg_scored,home_avg_conceded,
        away_avg_scored,away_avg_conceded,jwc_prematch_score,score_version
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'jwc-prematch-v0.9.1')
      ON CONFLICT (fixture_id,score_version) DO NOTHING
    `, [
      game.id, game.metrics.sample, game.metrics.homeSample, game.metrics.awaySample,
      game.metrics.ht.pct / 100, game.metrics.o15.pct / 100, game.metrics.o25.pct / 100,
      game.metrics.btts.pct / 100, game.metrics.avgGoals,
      game.teamAverages.home.scored, game.teamAverages.home.conceded,
      game.teamAverages.away.scored, game.teamAverages.away.conceded, game.jwc
    ]);
  }
}

function sendGames(res, { date, games, status, source, cachedAt, warning = '', retryAfter = null }) {
  const age = cacheAge(cachedAt);
  res.setHeader('X-Radar-Cache', status);
  res.setHeader('X-Radar-Version', '2.1.5');
  console.info('[scanner] response', { date, cache: status, source, count: games.length });
  return res.status(200).json({
    ok: true,
    version: '2.1.5',
    date,
    count: games.length,
    analyzed: games.length,
    games,
    cache: {
      status,
      source,
      cachedAt: cachedAt || null,
      ageSeconds: Number.isFinite(age) ? Math.round(age / 1000) : null,
      retryAfter
    },
    warning: warning || null,
    note: 'Percentuais são frequências históricas observadas no Trend Resource; window=10 e consider_side ativado. O Índice JWC é um ranking de 0 a 100, não uma probabilidade.'
  });
}

function upstreamUrl(date) {
  const url = new URL('https://api.football-data.org/v4/trends/');
  url.searchParams.set('date', date);
  url.searchParams.set('window', '10');
  url.searchParams.append('consider_side', '');
  return url;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const user = await requireUser(req, res);
  if (!user) return;

  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'Data inválida. Use YYYY-MM-DD.' });
  }
  if (!pool) {
    return res.status(500).json({ ok: false, error: 'DATABASE_URL não configurada.' });
  }

  const inMemory = readMemory(date);
  if (inMemory) {
    return sendGames(res, { date, ...inMemory, status: 'HIT' });
  }

  const client = await pool.connect();
  let transactionOpen = false;
  let fallback = { games: [], cachedAt: null, source: 'none' };

  try {
    const stored = await loadFullCache(client, date);
    if (isFresh(stored)) {
      remember(date, stored.games, stored.cachedAt);
      return sendGames(res, { date, ...stored, status: 'HIT' });
    }

    fallback = stored.games.length ? stored : await loadLegacyCache(client, date);
    let blockedUntil = await providerBackoff(client);
    if (blockedUntil > Date.now()) {
      const retryAfter = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
      if (fallback.games.length) {
        return sendGames(res, {
          date,
          ...fallback,
          status: 'STALE',
          retryAfter,
          warning: 'A fonte externa está temporariamente limitada. O Radar exibiu os últimos dados salvos no Neon.'
        });
      }
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(503).json({
        ok: false,
        code: 'DATA_PROVIDER_BUSY',
        error: `A fonte de dados está temporariamente limitada. Tente novamente em cerca de ${retryAfter} segundos.`
      });
    }

    await client.query('BEGIN');
    transactionOpen = true;
    await lockFootballDataProvider(client);

    const afterLock = await loadFullCache(client, date);
    if (isFresh(afterLock)) {
      await client.query('COMMIT');
      transactionOpen = false;
      remember(date, afterLock.games, afterLock.cachedAt);
      return sendGames(res, { date, ...afterLock, status: 'HIT' });
    }

    blockedUntil = await providerBackoff(client);
    if (blockedUntil > Date.now()) {
      await client.query('COMMIT');
      transactionOpen = false;
      const retryAfter = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
      if (fallback.games.length) {
        return sendGames(res, {
          date,
          ...fallback,
          status: 'STALE',
          retryAfter,
          warning: 'A fonte externa está temporariamente limitada. O Radar exibiu os últimos dados salvos no Neon.'
        });
      }
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(503).json({ ok: false, code: 'DATA_PROVIDER_BUSY', error: 'A fonte de dados está temporariamente limitada.' });
    }

    const slot = await reserveFootballDataSlot(client);
    if (slot.waitedMs) {
      console.info('[scanner] provider slot waited', { date, waitedMs: slot.waitedMs });
    }
    const body = await fetchFootballData(upstreamUrl(date));
    const games = mapTrends(body);
    const cachedAt = new Date().toISOString();

    try {
      await persist(client, games, date, cachedAt);
      await client.query('COMMIT');
      transactionOpen = false;
    } catch (databaseError) {
      await client.query('ROLLBACK').catch(() => {});
      transactionOpen = false;
      console.error('[scanner] cache persist failed', { message: databaseError.message, date });
    }

    providerBackoffUntil = 0;
    globalThis.__radarFootballDataBackoff = 0;
    remember(date, games, cachedAt);
    return sendGames(res, { date, games, cachedAt, source: 'football-data.org', status: 'MISS' });
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
      transactionOpen = false;
    }

    if (error.status === 429) {
      await saveProviderBackoff(client, error.retryAfter).catch(backoffError => {
        console.error('[scanner] backoff persist failed', { message: backoffError.message });
      });
    }

    if (!fallback.games.length) {
      fallback = await loadFallback(client, date).catch(() => fallback);
    }
    if (fallback.games.length && (error.status === 429 || error.status >= 500)) {
      return sendGames(res, {
        date,
        ...fallback,
        status: 'STALE',
        retryAfter: error.retryAfter || null,
        warning: fallback.source === 'neon-legacy'
          ? 'A fonte externa atingiu o limite. O Radar usou as métricas já salvas no Neon; Bingo e o indicador de 2º tempo serão completados na próxima atualização.'
          : 'A fonte externa atingiu o limite. O Radar exibiu a última análise completa salva no Neon.'
      });
    }

    console.error('[scanner] request failed', {
      message: error.message,
      status: error.status || 500,
      date
    });
    if (error.status === 429) {
      const retryAfter = error.retryAfter || DEFAULT_RETRY_SECONDS;
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(503).json({
        ok: false,
        code: 'DATA_PROVIDER_BUSY',
        error: `A fonte de dados está temporariamente limitada. Tente novamente em cerca de ${retryAfter} segundos.`
      });
    }
    return res.status(error.status >= 400 && error.status < 500 ? error.status : 500).json({
      ok: false,
      error: error.message || 'Erro no Scanner.'
    });
  } finally {
    client.release();
  }
};

module.exports._test = { mapTrends, rateMetric, statusFor, isFresh };
