const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

function avg2(a, b) {
  const vals = [a, b].filter(v => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
}
const pct = (a, b) => Math.round(avg2(a ?? 0, b ?? 0) * 100);
const r1 = n => Math.round((Number(n) || 0) * 10) / 10;

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

async function persist(games) {
  if (!pool || !games.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const g of games) {
      await client.query(`
        INSERT INTO fixtures(id, source, league_id, starting_at, status, raw_data)
        VALUES($1,'football-data.org',NULL,$2,'SCHEDULED',$3)
        ON CONFLICT (id) DO UPDATE SET
          starting_at=EXCLUDED.starting_at,
          raw_data=EXCLUDED.raw_data,
          updated_at=NOW()
      `, [g.id, g.starting_at, JSON.stringify({
        league: g.league, leagueCode: g.leagueCode, home: g.home, away: g.away
      })]);

      await client.query(`
        INSERT INTO prematch_metrics(
          fixture_id, sample_size, home_sample_size, away_sample_size,
          over05_ht_rate, over15_ft_rate, over25_ft_rate, btts_rate,
          avg_total_goals, home_avg_scored, home_avg_conceded,
          away_avg_scored, away_avg_conceded, jwc_prematch_score, score_version
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'jwc-prematch-v0.9.1')
        ON CONFLICT (fixture_id, score_version) DO UPDATE SET
          sample_size=EXCLUDED.sample_size,
          home_sample_size=EXCLUDED.home_sample_size,
          away_sample_size=EXCLUDED.away_sample_size,
          over05_ht_rate=EXCLUDED.over05_ht_rate,
          over15_ft_rate=EXCLUDED.over15_ft_rate,
          over25_ft_rate=EXCLUDED.over25_ft_rate,
          btts_rate=EXCLUDED.btts_rate,
          avg_total_goals=EXCLUDED.avg_total_goals,
          home_avg_scored=EXCLUDED.home_avg_scored,
          home_avg_conceded=EXCLUDED.home_avg_conceded,
          away_avg_scored=EXCLUDED.away_avg_scored,
          away_avg_conceded=EXCLUDED.away_avg_conceded,
          jwc_prematch_score=EXCLUDED.jwc_prematch_score,
          computed_at=NOW()
      `, [
        g.id, g.metrics.sample, g.metrics.homeSample, g.metrics.awaySample,
        g.metrics.ht.pct / 100, g.metrics.o15.pct / 100, g.metrics.o25.pct / 100,
        g.metrics.btts.pct / 100, g.metrics.avgGoals,
        g.teamAverages.home.scored, g.teamAverages.home.conceded,
        g.teamAverages.away.scored, g.teamAverages.away.conceded, g.jwc
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Neon persist error:', e.message);
  } finally {
    client.release();
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Data inválida. Use YYYY-MM-DD.' });
    }
    if (!process.env.FOOTBALL_DATA_TOKEN) {
      return res.status(500).json({ ok: false, error: 'FOOTBALL_DATA_TOKEN não configurado.' });
    }

    const url = new URL('https://api.football-data.org/v4/trends/');
    url.searchParams.set('date', date);
    url.searchParams.set('window', '10');
    url.searchParams.append('consider_side', '');

    const r = await fetch(url, {
      headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_TOKEN }
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body?.message || `football-data.org HTTP ${r.status}`);

    const raw = Array.isArray(body.trends) ? body.trends : [];
    const games = raw.map(t => {
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
      for (const k of ['ht','o15','o25','btts','sh15']) {
        metrics[k].hits = Math.round(metrics[k].pct / 100 * sample);
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

    persist(games).catch(() => {});
    return res.status(200).json({
      ok: true, date, count: games.length, analyzed: games.length, games,
      note: 'Percentuais são frequências históricas observadas no Trend Resource; window=10 e consider_side ativado. JWC Score é ranking, não probabilidade.'
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || 'Erro no Scanner.' });
  }
};
