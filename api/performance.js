const { requireUser, pool } = require('../lib/auth');
const {
  fetchFootballData,
  lockFootballDataProvider,
  reserveFootballDataSlot
} = require('../lib/football-data');
const { publicCommercialConfig } = require('../lib/plans');

const TZ = 'America/Sao_Paulo';
const RESULT_SYNC_TTL_MS = 10 * 60 * 1000;
const PUBLIC_MINIMUM_SIGNALS = 30;
const n = value => Number(value ?? 0);
const rate = (hits, total) => total ? Math.round(hits * 1000 / total) / 10 : null;

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nextDate(value) {
  const d = new Date(value + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function picks(row) {
  const selected = [];
  if (n(row.over15_ft_rate) >= 0.80) selected.push({ key: 'o15', label: '+1.5 FT', rate: n(row.over15_ft_rate) });
  if (n(row.over05_ht_rate) >= 0.60) selected.push({ key: 'ht', label: 'Gol HT', rate: n(row.over05_ht_rate) });
  if (n(row.over25_ft_rate) >= 0.65) selected.push({ key: 'o25', label: '+2.5 FT', rate: n(row.over25_ft_rate) });
  if (n(row.btts_rate) >= 0.65) selected.push({ key: 'btts', label: 'Ambas marcam', rate: n(row.btts_rate) });
  return selected;
}

function evaluate(row, key) {
  if (key === 'ht') {
    if (row.ht_home_score == null || row.ht_away_score == null) return null;
    return n(row.ht_home_score) + n(row.ht_away_score) >= 1;
  }
  if (row.home_score == null || row.away_score == null) return null;
  const home = n(row.home_score);
  const away = n(row.away_score);
  if (key === 'o15') return home + away >= 2;
  if (key === 'o25') return home + away >= 3;
  if (key === 'btts') return home > 0 && away > 0;
  return null;
}

async function publicOverview(database = pool) {
  const commercial = publicCommercialConfig();
  if (!database) {
    return {
      commercial,
      results: {
        status: 'UNAVAILABLE',
        minimumSignals: PUBLIC_MINIMUM_SIGNALS,
        message: 'A conferência pública está temporariamente indisponível.'
      }
    };
  }

  const query = await database.query(`
    SELECT DISTINCT ON (f.id)
      f.id,f.starting_at,f.home_score,f.away_score,f.ht_home_score,f.ht_away_score,
      pm.over05_ht_rate,pm.over15_ft_rate,pm.over25_ft_rate,pm.btts_rate,pm.computed_at
      FROM fixtures f
      JOIN prematch_metrics pm ON pm.fixture_id=f.id
     WHERE pm.score_version LIKE 'jwc-prematch-%'
       AND pm.computed_at<f.starting_at
     ORDER BY f.id,pm.computed_at DESC
  `);

  const marketMap = {
    o15: { key: 'o15', label: '+1.5 FT', total: 0, hits: 0 },
    ht: { key: 'ht', label: 'Gol no HT', total: 0, hits: 0 },
    o25: { key: 'o25', label: '+2.5 FT', total: 0, hits: 0 },
    btts: { key: 'btts', label: 'Ambas marcam', total: 0, hits: 0 }
  };
  let finishedGames = 0;
  let pendingGames = 0;
  let registeredSignals = 0;
  let total = 0;
  let hits = 0;
  const evaluatedDates = [];

  for (const row of query.rows) {
    const chosen = picks(row);
    registeredSignals += chosen.length;
    const finished = row.home_score != null && row.away_score != null;
    if (finished) finishedGames++;
    else pendingGames++;

    let evaluatedInGame = false;
    for (const pick of chosen) {
      const result = evaluate(row, pick.key);
      if (result == null) continue;
      evaluatedInGame = true;
      total++;
      marketMap[pick.key].total++;
      if (result) {
        hits++;
        marketMap[pick.key].hits++;
      }
    }
    if (evaluatedInGame) evaluatedDates.push(new Date(row.starting_at));
  }

  const publishable = total >= PUBLIC_MINIMUM_SIGNALS;
  const markets = Object.values(marketMap).map(market => ({
    ...market,
    misses: market.total - market.hits,
    accuracy: publishable && market.total ? rate(market.hits, market.total) : null
  }));
  const fromDate = evaluatedDates.length
    ? new Date(Math.min(...evaluatedDates.map(date => date.getTime()))).toISOString()
    : null;
  const toDate = evaluatedDates.length
    ? new Date(Math.max(...evaluatedDates.map(date => date.getTime()))).toISOString()
    : null;
  const status = total === 0 ? 'COLLECTING' : publishable ? 'PUBLISHED' : 'SMALL_SAMPLE';
  const message = status === 'PUBLISHED'
    ? 'Resultados calculados somente com análises registradas antes do início das partidas.'
    : total
      ? `Já existem ${total} sinais conferidos. A taxa pública será liberada ao completar ${PUBLIC_MINIMUM_SIGNALS}.`
      : pendingGames
        ? `${pendingGames} análises pré-jogo aguardam o encerramento das partidas.`
        : 'A amostra pública está sendo formada com novos registros pré-jogo.';

  return {
    commercial,
    results: {
      status,
      publishable,
      minimumSignals: PUBLIC_MINIMUM_SIGNALS,
      registeredGames: query.rows.length,
      finishedGames,
      pendingGames,
      registeredSignals,
      signals: total,
      pendingSignals: Math.max(0, registeredSignals - total),
      hits: publishable ? hits : null,
      misses: publishable ? total - hits : null,
      accuracy: publishable ? rate(hits, total) : null,
      progress: Math.min(100, Math.round(total * 100 / PUBLIC_MINIMUM_SIGNALS)),
      fromDate,
      toDate,
      markets,
      message,
      updatedAt: new Date().toISOString()
    }
  };
}

async function syncResults(client, rows, date) {
  if (!process.env.FOOTBALL_DATA_TOKEN || !rows.length) {
    return { checked: 0, updated: 0 };
  }

  const complete = rows.every(row => row.home_score != null && row.away_score != null);
  if (complete) return { checked: rows.length, updated: 0, cache: 'COMPLETE' };

  const recentlyChecked = rows.every(row => {
    const checkedAt = Date.parse(row.raw_data?.result_sync_checked_at || '');
    return Number.isFinite(checkedAt) && Date.now() - checkedAt < RESULT_SYNC_TTL_MS;
  });
  if (recentlyChecked) return { checked: 0, updated: 0, cache: 'HIT' };

  const backoffQuery = await client.query(`
    SELECT MAX((raw_data->>'football_data_retry_at')::timestamptz) AS retry_at
      FROM fixtures
     WHERE raw_data ? 'football_data_retry_at'
  `);
  const blockedUntil = Date.parse(backoffQuery.rows[0]?.retry_at || '') || 0;
  if (blockedUntil > Date.now()) {
    return {
      checked: 0,
      updated: 0,
      cache: 'STALE',
      retryAfter: Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)),
      warning: 'A fonte externa está temporariamente limitada; foram mantidos os placares já salvos.'
    };
  }

  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await lockFootballDataProvider(client);

    const lockedBackoff = await client.query(`
      SELECT MAX((raw_data->>'football_data_retry_at')::timestamptz) AS retry_at
        FROM fixtures
       WHERE raw_data ? 'football_data_retry_at'
    `);
    const lockedUntil = Date.parse(lockedBackoff.rows[0]?.retry_at || '') || 0;
    if (lockedUntil > Date.now()) {
      await client.query('COMMIT');
      transactionOpen = false;
      return {
        checked: 0,
        updated: 0,
        cache: 'STALE',
        retryAfter: Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000)),
        warning: 'A fonte externa está temporariamente limitada; foram mantidos os placares já salvos.'
      };
    }

    const slot = await reserveFootballDataSlot(client);
    if (slot.waitedMs) console.info('[performance] provider slot waited', { date, waitedMs: slot.waitedMs });
    const ids = new Set(rows.map(row => String(row.id)));
    const url = new URL('https://api.football-data.org/v4/matches');
    url.searchParams.set('dateFrom', date);
    url.searchParams.set('dateTo', nextDate(date));

    const body = await fetchFootballData(url);
    const checkedAt = new Date().toISOString();
    const rowIds = rows.map(row => String(row.id));
    await client.query(
      "UPDATE fixtures SET raw_data=COALESCE(raw_data,'{}'::jsonb)||jsonb_build_object('result_sync_checked_at',$2::text) WHERE id=ANY($1::bigint[])",
      [rowIds, checkedAt]
    );

    const matches = (body.matches || []).filter(match => ids.has(String(match.id)));
    let updated = 0;

    for (const match of matches) {
      const fullTime = match.score?.fullTime || {};
      const halfTime = match.score?.halfTime || {};
      if (fullTime.home == null || fullTime.away == null) continue;

      await client.query(
        "UPDATE fixtures SET status=$2,home_score=$3,away_score=$4,ht_home_score=$5,ht_away_score=$6,raw_data=COALESCE(raw_data,'{}'::jsonb)||$7::jsonb,updated_at=NOW() WHERE id=$1",
        [
          match.id,
          match.status || 'FINISHED',
          fullTime.home,
          fullTime.away,
          halfTime.home ?? null,
          halfTime.away ?? null,
          JSON.stringify({ result_checked_at: checkedAt, result_source: 'football-data.org' })
        ]
      );
      updated++;
    }

    await client.query('COMMIT');
    transactionOpen = false;
    return { checked: matches.length, updated, cache: 'MISS' };
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
      transactionOpen = false;
    }
    if (error.status === 429) {
      const retryAfter = Math.min(Math.max(Number(error.retryAfter) || 60, 30), 15 * 60);
      const retryAt = new Date(Date.now() + retryAfter * 1000).toISOString();
      await client.query(`
        UPDATE fixtures
           SET raw_data=COALESCE(raw_data,'{}'::jsonb)||jsonb_build_object('football_data_retry_at',$1::text)
         WHERE id=(SELECT id FROM fixtures WHERE source='football-data.org' ORDER BY updated_at DESC LIMIT 1)
      `, [retryAt]).catch(() => {});
      console.warn('[performance] football-data rate limit', { retryAfter, date });
      return {
        checked: 0,
        updated: 0,
        cache: 'STALE',
        retryAfter,
        warning: 'A fonte externa atingiu o limite temporário; foram mantidos os placares já salvos.'
      };
    }
    console.error('[performance] result sync failed', { message: error.message, status: error.status || 500, date });
    return { checked: 0, updated: 0, warning: error.message };
  }
}

module.exports = async (req, res) => {
  const publicMode = String(req.query?.public || '') === '1';
  if (publicMode) {
    if (req.method && req.method !== 'GET') {
      return res.status(405).json({ ok: false, error: 'Método não permitido.' });
    }
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    try {
      return res.status(200).json({ ok: true, ...(await publicOverview()) });
    } catch (error) {
      console.error('Public performance error:', error.message);
      return res.status(200).json({
        ok: true,
        commercial: publicCommercialConfig(),
        results: {
          status: 'UNAVAILABLE',
          minimumSignals: PUBLIC_MINIMUM_SIGNALS,
          message: 'A conferência pública está temporariamente indisponível.'
        }
      });
    }
  }

  res.setHeader('Cache-Control', 'no-store');

  const user = await requireUser(req, res);
  if (!user) return;

  if (!pool) {
    return res.status(500).json({ ok: false, error: 'DATABASE_URL não configurada.' });
  }

  const date = String(req.query.date || '').trim();
  if (!validDate(date)) {
    return res.status(400).json({ ok: false, error: 'Escolha uma data válida no formato YYYY-MM-DD.' });
  }

  const client = await pool.connect();
  try {
    const stored = await client.query(
      "SELECT DISTINCT f.id,f.home_score,f.away_score,f.raw_data FROM fixtures f JOIN prematch_metrics pm ON pm.fixture_id=f.id WHERE (f.starting_at AT TIME ZONE '" + TZ + "')::date=$1::date AND pm.score_version LIKE 'jwc-prematch-%' ORDER BY f.id",
      [date]
    );

    const synced = await syncResults(client, stored.rows, date);

    const query = await client.query(
      "SELECT DISTINCT ON (f.id) f.id,f.starting_at,f.status,f.home_score,f.away_score,f.ht_home_score,f.ht_away_score,f.raw_data,pm.sample_size,pm.over05_ht_rate,pm.over15_ft_rate,pm.over25_ft_rate,pm.btts_rate,pm.jwc_prematch_score,pm.score_version,pm.computed_at FROM fixtures f JOIN prematch_metrics pm ON pm.fixture_id=f.id WHERE (f.starting_at AT TIME ZONE '" + TZ + "')::date=$1::date AND pm.score_version LIKE 'jwc-prematch-%' ORDER BY f.id,CASE WHEN pm.computed_at<f.starting_at THEN 0 ELSE 1 END,pm.computed_at ASC",
      [date]
    );

    const marketMap = {
      o15: { label: '+1.5 FT', total: 0, hits: 0 },
      ht: { label: 'Gol HT', total: 0, hits: 0 },
      o25: { label: '+2.5 FT', total: 0, hits: 0 },
      btts: { label: 'Ambas marcam', total: 0, hits: 0 }
    };
    const bandMap = {
      high: { label: 'Faixa A · JWC 65+', total: 0, hits: 0 },
      medium: { label: 'Faixa B+ · JWC 55–64', total: 0, hits: 0 },
      low: { label: 'Faixa C · JWC abaixo de 55', total: 0, hits: 0 }
    };

    let hits = 0;
    let total = 0;
    let finished = 0;
    let pending = 0;
    let pendingSignals = 0;
    let gamesWithSignals = 0;
    let retrospective = 0;

    const games = query.rows.map(row => {
      const done = row.home_score != null && row.away_score != null;
      if (done) finished++;
      else pending++;

      const timing = new Date(row.computed_at) < new Date(row.starting_at) ? 'pre_match' : 'retrospective';
      if (timing === 'retrospective') retrospective++;

      const chosen = picks(row);
      if (chosen.length) gamesWithSignals++;

      const selections = chosen.map(pick => {
        const result = evaluate(row, pick.key);
        if (result == null) {
          pendingSignals++;
        } else {
          total++;
          marketMap[pick.key].total++;
          const band = n(row.jwc_prematch_score) >= 65
            ? bandMap.high
            : n(row.jwc_prematch_score) >= 55
              ? bandMap.medium
              : bandMap.low;
          band.total++;
          if (result) {
            hits++;
            marketMap[pick.key].hits++;
            band.hits++;
          }
        }
        return { ...pick, hit: result };
      });

      const evaluated = selections.filter(pick => pick.hit != null);
      const gameHits = evaluated.filter(pick => pick.hit).length;

      return {
        id: String(row.id),
        starting_at: row.starting_at,
        status: row.status,
        league: row.raw_data?.league || 'Competição',
        home: row.raw_data?.home || 'Mandante',
        away: row.raw_data?.away || 'Visitante',
        score: done ? [row.home_score, row.away_score] : null,
        halfTime: row.ht_home_score != null && row.ht_away_score != null
          ? [row.ht_home_score, row.ht_away_score]
          : null,
        jwc: n(row.jwc_prematch_score),
        sample: n(row.sample_size),
        analysisTiming: timing,
        picks: selections,
        result: evaluated.length
          ? { hits: gameHits, misses: evaluated.length - gameHits, accuracy: rate(gameHits, evaluated.length) }
          : null
      };
    }).sort((a, b) => new Date(a.starting_at) - new Date(b.starting_at));

    const markets = Object.entries(marketMap).map(([key, market]) => ({
      key,
      ...market,
      misses: market.total - market.hits,
      accuracy: rate(market.hits, market.total)
    }));
    const scoreBands = Object.values(bandMap).map(band => ({
      ...band,
      misses: band.total - band.hits,
      accuracy: rate(band.hits, band.total)
    }));

    const warnings = [];
    if (total < 30) warnings.push('Amostra pequena: evite conclusões definitivas antes de pelo menos 30 palpites conferidos.');
    if (retrospective) warnings.push(retrospective + ' jogo(s) foram analisados após o início e aparecem como análise retrospectiva, não como previsão registrada antes da partida.');
    if (synced.warning) warnings.push('A atualização externa de placares falhou, mas os resultados já salvos continuam exibidos.');

    return res.status(200).json({
      ok: true,
      date,
      sync: synced,
      summary: {
        analyzed: games.length,
        finished,
        pending,
        gamesWithSignals,
        signals: total,
        pendingSignals,
        hits,
        misses: total - hits,
        accuracy: rate(hits, total),
        retrospective
      },
      markets,
      scoreBands,
      games,
      warning: warnings.join(' '),
      methodology: 'Conferência exata da data escolhida. Cortes: +1.5 ≥80%, Gol HT ≥60%, +2.5 ≥65% e BTTS ≥65%.'
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Erro ao conferir desempenho.' });
  } finally {
    client.release();
  }
};

module.exports.publicOverview = publicOverview;
