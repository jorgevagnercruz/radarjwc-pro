const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

function homeAway(fixture) {
  const p = fixture.participants || [];
  return {
    home: p.find(x => x.meta?.location === 'home'),
    away: p.find(x => x.meta?.location === 'away')
  };
}

function scoreOf(fixture, participantId) {
  const scores = fixture.scores || [];
  const current = scores.filter(s => s.participant_id === participantId)
    .sort((a,b) => (b.id || 0) - (a.id || 0))[0];
  return Number(current?.score?.goals ?? current?.score?.participant ?? 0) || 0;
}

function statMap(fixture, participantId) {
  const out = {};
  for (const s of fixture.statistics || []) {
    if (s.participant_id !== participantId) continue;
    const key = String(s.type?.name || s.type?.developer_name || '').toLowerCase();
    const val = Number(s.data?.value ?? s.value ?? s.data ?? 0) || 0;
    out[key] = val;
  }
  const find = (...parts) => {
    const k = Object.keys(out).find(key => parts.every(p => key.includes(p)));
    return k ? out[k] : null;
  };
  return {
    shots: find('shots','total') ?? find('shots') ?? 0,
    sot: find('shots','on','target') ?? find('on target') ?? 0,
    inside: find('shots','inside') ?? find('inside box') ?? 0,
    big: find('big','chances') ?? 0,
    danger: find('dangerous','attacks') ?? 0,
    corners: find('corners') ?? 0
  };
}

function pressureScore(H, A, minute) {
  const totalShots = H.shots + A.shots;
  const totalSot = H.sot + A.sot;
  const totalInside = H.inside + A.inside;
  const totalBig = H.big + A.big;
  const totalDanger = H.danger + A.danger;
  const totalCorners = H.corners + A.corners;

  let p = 0;
  p += Math.min(totalShots / 20, 1) * 22;
  p += Math.min(totalSot / 8, 1) * 23;
  p += Math.min(totalInside / 14, 1) * 18;
  p += Math.min(totalBig / 4, 1) * 15;
  p += Math.min(totalDanger / 80, 1) * 12;
  p += Math.min(totalCorners / 10, 1) * 10;

  if (minute >= 55 && minute <= 80) p += 4;
  return Math.max(0, Math.min(100, Math.round(p)));
}

function signalFor(p) {
  if (p >= 80) return '🔥 FORTE PRESSÃO PARA GOL';
  if (p >= 65) return '🟢 BOM SINAL';
  if (p >= 50) return '🟡 MONITORAR';
  return '⚪ SEM SINAL FORTE';
}

async function persist(game, rawFixture) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO fixture_snapshots(
        fixture_id, minute, home_score, away_score, home_shots, away_shots,
        home_shots_on_target, away_shots_on_target, home_shots_inside_box,
        away_shots_inside_box, home_dangerous_attacks, away_dangerous_attacks,
        home_corners, away_corners, raw_data
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      game.id, game.minute, game.score[0], game.score[1],
      game.homeStats.shots, game.awayStats.shots,
      game.homeStats.sot, game.awayStats.sot,
      game.homeStats.inside, game.awayStats.inside,
      game.homeStats.danger, game.awayStats.danger,
      game.homeStats.corners, game.awayStats.corners,
      JSON.stringify({ pressure: game.pressure, signal: game.signal, source: 'sportmonks', fixture: rawFixture.id })
    ]);
  } catch (e) {
    console.error('Snapshot persist error:', e.message);
  }
}

module.exports = async (req, res) => {
  try {
    if (!process.env.SPORTMONKS_TOKEN) {
      return res.status(500).json({ ok:false, error:'SPORTMONKS_TOKEN não configurado.' });
    }

    const url = new URL('https://api.sportmonks.com/v3/football/livescores/inplay');
    url.searchParams.set('api_token', process.env.SPORTMONKS_TOKEN);
    url.searchParams.set('include', 'scores;participants;statistics.type;periods;state');

    const r = await fetch(url);
    const body = await r.json();
    if (!r.ok) throw new Error(body?.message || `Sportmonks HTTP ${r.status}`);

    const games = (body.data || []).map(f => {
      const { home, away } = homeAway(f);
      if (!home || !away) return null;
      const active = (f.periods || []).find(p => p.ticking) ||
        [...(f.periods || [])].sort((a,b) => (b.sort_order||0)-(a.sort_order||0))[0] || {};
      const minute = Number(active.minutes || 0);
      const H = statMap(f, home.id);
      const A = statMap(f, away.id);
      const pressure = pressureScore(H, A, minute);
      return {
        id: f.id,
        home: home.name,
        away: away.name,
        minute,
        score: [scoreOf(f, home.id), scoreOf(f, away.id)],
        pressure,
        signal: signalFor(pressure),
        homeStats: H,
        awayStats: A
      };
    }).filter(Boolean);

    for (let i = 0; i < games.length; i++) persist(games[i], body.data[i]).catch(()=>{});

    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({
      ok:true,
      updatedAt:new Date().toISOString(),
      count:games.length,
      games,
      note:'Pressão JWC ao vivo é um índice heurístico em validação, não probabilidade.'
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:e.message || 'Erro no Live Radar.' });
  }
};
