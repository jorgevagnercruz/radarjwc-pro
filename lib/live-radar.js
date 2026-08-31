const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

function apiFootballKey(env = process.env) {
  return String(
    env.API_FOOTBALL_KEY ||
    env.API_FOOTBALL_TOKEN ||
    env.API_SPORTS_KEY ||
    env.FOOTBALL_API_TOKEN ||
    ''
  ).trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeType(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function emptyStats() {
  return {
    shots: null,
    sot: null,
    off: null,
    inside: null,
    big: null,
    xg: null,
    attacks: null,
    danger: null,
    corners: null,
    possession: null,
    red: null
  };
}

function sportmonksStatMap(fixture, participantId) {
  const values = [];
  for (const stat of fixture.statistics || []) {
    if (Number(stat.participant_id) !== Number(participantId)) continue;
    const name = normalizeType(stat.type?.name || stat.type?.developer_name);
    const value = numberOrNull(stat.data?.value ?? stat.value ?? stat.data);
    if (name && value !== null) values.push({ name, value });
  }

  const find = (required, excluded = []) => {
    const item = values.find(entry =>
      required.every(part => entry.name.includes(part)) &&
      excluded.every(part => !entry.name.includes(part))
    );
    return item ? item.value : null;
  };

  return {
    shots: find(['shots', 'total']) ?? find(['total', 'shots']) ?? find(['shots'], ['target', 'inside', 'outside', 'blocked']),
    sot: find(['shots', 'target']) ?? find(['on', 'target']),
    off: find(['shots', 'off', 'target']) ?? find(['shots', 'outside']),
    inside: find(['shots', 'inside']) ?? find(['inside', 'box']),
    big: find(['big', 'chances']),
    xg: find(['expected', 'goals']) ?? find(['xg']),
    attacks: find(['attacks'], ['dangerous']),
    danger: find(['dangerous', 'attacks']),
    corners: find(['corners']) ?? find(['corner', 'kicks']),
    possession: find(['possession']),
    red: find(['red', 'cards']) ?? find(['redcards'])
  };
}

function apiFootballStats(rows, teamId) {
  const team = (rows || []).find(entry => Number(entry.team?.id) === Number(teamId));
  if (!team) return emptyStats();
  const values = new Map();
  for (const stat of team.statistics || []) {
    const name = normalizeType(stat.type);
    const value = numberOrNull(stat.value);
    if (name && value !== null) values.set(name, value);
  }
  const get = (...names) => {
    for (const name of names) {
      const value = values.get(normalizeType(name));
      if (value !== undefined) return value;
    }
    return null;
  };
  return {
    shots: get('Total Shots'),
    sot: get('Shots on Goal'),
    off: get('Shots off Goal'),
    inside: get('Shots insidebox', 'Shots inside box'),
    big: get('Big Chances'),
    xg: get('Expected Goals', 'expected_goals'),
    attacks: get('Attacks'),
    danger: get('Dangerous Attacks'),
    corners: get('Corner Kicks'),
    possession: get('Ball Possession'),
    red: get('Red Cards')
  };
}

function pairTotal(home, away, field) {
  const homeValue = numberOrNull(home?.[field]);
  const awayValue = numberOrNull(away?.[field]);
  if (homeValue === null || awayValue === null) return null;
  return homeValue + awayValue;
}

function pressureScore(home, away, minute) {
  const metrics = [
    { value: pairTotal(home, away, 'shots'), target: 20, weight: 22 },
    { value: pairTotal(home, away, 'sot'), target: 8, weight: 24 },
    { value: pairTotal(home, away, 'inside'), target: 14, weight: 20 },
    { value: pairTotal(home, away, 'big'), target: 4, weight: 14 },
    { value: pairTotal(home, away, 'danger'), target: 80, weight: 10 },
    { value: pairTotal(home, away, 'corners'), target: 10, weight: 10 }
  ];

  let availableWeight = 0;
  let earned = 0;
  for (const metric of metrics) {
    if (metric.value === null) continue;
    availableWeight += metric.weight;
    earned += Math.min(Math.max(metric.value, 0) / metric.target, 1) * metric.weight;
  }

  const statsCoverage = Math.round(availableWeight);
  if (availableWeight < 45) {
    return { pressure: null, statsCoverage, signal: '⏳ DADOS INSUFICIENTES' };
  }

  const minuteBonus = Number(minute) >= 55 && Number(minute) <= 80 ? 4 : 0;
  const pressure = Math.max(0, Math.min(100, Math.round((earned / availableWeight) * 96 + minuteBonus)));
  return { pressure, statsCoverage, signal: signalFor(pressure) };
}

function signalFor(pressure) {
  if (!Number.isFinite(pressure)) return '⏳ DADOS INSUFICIENTES';
  if (pressure >= 80) return '🔥 FORTE PRESSÃO PARA GOL';
  if (pressure >= 65) return '🟢 BOM SINAL';
  if (pressure >= 50) return '🟡 MONITORAR';
  return '⚪ SEM SINAL FORTE';
}

function sportmonksHomeAway(fixture) {
  const participants = fixture.participants || [];
  return {
    home: participants.find(item => item.meta?.location === 'home'),
    away: participants.find(item => item.meta?.location === 'away')
  };
}

function sportmonksScore(fixture, participantId) {
  const current = (fixture.scores || [])
    .filter(score => Number(score.participant_id) === Number(participantId))
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
  return Number(current?.score?.goals ?? current?.score?.participant ?? 0) || 0;
}

function mapSportmonksFixture(fixture) {
  const { home, away } = sportmonksHomeAway(fixture);
  if (!home || !away) return null;
  const activePeriod = (fixture.periods || []).find(period => period.ticking) ||
    [...(fixture.periods || [])].sort((a, b) => Number(b.sort_order || 0) - Number(a.sort_order || 0))[0] || {};
  const minute = Number(activePeriod.minutes || 0);
  const homeStats = sportmonksStatMap(fixture, home.id);
  const awayStats = sportmonksStatMap(fixture, away.id);
  const index = pressureScore(homeStats, awayStats, minute);
  return {
    id: `sportmonks:${fixture.id}`,
    dbId: Number(fixture.id),
    externalId: Number(fixture.id),
    provider: 'sportmonks',
    providerLabel: 'Sportmonks',
    league: fixture.league?.name || 'Competição',
    starting_at: fixture.starting_at,
    period: fixture.state?.short_name || fixture.state?.name || 'LIVE',
    home: home.name,
    away: away.name,
    minute,
    score: [sportmonksScore(fixture, home.id), sportmonksScore(fixture, away.id)],
    homeStats,
    awayStats,
    ...index
  };
}

function mapApiFootballFixture(fixture, statRows = []) {
  const externalId = Number(fixture.fixture?.id);
  const home = fixture.teams?.home;
  const away = fixture.teams?.away;
  if (!Number.isFinite(externalId) || !home || !away) return null;
  const minute = Number(fixture.fixture?.status?.elapsed || 0);
  const homeStats = apiFootballStats(statRows, home.id);
  const awayStats = apiFootballStats(statRows, away.id);
  const index = pressureScore(homeStats, awayStats, minute);
  return {
    id: `api-football:${externalId}`,
    dbId: -Math.abs(externalId),
    externalId,
    provider: 'api-football',
    providerLabel: 'API-Football',
    league: fixture.league?.name || 'Competição',
    starting_at: fixture.fixture?.date,
    period: fixture.fixture?.status?.short || 'LIVE',
    home: home.name,
    away: away.name,
    minute,
    score: [Number(fixture.goals?.home || 0), Number(fixture.goals?.away || 0)],
    homeStats,
    awayStats,
    ...index
  };
}

function normalizeTeam(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|club|futebol|football)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dedupeGames(games) {
  const selected = new Map();
  for (const game of (games || []).filter(Boolean)) {
    const key = `${normalizeTeam(game.home)}|${normalizeTeam(game.away)}`;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, game);
      continue;
    }
    const gameHasStats = Number.isFinite(game.pressure);
    const currentHasStats = Number.isFinite(current.pressure);
    if ((gameHasStats && !currentHasStats) ||
        (gameHasStats === currentHasStats && game.provider === 'sportmonks')) {
      selected.set(key, game);
    }
  }
  return [...selected.values()].sort((a, b) => {
    const pressureA = Number.isFinite(a.pressure) ? a.pressure : -1;
    const pressureB = Number.isFinite(b.pressure) ? b.pressure : -1;
    return pressureB - pressureA || Number(b.minute || 0) - Number(a.minute || 0);
  });
}

function isStatsCandidate(fixture) {
  const minute = Number(fixture.fixture?.status?.elapsed || 0);
  const short = String(fixture.fixture?.status?.short || '');
  return minute >= 10 && minute <= 90 && !['HT', 'BT', 'P', 'INT'].includes(short);
}

async function fetchJson(url, options, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      body = {};
    }
    if (!response.ok) {
      const error = new Error(body?.message || `${provider} HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (provider === 'API-Football' && body?.errors && Object.keys(body.errors).length) {
      const details = Object.values(body.errors).flat().filter(Boolean).join('; ');
      const error = new Error(details || 'API-Football recusou a consulta.');
      error.status = 502;
      throw error;
    }
    const headerNumber = name => {
      const value = response.headers?.get?.(name);
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    body.__rateLimit = {
      dailyLimit: headerNumber('x-ratelimit-requests-limit'),
      dailyRemaining: headerNumber('x-ratelimit-requests-remaining'),
      minuteLimit: headerNumber('x-ratelimit-limit'),
      minuteRemaining: headerNumber('x-ratelimit-remaining')
    };
    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error(`${provider} demorou mais de 12 segundos.`);
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSportmonksLive(token) {
  const url = new URL('https://api.sportmonks.com/v3/football/livescores/inplay');
  url.searchParams.set('api_token', token);
  url.searchParams.set('include', 'scores;participants;statistics.type;periods;state;league');
  const body = await fetchJson(url, {}, 'Sportmonks');
  return (body.data || []).map(mapSportmonksFixture).filter(Boolean);
}

async function fetchApiFootballFixtures(key) {
  const url = new URL('/fixtures', API_FOOTBALL_BASE);
  url.searchParams.set('live', 'all');
  const body = await fetchJson(url, {
    headers: { 'x-apisports-key': key }
  }, 'API-Football');
  const rows = body.response || [];
  Object.defineProperty(rows, 'rateLimit', { value: body.__rateLimit || {}, enumerable: false });
  return rows;
}

async function fetchApiFootballStatistics(key, fixtureId) {
  const url = new URL('/fixtures/statistics', API_FOOTBALL_BASE);
  url.searchParams.set('fixture', String(fixtureId));
  const body = await fetchJson(url, {
    headers: { 'x-apisports-key': key }
  }, 'API-Football');
  const rows = body.response || [];
  Object.defineProperty(rows, 'rateLimit', { value: body.__rateLimit || {}, enumerable: false });
  return rows;
}

module.exports = {
  apiFootballKey,
  emptyStats,
  apiFootballStats,
  sportmonksStatMap,
  pressureScore,
  signalFor,
  mapSportmonksFixture,
  mapApiFootballFixture,
  dedupeGames,
  isStatsCandidate,
  fetchSportmonksLive,
  fetchApiFootballFixtures,
  fetchApiFootballStatistics
};
