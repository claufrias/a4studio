'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const worker = require('../extensions/carrefour360/service-worker.js');
const bridge = require('../extensions/carrefour360/a4-bridge.js');
const pricing = require('../extensions/carrefour360/pricing-content.js');

const PRICING_URL = 'https://carrefour360.carrefour.com.ar/pricing';
const EAN = '7790895000997';
const sender = { url: 'https://claufrias.github.io/a4studio/', frameId: 0, tab: { id: 20 } };
const request = (action, extra = {}) => ({ channel: worker.CHANNEL, version: 1, id: 'test-1', action, ...extra });
const product = (ean = EAN) => ({
  ean, descripcion: 'GASEOSA COLA REGULAR COCA COLA PET X 2.25 LT',
  precioNormalCentavos: 600000, consultadoEn: '2026-10-23T12:00:00.000Z', source: 'Carrefour360', tienda: null
});

function mockBrowser(overrides = {}) {
  return { tabs: {
    query: async () => [{ id: 7, url: PRICING_URL }],
    get: async (id) => ({ id, url: PRICING_URL }),
    create: async () => ({}),
    sendMessage: async (_, message) => message.action === 'status'
      ? { ok: true, result: { ready: true } } : { ok: true, result: product(message.ean) },
    ...overrides
  } };
}

function pricingFixture() {
  const state = { description: { textContent: 'RESULTADO ANTERIOR' }, price: { getAttribute: () => '1.00', textContent: '$ 1.00' } };
  const inputListeners = new Map();
  const input = {
    value: '1234',
    addEventListener: (name, listener) => inputListeners.set(name, listener),
    removeEventListener: (name, listener) => { if (inputListeners.get(name) === listener) inputListeners.delete(name); }
  };
  const loading = { style: { display: 'none', visibility: 'visible' } };
  const content = { querySelector: (selector) => selector === '#description' ? state.description : selector === '#td_data' ? state.price : null };
  let clicks = 0;
  const button = { click: () => { clicks += 1; } };
  const document = {
    documentElement: {},
    querySelector: (selector) => ({ '#ean_product_value': input, '#btn_ean_product': button, '#pricing_content': content, '#loadingContainer': loading }[selector] || null)
  };
  let observer;
  let timeout;
  let disconnected = false;
  const environment = {
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    setTimeout: (callback) => { timeout = callback; return 1; },
    clearTimeout: () => { timeout = null; },
    getComputedStyle: (element) => element.style
  };
  return {
    state, input, content, button, loading, document, environment,
    mutate: () => observer(), expire: () => timeout(),
    clicks: () => clicks, disconnected: () => disconnected,
    editInput: (value, event = 'input') => { input.value = value; inputListeners.get(event)?.(); },
    inputListenerCount: () => inputListeners.size
  };
}

test('manifest limita hosts y rutas sin permisos para sesiones o escritura', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extensions/carrefour360/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.3');
  assert.deepEqual(manifest.host_permissions, [
    'https://carrefour360.carrefour.com.ar/*', 'https://claufrias.github.io/a4studio/*',
    'http://localhost/a4studio/*', 'http://127.0.0.1/a4studio/*'
  ]);
  assert.deepEqual(manifest.permissions, ['scripting']);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://claufrias.github.io/a4studio/*', 'http://localhost/a4studio/*', 'http://127.0.0.1/a4studio/*'
  ]);
  assert.deepEqual(manifest.content_scripts[1].matches, ['https://carrefour360.carrefour.com.ar/pricing*']);
  assert.ok(manifest.content_scripts.every((script) => script.all_frames === false));
});

test('origen, ruta, frame y DTO impiden consultas desde sitios ajenos', async () => {
  for (const url of [
    'https://claufrias.github.io/otro/', 'https://claufrias.github.io/a4studio-otro/',
    'https://claufrias.github.io.evil.test/a4studio/', 'http://claufrias.github.io/a4studio/',
    'https://evil.test/a4studio/', 'file:///a4studio/index.html'
  ]) {
    assert.equal(worker.isA4Url(url), false, url);
    assert.equal(bridge.isAllowedLocation(new URL(url)), false, url);
  }
  for (const url of ['https://claufrias.github.io/a4studio/', 'http://localhost:8123/a4studio/index.html', 'http://127.0.0.1:8123/a4studio/']) {
    assert.equal(worker.isA4Url(url), true, url);
    assert.equal(bridge.isAllowedLocation(new URL(url)), true, url);
  }
  let calls = 0;
  const controller = worker.createController(mockBrowser({ query: async () => { calls += 1; return []; } }));
  for (const maliciousSender of [{ ...sender, url: 'https://evil.test/a4studio/' }, { ...sender, frameId: 1 }, { url: sender.url, frameId: 0 }]) {
    assert.equal((await controller.handle(request('status'), maliciousSender)).error.code, 'UNAUTHORIZED_ORIGIN');
  }
  for (const invalid of [request('activate'), request('lookup', { ean: EAN }), request('lookup', { ean: 7790895000997, pricingTabId: 7 }), request('lookup', { ean: '1;alert(1)', pricingTabId: 7 })]) {
    assert.equal((await controller.handle(invalid, sender)).error.code, 'INVALID_REQUEST');
  }
  assert.equal(calls, 0);
});

test('status solo confirma una pestaña Pricing lista y nunca elige entre varias', async () => {
  const valid = await worker.createController(mockBrowser()).handle(request('status'), sender);
  assert.deepEqual(valid, { ok: true, result: { ready: true, pricingTabId: 7, pricingUrl: PRICING_URL } });
  let opened;
  const absent = await worker.createController(mockBrowser({ query: async () => [], create: async (tab) => { opened = tab.url; } })).handle(request('status'), sender);
  assert.equal(absent.error.code, 'PRICING_NOT_OPEN');
  assert.equal(opened, PRICING_URL);
  const multiple = await worker.createController(mockBrowser({ query: async () => [{ id: 7, url: PRICING_URL }, { id: 8, url: PRICING_URL }] })).handle(request('status'), sender);
  assert.equal(multiple.error.code, 'MULTIPLE_PRICING_TABS');
  const login = await worker.createController(mockBrowser({ sendMessage: async () => ({ ok: false, error: { code: 'LOGIN_REQUIRED', message: '<html>secret</html>' } }) })).handle(request('status'), sender);
  assert.equal(login.error.code, 'LOGIN_REQUIRED');
  assert.ok(!login.error.message.includes('secret'));
  assert.equal(worker.isPricingUrl('https://carrefour360.carrefour.com.ar/pricing-change'), false);
});

test('PVP decimal se convierte exactamente y no acepta separadores ambiguos ni importes FID', () => {
  assert.equal(pricing.parseDecimalCents('6000.00'), 600000);
  assert.equal(pricing.parseDecimalCents('0.29'), 29);
  assert.equal(pricing.parseDecimalCents('2541.5'), 254150);
  assert.equal(pricing.parseDisplayedPrice('$ 6,000.00'), 600000);
  assert.equal(pricing.parseDisplayedPrice('$ 2,541.50'), 254150);
  for (const raw of ['6,000.00', '6.000,00', 'NaN', '-1.00', '1.001', '1e3', '']) assert.equal(pricing.parseDecimalCents(raw), null, raw);
  for (const raw of ['$ 6,00.00', '$ 6.000,00', 'FID $ 6000.00', '$ -1.00']) assert.equal(pricing.parseDisplayedPrice(raw), null, raw);
  const f = pricingFixture();
  assert.equal(pricing.readProduct(f.content, EAN, f.state.description), null);
  f.state.description = { textContent: '  COCA\nCOLA  ' };
  f.state.price = { getAttribute: () => '6000.00', textContent: '$ 1.00' };
  assert.equal(pricing.readProduct(f.content, EAN, null).result.precioNormalCentavos, 600000);
  f.state.price = { getAttribute: () => null, textContent: '$ 6,000.00' };
  assert.equal(pricing.readProduct(f.content, EAN, null).result.precioNormalCentavos, 600000);
  f.state.price = { getAttribute: () => 'invalid', textContent: '$ 6,000.00' };
  assert.equal(pricing.readProduct(f.content, EAN, null).error.code, 'INVALID_PRICE');
});

test('consulta DOM espera nodo nuevo, conserva EAN textual y no devuelve la tabla anterior', async () => {
  const f = pricingFixture();
  const runner = pricing.createQueryRunner(f.document, f.environment);
  const ean = '0012345678905';
  let settled = false;
  const pending = runner.lookup(ean).then((result) => { settled = true; return result; });
  assert.equal(f.input.value, ean);
  assert.equal(f.clicks(), 1);
  f.mutate();
  await Promise.resolve();
  assert.equal(settled, false);
  f.state.description = null;
  f.mutate();
  await Promise.resolve();
  assert.equal(settled, false);
  f.state.description = { textContent: 'GASEOSA COLA REGULAR COCA COLA PET X 2.25 LT' };
  f.state.price = { getAttribute: () => '6000.00', textContent: '$ 6,000.00' };
  f.mutate();
  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(response.result.ean, ean);
  assert.equal(response.result.precioNormalCentavos, 600000);
  assert.equal(response.result.tienda, null);
  assert.equal(f.disconnected(), true);
});

test('cambio manual, timeout y consulta concurrente fallan sin devolver otro producto', async () => {
  const f = pricingFixture();
  const runner = pricing.createQueryRunner(f.document, f.environment);
  const pending = runner.lookup(EAN);
  assert.equal((await runner.lookup('7790895007217')).error.code, 'PRICING_BUSY');
  assert.equal(f.clicks(), 1);
  f.input.value = '7790895007217';
  f.mutate();
  assert.equal((await pending).error.code, 'INPUT_CHANGED');
  const timeout = runner.lookup(EAN);
  f.expire();
  assert.equal((await timeout).error.code, 'PRICING_TIMEOUT');
  assert.equal(f.disconnected(), true);
});

test('consulta previa con máscara visible devuelve PRICING_BUSY sin cambiar EAN ni buscar', async () => {
  const f = pricingFixture();
  f.loading.style.display = 'flex';
  const runner = pricing.createQueryRunner(f.document, f.environment);
  assert.equal((await runner.lookup(EAN)).error.code, 'PRICING_BUSY');
  assert.equal(f.input.value, '1234');
  assert.equal(f.clicks(), 0);
  f.loading.style.visibility = 'hidden';
  assert.equal(pricing.isLoading(f.document, f.environment), false);
});

test('descripción nueva espera que se oculte máscara antes de aceptar PVP nuevo', async () => {
  const f = pricingFixture();
  f.state.description = { textContent: 'ATUN CARREFOUR' };
  f.state.price = { getAttribute: () => '7190.00', textContent: '$ 7,190.00' };
  f.button.click = () => { f.loading.style.display = 'flex'; };
  const runner = pricing.createQueryRunner(f.document, f.environment);
  let settled = false;
  const pending = runner.lookup(EAN).then((response) => { settled = true; return response; });
  f.state.description = { textContent: 'GASEOSA COLA REGULAR COCA COLA PET X 2.25 LT' };
  f.state.price = { getAttribute: () => '6000.00', textContent: '$ 6,000.00' };
  f.mutate();
  await Promise.resolve();
  assert.equal(settled, false);
  f.loading.style.display = 'none';
  f.mutate();
  assert.equal((await pending).result.precioNormalCentavos, 600000);
  assert.equal(f.inputListenerCount(), 0);
});

test('edición manual cancela inmediatamente y retira listeners sin esperar mutación DOM', async () => {
  for (const eventName of ['input', 'change']) {
    const f = pricingFixture();
    const runner = pricing.createQueryRunner(f.document, f.environment);
    const pending = runner.lookup(EAN);
    assert.equal(f.inputListenerCount(), 2);
    f.editInput('7798108349161', eventName);
    assert.equal((await pending).error.code, 'INPUT_CHANGED');
    assert.equal(f.inputListenerCount(), 0);
    assert.equal(f.disconnected(), true);
  }
});

test('desaparición del input o cambio a login cancela con LOGIN_REQUIRED', async () => {
  for (const cause of ['input', 'route']) {
    const f = pricingFixture();
    f.environment.location = new URL(PRICING_URL);
    const runner = pricing.createQueryRunner(f.document, f.environment);
    const pending = runner.lookup(EAN);
    if (cause === 'input') {
      const previousQuery = f.document.querySelector;
      f.document.querySelector = (selector) => selector === '#ean_product_value' ? null : previousQuery(selector);
    } else f.environment.location = new URL('https://carrefour360.carrefour.com.ar/login');
    f.mutate();
    assert.equal((await pending).error.code, 'LOGIN_REQUIRED');
    assert.equal(f.inputListenerCount(), 0);
  }
});

test('worker serializa consultas por pestaña y permite que otra pestaña avance', async () => {
  const starts = [];
  const release = new Map();
  const controller = worker.createController(mockBrowser({ sendMessage: async (tabId, message) => {
    starts.push([tabId, message.ean]);
    await new Promise((resolve) => release.set(`${tabId}:${message.ean}`, resolve));
    return { ok: true, result: product(message.ean) };
  } }));
  const a = controller.handle(request('lookup', { ean: EAN, pricingTabId: 7 }), sender);
  const b = controller.handle(request('lookup', { ean: '1234', pricingTabId: 7 }), sender);
  const c = controller.handle(request('lookup', { ean: '5678', pricingTabId: 8 }), sender);
  await new Promise(setImmediate);
  assert.deepEqual(starts, [[7, EAN], [8, '5678']]);
  release.get('8:5678')();
  assert.equal((await c).result.ean, '5678');
  release.get(`7:${EAN}`)();
  assert.equal((await a).result.precioNormalCentavos, 600000);
  await new Promise(setImmediate);
  assert.deepEqual(starts, [[7, EAN], [8, '5678'], [7, '1234']]);
  release.get('7:1234')();
  assert.equal((await b).result.ean, '1234');
});

test('worker rechaza EAN cruzado, PVP inseguro y pestaña que dejó Pricing', async () => {
  for (const invalidProduct of [product('9999'), { ...product(), precioNormalCentavos: NaN }, { ...product(), precioNormalCentavos: 1.5 }, { ...product(), consultadoEn: 'ayer' }]) {
    const result = await worker.createController(mockBrowser({ sendMessage: async () => ({ ok: true, result: invalidProduct }) })).handle(request('lookup', { ean: EAN, pricingTabId: 7 }), sender);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
  }
  let queried = false;
  const result = await worker.createController(mockBrowser({
    get: async () => ({ id: 7, url: 'https://carrefour360.carrefour.com.ar/login' }),
    sendMessage: async () => { queried = true; }
  })).handle(request('lookup', { ean: EAN, pricingTabId: 7 }), sender);
  assert.equal(result.error.code, 'LOGIN_REQUIRED');
  assert.equal(queried, false);
});

test('consultas que vencen en la cola no ejecutan búsquedas tardías en Pricing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = [];
  const controller = worker.createController(mockBrowser({ sendMessage: async (_, message) => {
    starts.push(message.ean);
    return new Promise(() => {});
  } }));
  const first = controller.handle(request('lookup', { ean: EAN, pricingTabId: 7 }), sender);
  const queued = controller.handle(request('lookup', { ean: '1234', pricingTabId: 7 }), sender);
  await new Promise(setImmediate);
  assert.deepEqual(starts, [EAN]);
  t.mock.timers.tick(18001);
  assert.equal((await first).error.code, 'PRICING_TIMEOUT');
  assert.equal((await queued).error.code, 'PRICING_TIMEOUT');
  await new Promise(setImmediate);
  assert.deepEqual(starts, [EAN]);
});

test('puente valida window/origin, exige conexión y adjunta solo vínculo interno', async () => {
  const posts = [];
  const calls = [];
  let listener;
  const window = {
    location: new URL('https://claufrias.github.io/a4studio/'),
    addEventListener: (_, callback) => { listener = callback; },
    postMessage: (message, origin) => posts.push({ message, origin })
  };
  window.top = window;
  bridge.install(window, { sendMessage: async (message) => {
    calls.push(message);
    return message.action === 'status'
      ? { ok: true, result: { ready: true, pricingTabId: 7, pricingUrl: PRICING_URL } }
      : { ok: true, result: product(message.ean) };
  } });
  const publicRequest = (action, extra = {}) => ({ source: 'a4studio-carrefour360', version: 1, id: 'public-1', action, ...extra });
  const event = (data) => ({ data, source: window, origin: window.location.origin });
  await listener({ ...event(publicRequest('status')), origin: 'https://evil.test' });
  await listener({ ...event(publicRequest('status')), source: {} });
  assert.equal(calls.length, 0);
  await listener(event(publicRequest('lookup', { ean: EAN, pricingTabId: 99 })));
  assert.equal(posts.at(-1).message.error.code, 'NOT_CONNECTED');
  await listener(event(publicRequest('status')));
  await listener(event(publicRequest('lookup', { ean: EAN, pricingTabId: 99 })));
  assert.equal(calls.at(-1).pricingTabId, 7);
  assert.equal(posts.at(-1).origin, 'https://claufrias.github.io');
  assert.equal(posts.at(-1).message.source, 'carrefour360-a4studio');
  assert.equal(posts.at(-1).message.result.ean, EAN);
  assert.equal(Object.hasOwn(posts.at(-1).message, 'pricingTabId'), false);
});

test('presencia responde sin sesión ni mensajes a Pricing y conserva la conexión existente', async () => {
  const posts = [];
  const calls = [];
  let listener;
  const window = {
    location: new URL('https://claufrias.github.io/a4studio/'),
    addEventListener: (_, callback) => { listener = callback; },
    postMessage: (message, origin) => posts.push({ message, origin })
  };
  window.top = window;
  bridge.install(window, {
    getManifest: () => ({ version: '1.0.2' }),
    sendMessage: async (message) => {
      calls.push(message);
      return message.action === 'status'
        ? { ok: true, result: { ready: true, pricingTabId: 7, pricingUrl: PRICING_URL } }
        : { ok: true, result: product(message.ean) };
    }
  });
  const event = (action, extra = {}) => ({
    source: window, origin: window.location.origin,
    data: { source: 'a4studio-carrefour360', version: 1, id: `presence-${action}`, action, ...extra }
  });
  await listener(event('presence'));
  assert.deepEqual(posts.at(-1), {
    origin: window.location.origin,
    message: { source: 'carrefour360-a4studio', version: 1, id: 'presence-presence',
      ok: true, result: { installed: true, extensionVersion: '1.0.2' } }
  });
  assert.equal(calls.length, 0, 'detectar presencia no debe abrir ni consultar Pricing');
  await listener(event('lookup', { ean: EAN }));
  assert.equal(posts.at(-1).message.error.code, 'NOT_CONNECTED');
  assert.equal(calls.length, 0, 'detectar presencia no equivale a conectar Pricing');
  await listener(event('status'));
  await listener(event('presence'));
  await listener(event('lookup', { ean: EAN }));
  assert.deepEqual(calls.map((call) => call.action), ['status', 'lookup']);
  assert.equal(calls.at(-1).pricingTabId, 7, 'la detección no debe reemplazar la pestaña conectada');
});

test('presencia ignora mensajes ajenos e informa un contexto de extensión invalidado', async () => {
  const posts = [];
  let listener;
  const window = {
    location: new URL('https://claufrias.github.io/a4studio/'),
    addEventListener: (_, callback) => { listener = callback; },
    postMessage: (message) => posts.push(message)
  };
  window.top = window;
  bridge.install(window, {
    getManifest: () => { throw new Error('Extension context invalidated'); },
    sendMessage: () => assert.fail('la presencia no debe usar runtime.sendMessage')
  });
  const event = { source: window, origin: window.location.origin,
    data: { source: 'a4studio-carrefour360', version: 1, id: 'presence-1', action: 'presence' } };
  await listener({ ...event, source: {} });
  await listener({ ...event, origin: 'https://evil.test' });
  await listener({ ...event, data: { ...event.data, version: 2 } });
  await listener({ ...event, data: { ...event.data, id: 'invalid id' } });
  assert.equal(posts.length, 0);
  await listener(event);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].ok, false);
  assert.equal(posts[0].error.code, 'EXTENSION_UNAVAILABLE');
});

test('reinyectar el puente conserva la conexión y no duplica mensajes', async () => {
  const listeners = new Set();
  const posts = [];
  const calls = [];
  const window = {
    location: new URL('https://claufrias.github.io/a4studio/'),
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    postMessage: (message, origin) => posts.push({ message, origin })
  };
  window.top = window;
  const runtime = {
    getManifest: () => ({ version: '1.0.3' }),
    sendMessage: async (message) => {
      calls.push(message);
      return message.action === 'status'
        ? { ok: true, result: { ready: true, pricingTabId: 7, pricingUrl: PRICING_URL } }
        : { ok: true, result: product(message.ean) };
    }
  };
  const emit = async (action) => {
    for (const listener of listeners) await listener({
      source: window, origin: window.location.origin,
      data: { source: 'a4studio-carrefour360', version: 1, id: action, action, ean: EAN }
    });
  };
  const first = bridge.install(window, runtime);
  assert.deepEqual(posts[0], {
    origin: window.location.origin,
    message: { source: 'carrefour360-a4studio', version: 1, action: 'ready' }
  });
  assert.equal(calls.length, 0, 'anunciar disponibilidad no consulta Pricing');
  await emit('status');
  assert.equal(bridge.install(window, runtime), first);
  assert.equal(listeners.size, 1);
  await emit('lookup');
  assert.deepEqual(calls.map((call) => call.action), ['status', 'lookup']);
  assert.equal(calls.at(-1).pricingTabId, 7);
  assert.equal(posts.filter((post) => post.message.id === 'lookup').length, 1);
});

test('un nuevo contexto reemplaza el puente anterior y no responde con datos pendientes viejos', async () => {
  const listeners = new Set();
  const posts = [];
  let finishOldStatus;
  const window = {
    location: new URL('https://claufrias.github.io/a4studio/'),
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    postMessage: (message) => posts.push(message)
  };
  window.top = window;
  bridge.install(window, {
    getManifest: () => ({ version: '1.0.3' }),
    sendMessage: () => new Promise((resolve) => { finishOldStatus = resolve; })
  });
  const oldRequest = [...listeners][0]({
    source: window, origin: window.location.origin,
    data: { source: 'a4studio-carrefour360', version: 1, id: 'old-status', action: 'status' }
  });
  bridge.install(window, {
    getManifest: () => ({ version: '1.0.4' }),
    sendMessage: () => assert.fail('detectar el nuevo contexto no debe consultar Pricing')
  });
  assert.equal(listeners.size, 1);
  finishOldStatus({ ok: true, result: { ready: true, pricingTabId: 7, pricingUrl: PRICING_URL } });
  await oldRequest;
  assert.equal(posts.some((post) => post.id === 'old-status'), false);
  await [...listeners][0]({
    source: window, origin: window.location.origin,
    data: { source: 'a4studio-carrefour360', version: 1, id: 'new-presence', action: 'presence' }
  });
  assert.equal(posts.at(-1).result.extensionVersion, '1.0.4');
});

test('reinyectar Pricing conserva la consulta activa y evita búsquedas duplicadas', async () => {
  const f = pricingFixture();
  const listeners = new Set();
  const runtime = {
    id: 'connector', getManifest: () => ({ version: '1.0.3' }),
    onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) }
  };
  const first = pricing.install(f.document, runtime, f.environment);
  const responses = [];
  const request = { channel: worker.CHANNEL, version: 1, action: 'lookup', ean: EAN };
  [...listeners][0](request, { id: runtime.id }, (result) => responses.push(result));
  assert.equal(f.clicks(), 1);
  assert.equal(pricing.install(f.document, runtime, f.environment), first);
  assert.equal(listeners.size, 1);
  [...listeners][0](request, { id: runtime.id }, (result) => responses.push(result));
  await new Promise(setImmediate);
  assert.equal(f.clicks(), 1);
  assert.equal(responses[0].error.code, 'PRICING_BUSY');
  f.state.description = { textContent: 'PRODUCTO NUEVO' };
  f.mutate();
  await new Promise(setImmediate);
  assert.equal(responses.length, 2);
  assert.equal(responses[1].result.descripcion, 'PRODUCTO NUEVO');
  assert.equal(f.inputListenerCount(), 0);
});

test('reemplazar el contexto de Pricing retira sus listeners y cancela la consulta anterior', async () => {
  const f = pricingFixture();
  const listeners = new Set();
  const createRuntime = (version) => ({
    id: 'connector', getManifest: () => ({ version }),
    onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) }
  });
  const oldRuntime = createRuntime('1.0.3');
  pricing.install(f.document, oldRuntime, f.environment);
  [...listeners][0]({ channel: worker.CHANNEL, version: 1, action: 'lookup', ean: EAN },
    { id: oldRuntime.id }, () => assert.fail('el contexto retirado no debe devolver una consulta vieja'));
  assert.equal(f.inputListenerCount(), 2);
  pricing.install(f.document, createRuntime('1.0.4'), f.environment);
  await new Promise(setImmediate);
  assert.equal(listeners.size, 1);
  assert.equal(f.inputListenerCount(), 0);
  assert.equal(f.disconnected(), true);
});
