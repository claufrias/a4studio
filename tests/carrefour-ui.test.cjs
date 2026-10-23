'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const functionStart = /\bfunction\s+setCarrefourStatus\s*\(/.exec(html);
const listenerStart = /document\.getElementById\(\s*(['"])carrefourConnect\1\s*\)\.addEventListener\s*\(/;
assert.ok(functionStart, 'Las funciones de integración de Carrefour360 deben existir.');
const integrationTail = html.slice(functionStart.index);
const listener = listenerStart.exec(integrationTail);
assert.ok(listener, 'La integración debe terminar antes de registrar el botón de conexión.');
const integrationSource = integrationTail.slice(0, listener.index);

function makeError(code) {
  return Object.assign(new Error(`No se pudo completar la consulta: ${code}.`), { code });
}

function product(overrides = {}) {
  return { ean: '0012345678905', descripcion: 'CAFÉ MOLIDO SELECCIÓN 250 G',
    precioNormalCentavos: 254150, consultadoEn: '2026-10-23T14:22:33.000Z',
    source: 'Carrefour360', tienda: null, ...overrides };
}

function setup(options = {}) {
  const elements = new Map();
  const initial = {
    productoEan: '0012345678905', producto: 'Nombre original\nen dos líneas',
    precioNormalEntero: '2990', precioNormalCentavos: '00',
    consumoEan: '0012345678905', consumoNombre: 'Nombre consumo original',
    consumoPrecioNormal: '3500', consumoDescuentoMonto: '1500.25',
    productoFont: 'Arial', productoSize: '40'
  };
  for (const [id, value] of Object.entries(initial)) elements.set(id, { value });
  for (const id of ['carrefourConnect', 'carrefourRefresh', 'carrefourStatus', 'carrefourAuto']) {
    elements.set(id, { value: '', textContent: '', dataset: {}, disabled: false, checked: true });
  }
  const document = { getElementById(id) {
    assert.ok(elements.has(id), `Elemento esperado: ${id}`);
    return elements.get(id);
  } };
  const timers = new Map();
  let nextTimer = 0;
  const requests = [];
  const events = [];
  const field = (id) => document.getElementById(id);
  const values = () => Object.fromEntries([...elements].filter(([, element]) => 'value' in element)
    .map(([id, element]) => [id, element.value]));
  const carrefourClient = {
    lookup(ean) {
      return new Promise((resolve, reject) => {
        const request = { ean, settled: false,
          resolve(value) { request.settled = true; resolve(value); },
          reject(error) { request.settled = true; reject(error); } };
        requests.push(request);
      });
    },
    cancelPending() {
      if (options.ignoreTransportCancellation) return;
      for (const request of requests) if (!request.settled) request.reject(makeError('CANCELLED'));
    }
  };
  const environment = {
    document, carrefourClient,
    carrefourConnected: true, carrefourConnecting: false,
    carrefourLookupPending: false, carrefourLookupTimer: null, carrefourLookupGeneration: 0,
    pages: [{ id: 'page-1' }, { id: 'page-2' }], currentPageIndex: 0, consumoActiveIndex: 0,
    mode: options.mode || 'normal',
    isRestoringState: false, historyTransitionInProgress: false, activeEditor: null,
    productoObj: { width: 300, fontSize: 40 },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    sanitizeEanValue(value) { return String(value || '').replace(/\D/g, '').slice(0, 14); },
    isValidEanLength(value) { return value.length === 8 || value.length === 13; },
    productSearch: { catalog: { findByEan: () => null } },
    getMovementZone: () => null,
    formatNumberWithDots(value) { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); },
    flushPendingHistory() { events.push({ type: 'history', values: values() }); },
    updateFromUI() { events.push({ type: 'normal', values: values() }); },
    updateConsumoFromUI() { events.push({ type: 'consumo', values: values() }); }
  };
  environment.isConsumoMode = () => environment.mode === 'consumo';
  const context = vm.createContext(environment);
  vm.runInContext(integrationSource, context, { filename: 'index.html:carrefour-integration' });
  context.syncCarrefourControls();
  return { context, field, values, requests, events, timers };
}

test('aplica descripción y PVP con centavos en el cartel normal, guardando antes el estado previo', async () => {
  const { context, field, requests, events } = setup();
  const refresh = context.refreshCarrefourProduct();
  assert.equal(requests[0].ean, '0012345678905');
  assert.equal(context.carrefourLookupPending, true);
  assert.equal(field('carrefourRefresh').disabled, true);
  requests[0].resolve(product());
  await refresh;
  assert.equal(field('producto').value, product().descripcion);
  assert.equal(field('precioNormalEntero').value, '2541');
  assert.equal(field('precioNormalCentavos').value, '50');
  assert.deepEqual(events.map((event) => event.type), ['history', 'normal']);
  assert.equal(events[0].values.producto, 'Nombre original\nen dos líneas');
  assert.equal(events[0].values.precioNormalEntero, '2990');
  assert.equal(events[1].values.precioNormalCentavos, '50');
  assert.equal(field('carrefourStatus').dataset.state, 'connected');
  assert.match(field('carrefourStatus').textContent, /2\.541,50/);
  assert.equal(context.carrefourLookupPending, false);
  assert.equal(field('carrefourRefresh').disabled, false);
});

test('Consumo inmediato recibe el PVP y conserva el descuento que se editó durante la consulta', async () => {
  const { context, field, requests, events } = setup({ mode: 'consumo' });
  const refresh = context.refreshCarrefourProduct();
  field('consumoDescuentoMonto').value = '875.35';
  requests[0].resolve(product());
  await refresh;
  assert.equal(field('consumoNombre').value, product().descripcion);
  assert.equal(field('consumoPrecioNormal').value, '2541.5');
  assert.equal(field('consumoDescuentoMonto').value, '875.35');
  assert.deepEqual(events.map((event) => event.type), ['history', 'consumo']);
  assert.equal(events[1].values.consumoDescuentoMonto, '875.35');
  assert.equal(field('producto').value, 'Nombre original\nen dos líneas');
  assert.equal(field('precioNormalEntero').value, '2990');
});

for (const change of ['page', 'slot', 'ean', 'mode']) {
  test(`una respuesta tardía no aplica al cambiar ${change}`, async () => {
    const { context, field, values, requests, events } = setup({ mode: change === 'slot' ? 'consumo' : 'normal' });
    const refresh = context.refreshCarrefourProduct();
    if (change === 'page') context.currentPageIndex = 1;
    if (change === 'slot') context.consumoActiveIndex = 1;
    if (change === 'ean') field('productoEan').value = '7790000000001';
    if (change === 'mode') context.mode = 'consumo';
    field('producto').value = 'Producto visible actual';
    field('precioNormalEntero').value = '7700';
    field('consumoNombre').value = 'Espacio visible actual';
    field('consumoPrecioNormal').value = '6600.20';
    const before = values();
    requests[0].resolve(product());
    await refresh;
    assert.deepEqual(values(), before);
    assert.equal(events.length, 0);
    assert.equal(context.carrefourLookupPending, false);
  });
}

for (const change of ['entero', 'centavos', 'consumo']) {
  test(`respeta el precio ${change} modificado mientras Pricing respondía`, async () => {
    const { context, field, values, requests, events } = setup({ mode: change === 'consumo' ? 'consumo' : 'normal' });
    const refresh = context.refreshCarrefourProduct();
    const id = change === 'consumo' ? 'consumoPrecioNormal' : change === 'centavos' ? 'precioNormalCentavos' : 'precioNormalEntero';
    field(id).value = change === 'centavos' ? '99' : '5000';
    const before = values();
    requests[0].resolve(product());
    await refresh;
    assert.deepEqual(values(), before);
    assert.equal(events.length, 0);
    assert.equal(context.carrefourLookupPending, false);
    assert.equal(field('carrefourStatus').dataset.state, 'idle');
  });
}

for (const mode of ['normal', 'consumo']) {
  test(`conserva el nombre y sus saltos de línea editados en ${mode}, aplicando el nuevo precio`, async () => {
    const { context, field, requests, events } = setup({ mode });
    const refresh = context.refreshCarrefourProduct();
    const nameId = mode === 'consumo' ? 'consumoNombre' : 'producto';
    field(nameId).value = 'Mi nombre\ncon formato propio';
    requests[0].resolve(product());
    await refresh;
    assert.equal(field(nameId).value, 'Mi nombre\ncon formato propio');
    assert.equal(field(mode === 'consumo' ? 'consumoPrecioNormal' : 'precioNormalEntero').value,
      mode === 'consumo' ? '2541.5' : '2541');
    assert.equal(events.at(-1).type, mode === 'consumo' ? 'consumo' : 'normal');
  });
}

for (const flag of ['isRestoringState', 'historyTransitionInProgress', 'activeEditor']) {
  test(`no aplica datos mientras hay ${flag}`, async () => {
    const { context, values, requests, events } = setup();
    const refresh = context.refreshCarrefourProduct();
    context[flag] = flag === 'activeEditor' ? { value: 'Editando' } : true;
    const before = values();
    requests[0].resolve(product());
    await refresh;
    assert.deepEqual(values(), before);
    assert.equal(events.length, 0);
    assert.equal(context.carrefourLookupPending, false);
  });
}

for (const code of ['PRODUCT_NOT_FOUND', 'PRICING_TIMEOUT', 'TIMEOUT', 'INVALID_RESPONSE']) {
  test(`un error ${code} conserva el cartel y permite volver a consultar`, async () => {
    const { context, field, values, requests, events } = setup();
    const before = values();
    const refresh = context.refreshCarrefourProduct();
    requests[0].reject(makeError(code));
    await refresh;
    assert.deepEqual(values(), before);
    assert.equal(events.length, 0);
    assert.equal(context.carrefourConnected, true);
    assert.equal(context.carrefourLookupPending, false);
    assert.equal(field('carrefourStatus').dataset.state, 'error');
    assert.equal(field('carrefourRefresh').disabled, false);
  });
}

for (const code of ['LOGIN_REQUIRED', 'PRICING_NOT_OPEN', 'PRICING_NOT_READY', 'EXTENSION_UNAVAILABLE', 'CONNECTION_ERROR']) {
  test(`un error de sesión o puente ${code} vuelve a habilitar Conectar sin cambiar el cartel`, async () => {
    const { context, field, values, requests, events } = setup();
    const before = values();
    const refresh = context.refreshCarrefourProduct();
    requests[0].reject(makeError(code));
    await refresh;
    assert.deepEqual(values(), before);
    assert.equal(events.length, 0);
    assert.equal(context.carrefourConnected, false);
    assert.equal(context.carrefourLookupPending, false);
    assert.equal(field('carrefourRefresh').disabled, true);
    assert.equal(field('carrefourAuto').disabled, true);
    assert.equal(field('carrefourConnect').disabled, false);
    assert.equal(field('carrefourStatus').dataset.state, 'error');
  });
}

test('cancelar una consulta limpia el estado pendiente y no muestra su error de cancelación', async () => {
  const { context, field, values, requests, events, timers } = setup();
  const before = values();
  const refresh = context.refreshCarrefourProduct();
  assert.equal(context.carrefourLookupPending, true);
  context.cancelCarrefourLookup(true);
  await refresh;
  assert.equal(requests[0].settled, true);
  assert.deepEqual(values(), before);
  assert.equal(events.length, 0);
  assert.equal(context.carrefourLookupPending, false);
  assert.equal(context.carrefourLookupTimer, null);
  assert.equal(timers.size, 0);
  assert.equal(field('carrefourStatus').dataset.state, 'connected');
  assert.equal(field('carrefourRefresh').disabled, false);
});

test('una respuesta anterior no elimina el estado pendiente de una consulta nueva', async () => {
  const { context, field, requests, events } = setup({ ignoreTransportCancellation: true });
  const first = context.refreshCarrefourProduct();
  field('productoEan').value = '7790000000001';
  const second = context.refreshCarrefourProduct();
  requests[0].resolve(product());
  await first;
  assert.equal(context.carrefourLookupPending, true);
  assert.equal(field('carrefourRefresh').disabled, true);
  assert.equal(events.length, 0);
  requests[1].resolve(product({ ean: '7790000000001', descripcion: 'PRODUCTO MÁS RECIENTE', precioNormalCentavos: 100099 }));
  await second;
  assert.equal(field('producto').value, 'PRODUCTO MÁS RECIENTE');
  assert.equal(field('precioNormalEntero').value, '1000');
  assert.equal(field('precioNormalCentavos').value, '99');
  assert.equal(context.carrefourLookupPending, false);
});

test('desactivar la consulta automática cancela el plazo sin iniciar una consulta', () => {
  const { context, field, requests, timers } = setup();
  context.scheduleCarrefourLookup();
  assert.equal(timers.size, 1);
  field('carrefourAuto').checked = false;
  context.cancelCarrefourLookup();
  assert.equal(timers.size, 0);
  assert.equal(context.carrefourLookupTimer, null);
  assert.equal(context.carrefourLookupPending, false);
  assert.equal(requests.length, 0);
  assert.equal(field('carrefourStatus').dataset.state, 'connected');
});

test('un GTIN de 14 dígitos se consulta completo mediante la entrada automática', async () => {
  const { context, field, requests, timers } = setup();
  const ean = '10012345678905';
  field('productoEan').value = ean;
  context.scheduleCarrefourLookup();
  assert.equal(timers.size, 1);
  const timer = timers.values().next().value;
  const refresh = timer.callback();
  assert.equal(requests[0].ean, ean);
  requests[0].resolve(product({ ean }));
  await refresh;
  assert.equal(field('productoEan').value, ean);
  assert.equal(field('producto').value, product().descripcion);
});
