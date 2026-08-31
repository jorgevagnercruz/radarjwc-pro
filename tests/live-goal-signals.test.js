const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  goalSignalScore,
  evolveSignalState,
  selectSnapshots,
  signalWindow
} = require('../lib/live-goal-signals');
const { formatGoalAlert, sendTelegramMessage } = require('../lib/telegram');
const { isAuthorizedCron } = require('../lib/cron-auth');

function row(minute, values = {}) {
  return {
    captured_at: new Date(Date.UTC(2026, 7, 31, 0, 0) + minute * 60000).toISOString(),
    minute,
    home_score: 0,
    away_score: 0,
    home_shots: values.homeShots ?? 8,
    away_shots: values.awayShots ?? 2,
    home_shots_on_target: values.homeSot ?? 1,
    away_shots_on_target: values.awaySot ?? 0,
    home_shots_inside_box: values.homeInside ?? 6,
    away_shots_inside_box: values.awayInside ?? 1,
    home_dangerous_attacks: values.homeDanger ?? 38,
    away_dangerous_attacks: values.awayDanger ?? 10,
    home_corners: values.homeCorners ?? 2,
    away_corners: values.awayCorners ?? 1,
    home_xg: values.homeXg ?? 0.65,
    away_xg: values.awayXg ?? 0.15,
    home_red_cards: values.homeRed ?? 0,
    away_red_cards: values.awayRed ?? 0,
    raw_data: {
      pressure: values.pressure ?? 70,
      homeBigChances: values.homeBig ?? 2,
      awayBigChances: values.awayBig ?? 0
    }
  };
}

function caliGame(minute = 69, score = [0, 0]) {
  return {
    dbId: -99001,
    externalId: 99001,
    provider: 'api-football',
    league: 'Colômbia',
    starting_at: '2026-08-30T22:20:00Z',
    home: 'Deportivo Cali',
    away: 'Atlético Bucaramanga',
    minute,
    score,
    pressure: 70
  };
}

test('o caso Deportivo Cali confirma sinal antes do gol aos 72 minutos', () => {
  const previous = row(60);
  const current = row(69, {
    homeShots: 10,
    awayShots: 4,
    homeSot: 2,
    awaySot: 1,
    homeInside: 8,
    awayInside: 2,
    homeDanger: 48,
    awayDanger: 12,
    homeXg: 0.95,
    awayXg: 0.25
  });
  const evaluation = goalSignalScore(caliGame(), current, previous);
  assert.equal(evaluation.window.type, 'GOAL_2H_0_0');
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.confirmed, true);
  assert.ok(evaluation.score >= 85);
  assert.equal(evaluation.momentum.deltas.shots, 4);
  assert.equal(evaluation.momentum.deltas.sot, 2);

  const detected = evolveSignalState(null, evaluation, caliGame(), new Date('2026-08-31T01:09:00Z'));
  assert.ok(detected.newAlert);
  assert.equal(detected.state.signals.length, 1);

  const afterGoal = evolveSignalState(
    detected.state,
    { status: 'outside', eligible: false, window: null, reasons: [] },
    caliGame(72, [0, 1]),
    new Date('2026-08-31T01:12:00Z')
  );
  assert.equal(afterGoal.state.signals[0].outcome.status, 'hit');
  assert.equal(afterGoal.state.signals[0].outcome.afterMinutes, 3);
  assert.equal(afterGoal.state.signals[0].outcome.within5, true);
});

test('não usa estatística final sem uma leitura histórica anterior', () => {
  const game = caliGame();
  const latest = row(69, { homeShots: 13, awayShots: 8, homeSot: 4, awaySot: 3 });
  const selection = selectSnapshots([latest], game, new Date('2026-08-31T01:09:30Z').getTime());
  assert.equal(selection.previous, null);
  const evaluation = goalSignalScore(game, selection.current, selection.previous);
  assert.equal(evaluation.status, 'collecting');
  assert.equal(evaluation.eligible, false);
});

test('abre novo ciclo no segundo tempo depois do primeiro gol', () => {
  const window = signalWindow(caliGame(84, [0, 1]));
  assert.equal(window.type, 'NEXT_GOAL_2H');
  assert.match(window.label, /NOVO GOL/);
});

test('mensagem alerta para gol na partida sem indicar qual equipe marcará', () => {
  const message = formatGoalAlert({
    label: 'POSSÍVEL GOL NO 2º TEMPO',
    home: 'Deportivo Cali',
    away: 'Atlético Bucaramanga',
    minute: 69,
    score: [0, 0],
    signalScore: 90,
    pressure: 70,
    stats: { shots: 14, sot: 3, xg: 1.2 },
    reasons: ['2 chutes no gol no período recente']
  });
  assert.match(message, /Deportivo Cali 0 × 0 Atlético Bucaramanga/);
  assert.match(message, /Não é garantia de gol/);
  assert.doesNotMatch(message, /Cali marcará|Bucaramanga marcará/i);
});

test('envia a mensagem pelo cliente injetado sem expor o token no corpo', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 321 } })
    };
  };
  const result = await sendTelegramMessage(
    'Sinal de teste',
    { TELEGRAM_BOT_TOKEN: 'token-secreto', TELEGRAM_CHAT_ID: '12345' },
    fakeFetch
  );
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 321);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /token-secreto\/sendMessage$/);
  assert.doesNotMatch(calls[0].options.body, /token-secreto/);
  assert.match(calls[0].options.body, /Sinal de teste/);
});

test('cron exige o segredo completo e não aceita valor aproximado', () => {
  const env = { CRON_SECRET: 'segredo-longo-e-aleatorio' };
  assert.equal(isAuthorizedCron({ headers: { authorization: 'Bearer segredo-longo-e-aleatorio' } }, env), true);
  assert.equal(isAuthorizedCron({ headers: { authorization: 'Bearer segredo-longo' } }, env), false);
  assert.equal(isAuthorizedCron({ headers: {} }, env), false);
});

test('workflow do GitHub usa segredo e não o publica no arquivo', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'monitor-live-goals.yml'),
    'utf8'
  );
  assert.match(workflow, /secrets\.RADAR_CRON_SECRET/);
  assert.match(workflow, /Authorization: Bearer \$RADAR_CRON_SECRET/);
  assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
});
