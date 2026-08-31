const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  apiFootballKey,
  pressureScore,
  mapApiFootballFixture,
  dedupeGames,
  fetchApiFootballFixtures,
  fetchApiFootballStatistics
} = require('../lib/live-radar');

function fixture() {
  return {
    fixture: {
      id: 12345,
      date: '2026-08-19T22:00:00Z',
      status: { short: '2H', elapsed: 63 }
    },
    league: { name: 'Liga de Teste' },
    teams: {
      home: { id: 10, name: 'Time Casa' },
      away: { id: 20, name: 'Time Fora' }
    },
    goals: { home: 1, away: 1 }
  };
}

function statistics() {
  const rows = (team, shots, sot, inside, corners, possession, xg) => ({
    team,
    statistics: [
      { type: 'Total Shots', value: shots },
      { type: 'Shots on Goal', value: sot },
      { type: 'Shots insidebox', value: inside },
      { type: 'Corner Kicks', value: corners },
      { type: 'Ball Possession', value: `${possession}%` },
      { type: 'Expected Goals', value: xg }
    ]
  });
  return [
    rows({ id: 10, name: 'Time Casa' }, 12, 5, 8, 6, 55, 1.25),
    rows({ id: 20, name: 'Time Fora' }, 8, 3, 6, 4, 45, 0.2)
  ];
}

test('a chave da API-Football fica separada do football-data.org', () => {
  assert.equal(apiFootballKey({ FOOTBALL_DATA_TOKEN: 'token-antigo' }), '');
  assert.equal(apiFootballKey({ API_FOOTBALL_KEY: 'token-novo' }), 'token-novo');
  assert.equal(apiFootballKey({ API_SPORTS_KEY: 'alias-seguro' }), 'alias-seguro');
});

test('mapeia as estatísticas da API-Football e normaliza o índice pela cobertura disponível', () => {
  const game = mapApiFootballFixture(fixture(), statistics());
  assert.equal(game.provider, 'api-football');
  assert.equal(game.dbId, -12345);
  assert.deepEqual(game.score, [1, 1]);
  assert.equal(game.homeStats.shots, 12);
  assert.equal(game.awayStats.possession, 45);
  assert.equal(game.homeStats.xg, 1.25);
  assert.equal(game.statsCoverage, 76);
  assert.equal(game.pressure, 100);
  assert.match(game.signal, /FORTE PRESSÃO/);
});

test('não cria sinal quando a fonte não entregou estatísticas suficientes', () => {
  const result = pressureScore(
    { shots: 7, sot: null, inside: null, big: null, danger: null, corners: null },
    { shots: 5, sot: null, inside: null, big: null, danger: null, corners: null },
    40
  );
  assert.equal(result.pressure, null);
  assert.equal(result.statsCoverage, 22);
  assert.match(result.signal, /DADOS INSUFICIENTES/);
});

test('remove duplicidade entre fontes e conserva o jogo com melhor cobertura', () => {
  const common = {
    home: 'Clube Atlético FC',
    away: 'União Club',
    minute: 60,
    score: [0, 0]
  };
  const games = dedupeGames([
    { ...common, id: 'api-football:1', provider: 'api-football', pressure: null },
    { ...common, id: 'sportmonks:2', provider: 'sportmonks', pressure: 71 }
  ]);
  assert.equal(games.length, 1);
  assert.equal(games[0].provider, 'sportmonks');
  assert.equal(games[0].pressure, 71);
});

test('consulta os endpoints oficiais com a chave somente no cabeçalho', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const response = String(url).includes('/statistics') ? statistics() : [fixture()];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response, errors: [] })
    };
  };
  try {
    const fixtures = await fetchApiFootballFixtures('segredo');
    const stats = await fetchApiFootballStatistics('segredo', 12345);
    assert.equal(fixtures.length, 1);
    assert.equal(stats.length, 2);
    assert.match(calls[0].url, /\/fixtures\?live=all/);
    assert.match(calls[1].url, /\/fixtures\/statistics\?fixture=12345/);
    assert.equal(calls[0].options.headers['x-apisports-key'], 'segredo');
    assert.doesNotMatch(calls[0].url, /segredo/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a interface explica cobertura, filtros e intervalo de atualização', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(index, /RADAR MULTIFONTE/);
  assert.match(index, /Radar de gol/);
  assert.match(index, /lGoalSignals/);
  assert.match(index, /goalSignal/);
  assert.match(index, /Telegram: ativo/);
  assert.match(index, /xG quando disponível/);
  assert.match(index, /Dentro do padrão · 50\+/);
  assert.match(index, /Pressão forte · 80\+/);
  assert.match(index, /Com estatísticas/);
  assert.match(index, /API_FOOTBALL_KEY/);
  assert.match(index, /setInterval\(live,60000\)/);
});
