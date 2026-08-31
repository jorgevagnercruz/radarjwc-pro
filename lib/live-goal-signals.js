const { sendGoalAlert, telegramConfigured } = require('./telegram');

const SIGNAL_PROVIDER = 'live-goal-v1';
const SIGNAL_VERSION = 'live-goal-v1.0.0';
const SNAPSHOT_MAX_AGE_MS = 3 * 60 * 1000;
const MOMENTUM_MAX_MINUTES = 12;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRaw(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

function sumKnown(left, right) {
  const a = numberOrNull(left);
  const b = numberOrNull(right);
  return a === null || b === null ? null : a + b;
}

function snapshotTotals(row) {
  const raw = parseRaw(row?.raw_data);
  return {
    shots: sumKnown(row?.home_shots, row?.away_shots),
    sot: sumKnown(row?.home_shots_on_target, row?.away_shots_on_target),
    inside: sumKnown(row?.home_shots_inside_box, row?.away_shots_inside_box),
    danger: sumKnown(row?.home_dangerous_attacks, row?.away_dangerous_attacks),
    corners: sumKnown(row?.home_corners, row?.away_corners),
    xg: sumKnown(row?.home_xg, row?.away_xg),
    big: sumKnown(raw.homeBigChances, raw.awayBigChances),
    red: sumKnown(row?.home_red_cards, row?.away_red_cards)
  };
}

function recentDelta(current, previous, field) {
  const now = numberOrNull(current?.[field]);
  const before = numberOrNull(previous?.[field]);
  if (now === null || before === null) return null;
  return Math.max(0, now - before);
}

function momentumScore(current, previous) {
  const metrics = [
    { field: 'shots', target: 4, weight: 25, label: 'finalizações' },
    { field: 'sot', target: 2, weight: 35, label: 'chutes no gol' },
    { field: 'inside', target: 3, weight: 15, label: 'ações dentro da área' },
    { field: 'danger', target: 12, weight: 10, label: 'ataques perigosos' },
    { field: 'corners', target: 2, weight: 8, label: 'escanteios' },
    { field: 'xg', target: 0.4, weight: 7, label: 'xG' }
  ];
  const deltas = {};
  let availableWeight = 0;
  let earned = 0;
  for (const metric of metrics) {
    const delta = recentDelta(current, previous, metric.field);
    deltas[metric.field] = delta;
    if (delta === null) continue;
    availableWeight += metric.weight;
    earned += Math.min(delta / metric.target, 1) * metric.weight;
  }
  return {
    score: availableWeight >= 60 ? Math.round((earned / availableWeight) * 100) : null,
    coverage: availableWeight,
    deltas
  };
}

function signalWindow(game) {
  const minute = Number(game?.minute || 0);
  const homeScore = Number(game?.score?.[0] || 0);
  const awayScore = Number(game?.score?.[1] || 0);
  const totalScore = homeScore + awayScore;
  if (totalScore === 0 && minute >= 20 && minute <= 41) {
    return { type: 'GOAL_HT_0_0', label: 'POSSÍVEL GOL NO 1º TEMPO', watch: 72, confirm: 78, strong: 85 };
  }
  if (totalScore === 0 && minute >= 52 && minute <= 80) {
    return { type: 'GOAL_2H_0_0', label: 'POSSÍVEL GOL NO 2º TEMPO', watch: 72, confirm: 78, strong: 85 };
  }
  if (totalScore > 0 && Math.abs(homeScore - awayScore) === 1 && minute >= 73 && minute <= 88) {
    return { type: 'NEXT_GOAL_2H', label: 'POSSÍVEL NOVO GOL NO 2º TEMPO', watch: 76, confirm: 82, strong: 88 };
  }
  return null;
}

function selectSnapshots(rows, game, nowMs = Date.now()) {
  const ordered = [...(rows || [])].sort((a, b) => {
    const timeDiff = new Date(b.captured_at || 0).getTime() - new Date(a.captured_at || 0).getTime();
    return timeDiff || Number(b.minute || 0) - Number(a.minute || 0);
  });
  const current = ordered[0] || null;
  if (!current) return { current: null, previous: null, reason: 'Aguardando a primeira leitura.' };
  const capturedAt = new Date(current.captured_at || 0).getTime();
  if (!Number.isFinite(capturedAt) || nowMs - capturedAt > SNAPSHOT_MAX_AGE_MS) {
    return { current, previous: null, reason: 'A última leitura está desatualizada.' };
  }
  const currentMinute = Number(current.minute ?? game?.minute ?? 0);
  const previous = ordered.find(row => {
    const minute = Number(row.minute || 0);
    return minute <= currentMinute - 2 && minute >= currentMinute - MOMENTUM_MAX_MINUTES;
  }) || null;
  return {
    current,
    previous,
    reason: previous ? null : 'Coletando uma segunda leitura para medir a evolução.'
  };
}

function goalSignalScore(game, currentRow, previousRow) {
  const window = signalWindow(game);
  if (!window) return { status: 'outside', eligible: false, confirmed: false, score: null, window: null, reasons: [] };
  if (!currentRow || !previousRow) {
    return { status: 'collecting', eligible: false, confirmed: false, score: null, window, reasons: ['Coletando histórico recente.'] };
  }

  const current = snapshotTotals(currentRow);
  const previous = snapshotTotals(previousRow);
  const momentum = momentumScore(current, previous);
  const pressure = numberOrNull(game.pressure ?? parseRaw(currentRow.raw_data).pressure);
  if (momentum.score === null || pressure === null) {
    return { status: 'insufficient', eligible: false, confirmed: false, score: null, window, momentum, reasons: ['Estatísticas insuficientes.'] };
  }

  const scorelessBonus = window.type.endsWith('0_0') ? 10 : 7;
  const strongBurst = Number(momentum.deltas.sot || 0) >= 2 && Number(momentum.deltas.shots || 0) >= 3 ? 5 : 0;
  const score = Math.min(100, Math.round(pressure * 0.4 + momentum.score * 0.5 + scorelessBonus + strongBurst));
  const reasons = [];
  const elapsed = Math.max(1, Number(currentRow.minute || game.minute || 0) - Number(previousRow.minute || 0));
  if (Number(momentum.deltas.shots || 0) > 0) reasons.push(`${momentum.deltas.shots} finalização(ões) nos últimos ${elapsed} minutos`);
  if (Number(momentum.deltas.sot || 0) > 0) reasons.push(`${momentum.deltas.sot} chute(s) no gol no período recente`);
  if (Number(momentum.deltas.inside || 0) > 0) reasons.push(`${momentum.deltas.inside} nova(s) finalização(ões) dentro da área`);
  if (Number(momentum.deltas.xg || 0) >= 0.2) reasons.push(`xG cresceu ${Number(momentum.deltas.xg).toFixed(2).replace('.', ',')}`);
  if (Number(current.red || 0) > 0) reasons.push('Partida com expulsão; contexto de risco elevado');

  return {
    status: score >= window.watch ? 'watching' : 'below',
    eligible: score >= window.watch,
    confirmed: score >= window.strong,
    score,
    window,
    pressure,
    momentum,
    totals: current,
    reasons: reasons.slice(0, 4)
  };
}

function initialState(game) {
  return {
    version: SIGNAL_VERSION,
    fixtureId: game.dbId,
    externalId: game.externalId,
    provider: game.provider,
    home: game.home,
    away: game.away,
    league: game.league,
    confirmation: null,
    signals: [],
    lastScore: [Number(game.score?.[0] || 0), Number(game.score?.[1] || 0)],
    lastMinute: Number(game.minute || 0),
    updatedAt: new Date().toISOString()
  };
}

function evolveSignalState(existing, evaluation, game, now = new Date()) {
  const state = existing && existing.version === SIGNAL_VERSION
    ? { ...existing, signals: [...(existing.signals || [])] }
    : initialState(game);
  const minute = Number(game.minute || 0);
  const score = [Number(game.score?.[0] || 0), Number(game.score?.[1] || 0)];
  const totalScore = score[0] + score[1];
  const previousTotal = Number(state.lastScore?.[0] || 0) + Number(state.lastScore?.[1] || 0);

  for (const signal of state.signals) {
    if (signal.outcome?.status !== 'pending') continue;
    if (totalScore > Number(signal.scoreTotal || 0)) {
      const afterMinutes = Math.max(0, minute - Number(signal.minute || 0));
      signal.outcome = {
        status: afterMinutes <= 15 ? 'hit' : 'late',
        goalMinute: minute,
        afterMinutes,
        within5: afterMinutes <= 5,
        within10: afterMinutes <= 10,
        within15: afterMinutes <= 15,
        checkedAt: now.toISOString()
      };
    } else if (minute - Number(signal.minute || 0) > 15) {
      signal.outcome = { status: 'miss', checkedAt: now.toISOString() };
    }
  }

  let newAlert = null;
  if (evaluation?.eligible && evaluation.window) {
    const stateKey = `${evaluation.window.type}:${score[0]}-${score[1]}`;
    const same = state.confirmation?.key === stateKey && minute - Number(state.confirmation?.minute || 0) <= 7;
    const streak = same ? Number(state.confirmation.streak || 0) + 1 : 1;
    state.confirmation = { key: stateKey, streak, minute, score: evaluation.score, at: now.toISOString() };
    const confirmed = evaluation.confirmed || (streak >= 2 && evaluation.score >= evaluation.window.confirm);
    const duplicate = state.signals.some(signal => signal.stateKey === stateKey);
    if (confirmed && !duplicate) {
      const signal = {
        id: `${game.dbId}:${stateKey}:${minute}`,
        stateKey,
        type: evaluation.window.type,
        label: evaluation.window.label,
        minute,
        score,
        scoreTotal: totalScore,
        signalScore: evaluation.score,
        pressure: evaluation.pressure,
        momentum: evaluation.momentum,
        stats: evaluation.totals,
        reasons: evaluation.reasons,
        detectedAt: now.toISOString(),
        delivery: { status: 'pending' },
        outcome: { status: 'pending' }
      };
      state.signals.push(signal);
      newAlert = {
        ...signal,
        fixtureId: game.dbId,
        home: game.home,
        away: game.away,
        league: game.league,
        provider: game.provider
      };
    }
  } else {
    state.confirmation = null;
  }

  if (totalScore > previousTotal) state.confirmation = null;
  state.signals = state.signals.slice(-8);
  state.lastScore = score;
  state.lastMinute = minute;
  state.updatedAt = now.toISOString();
  return { state, newAlert };
}

async function loadSignalStates(client, fixtureIds) {
  if (!fixtureIds.length) return new Map();
  const result = await client.query(
    'SELECT fixture_id,raw_data FROM scanner_results WHERE provider=$1 AND fixture_id=ANY($2::bigint[])',
    [SIGNAL_PROVIDER, fixtureIds]
  );
  return new Map(result.rows.map(row => [Number(row.fixture_id), parseRaw(row.raw_data).live_goal_state || null]));
}

async function loadSnapshots(client, fixtureIds) {
  if (!fixtureIds.length) return new Map();
  const result = await client.query(`
    SELECT fixture_id,captured_at,minute,period,home_score,away_score,
           home_shots,away_shots,home_shots_on_target,away_shots_on_target,
           home_shots_inside_box,away_shots_inside_box,
           home_dangerous_attacks,away_dangerous_attacks,
           home_corners,away_corners,home_red_cards,away_red_cards,
           home_xg,away_xg,raw_data
      FROM fixture_snapshots
     WHERE fixture_id=ANY($1::bigint[])
       AND captured_at>NOW()-INTERVAL '20 minutes'
     ORDER BY fixture_id,captured_at DESC
  `, [fixtureIds]);
  const grouped = new Map();
  for (const row of result.rows) {
    const id = Number(row.fixture_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return grouped;
}

async function saveSignalState(client, game, state, evaluation) {
  const status = state.signals.some(signal => signal.outcome?.status === 'pending')
    ? 'SIGNAL'
    : evaluation?.eligible ? 'WATCHING' : 'MONITORING';
  await client.query(`
    INSERT INTO scanner_results(
      provider,fixture_id,fixture_date,starting_at,league_name,
      home_team_name,away_team_name,jwc_score,status,computed_at,raw_data
    ) VALUES(
      $1,$2,(COALESCE($3::timestamptz,NOW()) AT TIME ZONE 'America/Sao_Paulo')::date,
      $3,$4,$5,$6,$7,$8,NOW(),$9
    )
    ON CONFLICT(provider,fixture_id) DO UPDATE SET
      starting_at=EXCLUDED.starting_at,
      league_name=EXCLUDED.league_name,
      home_team_name=EXCLUDED.home_team_name,
      away_team_name=EXCLUDED.away_team_name,
      jwc_score=EXCLUDED.jwc_score,
      status=EXCLUDED.status,
      computed_at=NOW(),
      raw_data=EXCLUDED.raw_data
  `, [
    SIGNAL_PROVIDER,
    game.dbId,
    game.starting_at || null,
    game.league || 'Competição',
    game.home,
    game.away,
    evaluation?.score ?? null,
    status,
    JSON.stringify({ live_goal_state: state })
  ]);
}

function publicGoalSignal(evaluation, state, newAlert) {
  const lastSignal = [...(state.signals || [])].reverse().find(signal => signal.outcome?.status === 'pending');
  return {
    status: newAlert || lastSignal ? 'confirmed' : evaluation.status,
    type: evaluation.window?.type || null,
    label: evaluation.window?.label || null,
    score: evaluation.score,
    streak: state.confirmation?.streak || 0,
    reasons: evaluation.reasons || [],
    delivery: (newAlert || lastSignal)?.delivery?.status || null,
    outcome: lastSignal?.outcome?.status || null
  };
}

async function analyzeLiveGoalSignals(client, games, now = new Date()) {
  const candidates = (games || []).filter(game => Number.isFinite(game.dbId) && Number.isFinite(game.pressure));
  const fixtureIds = [...new Set(candidates.map(game => Number(game.dbId)))];
  const [states, snapshots] = await Promise.all([
    loadSignalStates(client, fixtureIds),
    loadSnapshots(client, fixtureIds)
  ]);
  const alerts = [];
  let watching = 0;
  let confirmed = 0;
  const enriched = [];

  for (const game of games || []) {
    if (!Number.isFinite(game.dbId) || !Number.isFinite(game.pressure)) {
      enriched.push(game);
      continue;
    }
    const selected = selectSnapshots(snapshots.get(Number(game.dbId)) || [], game, now.getTime());
    const evaluation = selected.reason
      ? { status: 'collecting', eligible: false, confirmed: false, score: null, window: signalWindow(game), reasons: [selected.reason] }
      : goalSignalScore(game, selected.current, selected.previous);
    const evolved = evolveSignalState(states.get(Number(game.dbId)), evaluation, game, now);
    await saveSignalState(client, game, evolved.state, evaluation);
    if (evaluation.eligible) watching += 1;
    if (evolved.newAlert) {
      alerts.push(evolved.newAlert);
      confirmed += 1;
    } else if (evolved.state.signals.some(signal => signal.outcome?.status === 'pending')) {
      confirmed += 1;
    }
    enriched.push({ ...game, goalSignal: publicGoalSignal(evaluation, evolved.state, evolved.newAlert) });
  }

  return {
    games: enriched,
    alerts,
    summary: { watching, confirmed, newAlerts: alerts.length }
  };
}

async function markDelivery(pool, fixtureId, signalId, result) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      'SELECT raw_data FROM scanner_results WHERE provider=$1 AND fixture_id=$2 FOR UPDATE',
      [SIGNAL_PROVIDER, fixtureId]
    );
    const raw = parseRaw(row.rows[0]?.raw_data);
    const state = raw.live_goal_state;
    if (state) {
      const signal = (state.signals || []).find(item => item.id === signalId);
      if (signal) {
        signal.delivery = {
          status: result.status,
          messageId: result.messageId || null,
          updatedAt: new Date().toISOString()
        };
        await client.query(
          'UPDATE scanner_results SET raw_data=$3,computed_at=NOW() WHERE provider=$1 AND fixture_id=$2',
          [SIGNAL_PROVIDER, fixtureId, JSON.stringify({ live_goal_state: state })]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[live-goal] delivery persistence failed', { fixtureId, message: error.message });
  } finally {
    client.release();
  }
}

async function deliverGoalAlerts(pool, alerts, env = process.env, fetchImpl = global.fetch) {
  const results = [];
  for (const alert of alerts || []) {
    const result = await sendGoalAlert(alert, env, fetchImpl);
    await markDelivery(pool, alert.fixtureId || alert.id?.split(':')[0], alert.id, result);
    results.push({ fixtureId: alert.fixtureId, signalId: alert.id, ...result });
  }
  return {
    configured: telegramConfigured(env),
    attempted: results.length,
    sent: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    results
  };
}

module.exports = {
  SIGNAL_PROVIDER,
  SIGNAL_VERSION,
  snapshotTotals,
  momentumScore,
  signalWindow,
  selectSnapshots,
  goalSignalScore,
  evolveSignalState,
  analyzeLiveGoalSignals,
  deliverGoalAlerts
};
