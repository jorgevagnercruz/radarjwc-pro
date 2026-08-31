const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('os filtros informam qual conjunto de palpites está sendo exibido', () => {
  assert.match(index, /id="filterTitle">Todos os jogos analisados/);
  assert.match(index, /id="filterCount">0 partidas encontradas/);
  assert.match(index, /aria-live="polite"/);
  assert.match(index, /Palpites para \+1\.5 gols no jogo/);
  assert.match(index, /Palpites para gol no 1º tempo/);
  assert.match(index, /Palpites Bingo JWC/);
});

test('o cartão destaca o palpite correspondente ao filtro escolhido', () => {
  assert.match(index, /function filterPick\(g\)/);
  assert.match(index, /\+1\.5 GOLS NO JOGO \(FT\)/);
  assert.match(index, /GOL NO 1º TEMPO \(HT\)/);
  assert.match(index, /FAIXA A · ÍNDICE JWC/);
  assert.match(index, /PALPITE SELECIONADO/);
  assert.match(index, /p\.valueClass/);
});

test('os cortes permanecem consistentes e o clique ajusta a ordenação', () => {
  assert.match(index, /FILTER==='o15'\)return Number\.isFinite\(g\.metrics\.o15\.pct\)&&g\.metrics\.o15\.pct>=80/);
  assert.match(index, /FILTER==='ht'\)return Number\.isFinite\(g\.metrics\.ht\.pct\)&&g\.metrics\.ht\.pct>=60/);
  assert.match(index, /FILTER==='bingo'\)return Number\.isFinite\(g\.bingo\)&&g\.bingo>=35/);
  assert.match(index, /\$\('#sort'\)\.value=FILTER_INFO\[FILTER\]\.sort/);
  assert.match(index, /setAttribute\('aria-pressed','true'\)/);
});

test('clicar em +1.5 renderiza somente os palpites correspondentes', () => {
  const source = index.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {
    '#date': {},
    '#perfDate': {},
    '#sort': { value: 'jwc' },
    '#filterTitle': { textContent: '' },
    '#filterCount': { textContent: '' },
    '#games': { innerHTML: '' }
  };
  const makeButton = (filter) => ({
    dataset: { f: filter },
    classList: { add() {}, remove() {} },
    setAttribute() {}
  });
  const filters = ['all', 'strong', 'o15', 'ht', 'bingo'].map(makeButton);
  const document = {
    querySelector: (selector) => elements[selector],
    querySelectorAll: (selector) => selector === '.filter[data-f]' ? filters : []
  };
  const context = { document, Intl, Date, fetch() {} };
  vm.createContext(context);

  const metric = (pct) => ({ pct, hits: Math.round(pct / 5) });
  const fixture = (home, o15) => ({
    league: 'Liga de teste',
    home,
    away: 'Visitante',
    starting_at: '2026-08-19T19:00:00Z',
    jwc: o15,
    bingo: 40,
    metrics: {
      sample: 20,
      o15: metric(o15),
      ht: metric(60),
      o25: metric(50),
      btts: metric(50),
      sh15: metric(30),
      avgGoals: 2.4
    },
    teamAverages: {},
    forms: { home: 'WDL', away: 'DLW' }
  });
  const scenario = source.replace(/boot\(\)\s*$/, `
    DATA = [${JSON.stringify(fixture('Aprovado', 85))}, ${JSON.stringify(fixture('Reprovado', 75))}];
    document.querySelectorAll('.filter[data-f]')[2].onclick();
    globalThis.result = {
      title: document.querySelector('#filterTitle').textContent,
      count: document.querySelector('#filterCount').textContent,
      sort: document.querySelector('#sort').value,
      cards: document.querySelector('#games').innerHTML
    };
  `);

  new vm.Script(scenario).runInContext(context);
  assert.equal(context.result.title, 'Palpites para +1.5 gols no jogo');
  assert.equal(context.result.count, '1 partida encontrada');
  assert.equal(context.result.sort, 'o15');
  assert.match(context.result.cards, /Aprovado/);
  assert.doesNotMatch(context.result.cards, /Reprovado/);
  assert.match(context.result.cards, /\+1\.5 GOLS NO JOGO \(FT\)/);
  assert.match(context.result.cards, /85% histórico/);
});
