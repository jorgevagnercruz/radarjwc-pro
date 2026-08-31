const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('as faixas JWC são explicadas e usam os mesmos limites', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scanner = fs.readFileSync(path.join(root, 'api/scanner.js'), 'utf8');
  const performance = fs.readFileSync(path.join(root, 'api/performance.js'), 'utf8');

  assert.match(index, /A · 65–100/);
  assert.match(index, /B\+ · 55–64/);
  assert.match(index, /C · 0–54/);
  assert.match(index, /score>=65/);
  assert.match(index, /score>=55/);
  assert.match(scanner, /score >= 65/);
  assert.match(scanner, /score >= 55/);
  assert.match(performance, />= 65/);
  assert.match(performance, />= 55/);
});

test('o cartão explica pontuação, faixa e significado', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /ÍNDICE JWC/);
  assert.match(index, /\$\{g\.jwc\}<span>\/100<\/span>/);
  assert.match(index, /FAIXA \$\{band\.grade\}/);
  assert.match(index, /\$\{band\.label\}/);
  assert.match(index, /não é garantia nem probabilidade de acerto/);
});
