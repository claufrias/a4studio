'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { importReport } = require('../scripts/import-products.cjs');
const root = path.resolve(__dirname, '..');

function loadCatalog(source = fs.readFileSync(path.join(root, 'productos.js'), 'utf8')) {
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(source, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'product-search.js'), 'utf8'), context);
  return { products: context.A4_PRODUCT_CATALOG, ...context.A4ProductSearch };
}

const { products, catalog, createCatalog } = loadCatalog();

test('catálogo importado completo con códigos únicos y descripciones del informe', () => {
  assert.equal(products.length, 3362);
  assert.equal(new Set(products.map((product) => product.ean)).size, 3362);
  for (const product of products) {
    assert.equal(typeof product.ean, 'string');
    assert.match(product.ean, /^\d+$/);
    assert.ok(product.descripcion);
    assert.deepEqual(Object.keys(product), ['ean', 'descripcion']);
  }
  assert.equal(catalog.findByEan('7790895000997').descripcion, 'GASEOSA COLA REGULAR COCA COLA PET');
  assert.equal(catalog.findByEan('80432402733').descripcion, 'WHISKY IMPORTADO 12 ANOS CHIVAS REG');
  assert.equal(catalog.findByEan('2682850000003').descripcion, 'SERVICIO CASH BACK');
});

test('EAN exacto: conserva códigos cortos y ceros iniciales sin aceptar prefijos', () => {
  assert.equal(catalog.findByEan('1007').descripcion, 'EAN ACCION BANCARIA');
  assert.equal(catalog.findByEan('1736403').descripcion, 'ESQUELETO PLASTICO SCHNEIDER');
  for (const value of ['', '779089500', '9999999999999']) assert.equal(catalog.findByEan(value), null);
  const custom = createCatalog([{ ean: '0012345678905', descripcion: 'PRUEBA' }]);
  assert.equal(custom.findByEan('0012345678905').ean, '0012345678905');
  assert.equal(custom.findByEan('12345678905'), null);
});

test('búsqueda ignora mayúsculas y tildes, y exige todas las palabras en cualquier orden', () => {
  const custom = createCatalog([
    { ean: '001', descripcion: 'Café MOLIDO Selección' },
    { ean: '002', descripcion: 'CAFE EN GRANOS' },
    { ean: '003', descripcion: 'AZUCAR MOLIDA' },
  ]);
  assert.equal(custom.search('seleccion CÁFÉ')[0].ean, '001');
  assert.equal(custom.search('  MOLÍDO   café  ')[0].ean, '001');
  assert.equal(custom.search('cafe azucar').length, 0);
  assert.equal(custom.search('c').length, 0);
  assert.equal(custom.search('cafe', 1).length, 1);
  const realMatches = catalog.search('CÓCA regular');
  assert.ok(realMatches.length > 0);
  assert.ok(realMatches.every((product) => product.descripcion.includes('COCA')));
});

test('productos con descripción idéntica conservan sus EAN distintos', () => {
  const matches = catalog.search('GASEOSA COLA REGULAR COCA COLA PET', 100);
  const eans = new Set(matches.map((product) => product.ean));
  assert.ok(eans.has('7790895000997'));
  assert.ok(eans.has('7790895007217'));
  assert.ok(eans.has('7790895012266'));
  assert.notEqual(catalog.findByEan('7790895000997'), catalog.findByEan('7790895007217'));
});

test('importación reproducible sin depender del adjunto, con checksum informativo', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'a4studio-catalog-'));
  const input = path.join(directory, 'informe.txt');
  const output = path.join(directory, 'productos.js');
  t.after(() => {
    for (const file of [input, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  const row = (ean, descripcion) => `${ean.padStart(14)}    ${descripcion.padEnd(41)}UNI`.padEnd(130);
  const fixture = [
    '* Codigo EAN     Descripcion',
    row('0012345678900', 'CAFE MOLIDO MARCA PET X'),
    row('1007', 'EAN ACCION BANCARIA'),
    row('1007', 'EAN ACCION BANCARIA'),
  ].join('\r\n');
  fs.writeFileSync(input, fixture, 'utf8');
  const summary = importReport(input, output);
  const generated = fs.readFileSync(output, 'utf8');
  assert.equal(summary.rows, 3);
  assert.equal(summary.products, 2);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.checksum.invalid.length, 1);
  const imported = loadCatalog(generated);
  assert.equal(imported.catalog.findByEan('0012345678900').descripcion, 'CAFE MOLIDO MARCA PET X');
  assert.equal(imported.catalog.findByEan('1007').ean, '1007');
  assert.deepEqual(Object.keys(imported.products[0]), ['ean', 'descripcion']);
  importReport(input, output);
  assert.equal(fs.readFileSync(output, 'utf8'), generated);
  fs.appendFileSync(input, `\r\n${row('1007', 'DESCRIPCION EN CONFLICTO')}`);
  assert.throws(() => importReport(input, output), /descripciones distintas/);
});
