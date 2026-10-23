'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const helperNames = [
  'sanitizeEanValue', 'normalizeVigenciaObj', 'normalizeConsumoAmount',
  'createConsumoItem', 'createDefaultConsumoItems', 'normalizeConsumoItems',
  'getConsumoItemCalculations', 'formatPesos', 'formatConsumoPesos',
];

function functionSource(name) {
  const match = source.match(new RegExp(`    function ${name}\\([^]*?\\r?\\n    }`));
  assert.ok(match, `La función ${name} debe existir en el editor`);
  return match[0];
}

function loadConsumo(additionalNames = [], globals = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext('const CONSUMO_MAX_ITEMS = 4;', context);
  vm.runInContext([...helperNames, ...additionalNames].map(functionSource).join('\n'), context);
  return context;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('calcula el descuento con centavos enteros y conserva el precio final exacto', () => {
  const api = loadConsumo();
  assert.deepEqual(plain(api.getConsumoItemCalculations({ precioNormal: 2990.50, descuentoMonto: 449.25 })), {
    precioNormal: 2990.50, descuentoMonto: 449.25, precioFinal: 2541.25, porcentaje: 15,
  });
  assert.equal(api.getConsumoItemCalculations({ precioNormal: 0.30, descuentoMonto: 0.10 }).precioFinal, 0.20);
  assert.equal(api.getConsumoItemCalculations({ precioNormal: 2990, descuentoMonto: 449 }).precioFinal, 2541);
});

test('limita el descuento al precio y normaliza importes negativos, vacíos e inválidos', () => {
  const api = loadConsumo();
  assert.deepEqual(plain(api.getConsumoItemCalculations({ precioNormal: 10.25, descuentoMonto: 20.50 })), {
    precioNormal: 10.25, descuentoMonto: 10.25, precioFinal: 0, porcentaje: 100,
  });
  assert.deepEqual(plain(api.getConsumoItemCalculations({ precioNormal: -5.50, descuentoMonto: -1 })), {
    precioNormal: 0, descuentoMonto: 0, precioFinal: 0, porcentaje: 0,
  });
  assert.equal(api.getConsumoItemCalculations({ precioNormal: 10.25, descuentoMonto: -1 }).precioFinal, 10.25);
  for (const value of ['', null, undefined, NaN, Infinity, 1e308, 'no es un importe', -10]) {
    assert.equal(api.normalizeConsumoAmount(value), 0);
  }
  assert.equal(api.normalizeConsumoAmount('1234.567'), 1234.57);
});

test('guardar y normalizar páginas mantiene centavos como números y deja cuatro espacios', () => {
  const api = loadConsumo();
  const saved = JSON.stringify([api.createConsumoItem('PRODUCTO', '2990.50', '449.25', '7790895000997')]);
  const restored = api.normalizeConsumoItems(JSON.parse(saved));
  assert.equal(restored.length, 4);
  assert.equal(restored[0].precioNormal, 2990.50);
  assert.equal(restored[0].descuentoMonto, 449.25);
  assert.equal(typeof restored[0].precioNormal, 'number');
  assert.equal(restored[0].ean, '7790895000997');
  assert.equal(api.getConsumoItemCalculations(restored[0]).precioFinal, 2541.25);
  for (const empty of restored.slice(1)) assert.deepEqual(plain(empty), { nombre: '', precioNormal: 0, descuentoMonto: 0, ean: '' });
});

test('el formato argentino agrega dos decimales solo cuando los hay, sin cambiar carteles normales', () => {
  const api = loadConsumo();
  assert.equal(api.formatConsumoPesos(1234), '1.234');
  assert.equal(api.formatConsumoPesos(1234.50), '1.234,50');
  assert.equal(api.formatConsumoPesos(2541.25), '2.541,25');
  assert.equal(api.formatConsumoPesos(0), '0');
  assert.equal(api.formatConsumoPesos(0.01), '0,01');
  assert.equal(api.formatPesos(1234.50), '1.235');
});

test('la edición manual y el PVP importado conservan centavos y el descuento ingresado', () => {
  const elements = {
    consumoNombre: { value: 'PRODUCTO' }, consumoPrecioNormal: { value: '2990.50' },
    consumoDescuentoMonto: { value: '449.25' }, consumoEan: { value: '7790895000997' },
    consumoResultado: { innerHTML: '' }, vigenciaDesde: { value: '' }, vigenciaHasta: { value: '' },
  };
  const api = loadConsumo(['updateConsumoResultado', 'updateConsumoFromUI'], {
    document: { getElementById: (id) => elements[id] }, consumoItems: [], consumoActiveIndex: 0,
    isConsumoMode: () => true, updateEanInputValidation() {}, updateView() {}, captureStateChange() {},
  });
  api.updateConsumoFromUI();
  assert.equal(api.consumoItems[0].precioNormal, 2990.50);
  assert.equal(api.consumoItems[0].descuentoMonto, 449.25);
  assert.equal(elements.consumoPrecioNormal.value, '2990.50');
  assert.equal(elements.consumoResultado.innerHTML, 'Precio final: $2.541,25 · 15% descuento');
  elements.consumoPrecioNormal.value = '3100.75';
  api.updateConsumoFromUI();
  assert.equal(api.consumoItems[0].descuentoMonto, 449.25);
  assert.equal(elements.consumoResultado.innerHTML, 'Precio final: $2.651,50 · 14% descuento');
  elements.consumoPrecioNormal.value = '-1';
  api.updateConsumoFromUI();
  assert.equal(elements.consumoPrecioNormal.value, '0');
  assert.equal(api.consumoItems[0].precioNormal, 0);
  assert.match(source, /id="consumoPrecioNormal"[^>]*step="0\.01"/);
  assert.match(source, /id="consumoDescuentoMonto"[^>]*step="0\.01"/);
});

function render(items) {
  const calls = [];
  const ctx = {
    save() {}, restore() {}, drawImage() {}, beginPath() {}, stroke() {}, fill() {},
    moveTo(x, y) { calls.push({ type: 'lineStart', x, y }); },
    lineTo(x, y) { calls.push({ type: 'lineEnd', x, y }); },
    fillRect(x, y, width, height) { calls.push({ type: 'rect', color: this.fillStyle, x, y, width, height }); },
    fillText(text, x, y, maxWidth) { calls.push({ type: 'text', text, x, y, maxWidth, font: this.font }); },
    measureText(text) { return { width: text.length * Number(this.font.match(/(\d+)px/)[1]) * 0.65 }; },
  };
  const api = loadConsumo(['drawConsumoInmediatoLayout'], {
    mainCtx: ctx, consumoFondoImg: { complete: true, naturalWidth: 900 }, CANVAS_W: 900, CANVAS_H: 1200,
    consumoItems: items, vigenciaObj: {}, drawRoundedRect() {}, drawWrappedConsumoText() {}, drawValidityAndEan() {},
  });
  api.drawConsumoInmediatoLayout();
  return calls;
}

test('los espacios sin usar siguen completamente blancos y no dibujan importes', () => {
  const api = loadConsumo();
  const calls = render(api.createDefaultConsumoItems());
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.type === 'rect' && call.color === '#ffffff' && call.x === 0 && call.width === 900));
  assert.equal(calls[0].y, 0);
  for (let index = 1; index < calls.length; index += 1) assert.equal(calls[index - 1].y + calls[index - 1].height, calls[index].y);
  assert.equal(calls.at(-1).y + calls.at(-1).height, 1200);
});

test('el precio final con centavos se ajusta al ancho disponible sin ocupar logo ni pie', () => {
  const api = loadConsumo();
  const items = api.createDefaultConsumoItems();
  items[0] = api.createConsumoItem('PRODUCTO', 2990.50, 449.25, '');
  const calls = render(items);
  assert.ok(calls.some((call) => call.type === 'text' && call.text === '$2.990,50'));
  const final = calls.find((call) => call.type === 'text' && call.text === '$2.541,25');
  assert.ok(final);
  assert.equal(final.maxWidth, 346);
  assert.equal(final.x + final.maxWidth, 862);
  const size = Number(final.font.match(/(\d+)px/)[1]);
  assert.ok(size < 88 && size >= 32);
  assert.equal(final.y, 216);
  assert.equal(calls.filter((call) => call.type === 'rect').length, 3);
});

test('el precio normal y su tachado se mantienen dentro de su columna antes del precio final', () => {
  const api = loadConsumo();
  for (const price of [2990.50, 123456789012.50]) {
    const items = api.createDefaultConsumoItems();
    items[0] = api.createConsumoItem('PRODUCTO', price, 449.25, '');
    const calls = render(items);
    const normal = calls.find((call) => call.type === 'text' && call.text === `$${api.formatConsumoPesos(price)}`);
    const final = calls.find((call) => call.type === 'text' && call.text === `$${api.formatConsumoPesos(api.getConsumoItemCalculations(items[0]).precioFinal)}`);
    assert.ok(normal && final);
    assert.equal(normal.maxWidth, 138);
    assert.ok(normal.x + normal.maxWidth < final.x);
    const size = Number(normal.font.match(/(\d+)px/)[1]);
    assert.ok(size < 33 && size >= 16);
    if (price === 2990.50) assert.ok(normal.text.length * size * 0.65 <= normal.maxWidth);
    else assert.equal(size, 16);
    const lineStart = calls.find((call) => call.type === 'lineStart');
    const lineEnd = calls.find((call) => call.type === 'lineEnd');
    assert.equal(lineStart.x, normal.x);
    assert.ok(lineEnd.x <= normal.x + normal.maxWidth);
    assert.ok(lineEnd.x < final.x);
    assert.equal(lineStart.y, normal.y - size * 0.4);
    assert.equal(lineEnd.y, lineStart.y);
  }
});
