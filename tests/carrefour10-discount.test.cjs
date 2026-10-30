'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function functionSource(name) {
  const match = source.match(new RegExp(`    function ${name}\\([^]*?\\r?\\n    }`));
  assert.ok(match, `Debe existir la función ${name}`);
  return match[0];
}

function contextFor(names, globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(names.map(functionSource).join('\n'), context);
  return context;
}

test('Cuenta Digital 10% calcula el precio final con centavos sin cambiar las promociones existentes', () => {
  const api = contextFor(['calcularDescuentoPorFondo', 'calcularPrecioConDescuento', 'aplicarDescuentoAPrecio']);
  assert.equal(api.calcularDescuentoPorFondo('carrefour10'), 10);
  assert.equal(api.calcularDescuentoPorFondo('carrefour'), 15);
  assert.equal(api.calcularDescuentoPorFondo('dni'), 10);
  assert.equal(api.calcularDescuentoPorFondo('mercadopago'), 15);
  assert.equal(api.calcularDescuentoPorFondo('consumo'), 0);

  for (const [entero, centavos, expected] of [
    [2990, 50, { entero: 2691, centavos: 45 }],
    [1999, 99, { entero: 1799, centavos: 99 }],
    [0, 1, { entero: 0, centavos: 1 }],
    [0, 0, { entero: 0, centavos: 0 }]
  ]) {
    const normal = { entero, centavos };
    const offer = { entero: 0, centavos: 0, color: '#000000' };
    assert.equal(api.aplicarDescuentoAPrecio(normal, offer, 'carrefour10'), 10);
    assert.deepEqual(normal, { entero, centavos }, 'conserva el precio normal');
    assert.deepEqual(offer, { ...expected, color: '#000000' });
  }
  const previousOffer = {};
  api.aplicarDescuentoAPrecio({ entero: 1000, centavos: 0 }, previousOffer, 'carrefour');
  assert.deepEqual(previousOffer, { entero: 850, centavos: 0 });
});

test('el descuento redondea los medios centavos de forma consistente con la vista previa', () => {
  const api = contextFor(['calcularPrecioConDescuento']);
  assert.deepEqual(plain(api.calcularPrecioConDescuento(1, 15, 10)), { entero: 1, centavos: 4 });
  assert.deepEqual(plain(api.calcularPrecioConDescuento(1, 30, 15)), { entero: 1, centavos: 11 });
  assert.deepEqual(plain(api.calcularPrecioConDescuento(10, 0, 15)), { entero: 8, centavos: 50 });
});

test('la opción nueva tiene nombre y fondo propios y mantiene el fondo de 15%', () => {
  const api = contextFor(['getNombreFondo']);
  assert.match(api.getNombreFondo('carrefour10'), /Cuenta Digital.*Carrefour Banco.*10%/);
  const match = /const fondos = (\{[^]*?\n    \});/.exec(source);
  assert.ok(match);
  const backgrounds = vm.runInNewContext(`(${match[1]})`);
  assert.equal(backgrounds.carrefour10, 'fondobanco10.png');
  assert.equal(backgrounds.carrefour, 'fondobanco.jpg');
  assert.notEqual(backgrounds.carrefour10, backgrounds.carrefour);
  assert.match(source, /data-fondo-option="carrefour10"/);
});

test('Cuenta Digital ubica el código de barras abajo a la izquierda sin invadir el QR ni las fechas', () => {
  const start = source.indexOf('    const LAYOUT_LIMIT_COMPATIBLE_FONDOS');
  const end = source.indexOf('    function clampValue', start);
  assert.ok(start >= 0 && end > start);
  const api = contextFor(['getMovementZone'], { CANVAS_W: 900, fondoActual: 'carrefour10' });
  vm.runInContext(source.slice(start, end), api);
  const photo = plain(api.getMovementZone('img'));
  const footerMatch = /const standardFooterLayout = ([^]*?);\s+drawValidityAndEan/.exec(source);
  assert.ok(footerMatch);
  assert.equal(photo.y + photo.h, 980);
  assert.ok(photo.y + photo.h < 1046, 'la foto de 10% sigue por encima del QR');
  for (const type of ['carrefour10', 'carrefour']) {
    api.fondoActual = type;
    const footer = vm.runInContext(`(${footerMatch[1]})`, api);
    const photoZone = plain(api.getMovementZone('img'));
    assert.ok(footer.barcodeX - 5 >= 18, 'conserva margen izquierdo y fondo blanco');
    assert.ok(footer.barcodeX + footer.barcodeW + 5 < 235, 'el código completo queda a la izquierda del banner QR');
    assert.ok(footer.barcodeY > 1100, 'se ubica en el pie del cartel');
    assert.ok(footer.barcodeY + footer.barcodeH + 15 + 3 <= 1190, 'barras, dígitos y fondo blanco conservan margen inferior');
    assert.ok(footer.barcodeW >= 170 && footer.barcodeH >= 48, 'conserva el tamaño de las barras');
    assert.ok(footer.dateY - footer.dateSize > photoZone.y + photoZone.h, 'las fechas quedan debajo de la foto');
    assert.ok(footer.dateY < footer.barcodeY - 3, 'las fechas quedan por encima del código');
  }
  assert.equal(vm.runInContext("PROMOTION_TERMS_FONDOS.has('carrefour10')", api), false);

  for (const type of ['titulo', 'producto', 'precioNormal', 'precioOferta']) {
    api.fondoActual = 'carrefour10';
    const newZone = plain(api.getMovementZone(type));
    api.fondoActual = 'carrefour';
    assert.deepEqual(newZone, plain(api.getMovementZone(type)));
  }
});

test('guardar, restaurar y crear otra página conservan Cuenta Digital 10% y su descuento', () => {
  const names = [
    'calcularDescuentoPorFondo', 'cloneData', 'sanitizeEanValue', 'normalizeVigenciaObj',
    'normalizeConsumoAmount', 'createConsumoItem', 'createDefaultConsumoItems', 'normalizeConsumoItems',
    'normalizePriceAmount', 'normalizePriceCents', 'normalizePriceObject',
    'getNormalizedEffectFlags', 'normalizeTextEffectState', 'createPageId',
    'createBlankPageTemplate', 'normalizePageState', 'buildPageStateFromCurrent'
  ];
  const api = contextFor(names, {
    CONSUMO_MAX_ITEMS: 4, pageSequence: 1, currentPageIndex: 0,
    pages: [{ fondoActual: 'carrefour10', fondoPersonalizado: true }]
  });
  const initial = api.createBlankPageTemplate('Cuenta Digital 10%');
  Object.assign(api, initial);
  const saved = api.buildPageStateFromCurrent({ id: 'cuenta-digital-10', name: 'Cuenta Digital 10%' });
  const restored = api.normalizePageState(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.fondoActual, 'carrefour10');
  assert.equal(restored.fondoPersonalizado, true);
  assert.equal(restored.precioOfertaObj.entero, 2691);
  assert.equal(restored.precioOfertaObj.centavos, 0);
  api.pages = [restored];
  const nextPage = api.createBlankPageTemplate('Otra página');
  assert.equal(nextPage.fondoActual, 'carrefour10');
  assert.equal(nextPage.precioOfertaObj.entero, 2691);
  assert.equal(nextPage.precioOfertaObj.centavos, 0);
});
