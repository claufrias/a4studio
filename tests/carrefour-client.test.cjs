'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'carrefour360.js'), 'utf8');
const context = vm.createContext({ window: {}, URL });
vm.runInContext(source, context);
const { createClient, validateProduct } = context.window.A4Carrefour360;

class FakeWindow {
  constructor() {
    this.location = { origin: 'https://claufrias.github.io' };
    this.listeners = new Set();
    this.messages = [];
    this.timers = new Map();
    this.nextTimer = 0;
    this.crypto = { randomUUID: () => 'test-uuid' };
  }
  addEventListener(type, listener) {
    assert.equal(type, 'message');
    this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    assert.equal(type, 'message');
    this.listeners.delete(listener);
  }
  postMessage(message, origin) { this.messages.push({ message, origin }); }
  setTimeout(callback, delay) {
    const id = ++this.nextTimer;
    this.timers.set(id, { callback, delay });
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  emit(data, overrides = {}) {
    const event = { source: this, origin: this.location.origin, data, ...overrides };
    for (const listener of this.listeners) listener(event);
  }
  reply(index, result, overrides = {}) {
    this.emit({ source: 'carrefour360-a4studio', version: 1, id: this.messages[index].message.id,
      ok: true, result, ...overrides });
  }
  expire() {
    for (const [id, timer] of [...this.timers]) {
      this.timers.delete(id);
      timer.callback();
    }
  }
}

const status = { ready: true, pricingTabId: 42,
  pricingUrl: 'https://carrefour360.carrefour.com.ar/pricing?tienda=1' };
function product(overrides = {}) {
  return { ean: '0012345678905', descripcion: 'CAFÉ MOLIDO 250 G', precioNormalCentavos: 254150,
    consultadoEn: '2026-10-23T14:22:33.000Z', source: 'Carrefour360', tienda: null, ...overrides };
}
function setup(t, options = {}) {
  const window = new FakeWindow();
  const client = createClient({ targetWindow: window, ...options });
  t.after(() => client.destroy());
  return { window, client };
}
function errorCode(code) {
  return (error) => error.code === code && typeof error.message === 'string' && error.message.length > 10;
}

test('detecta la extensión sin solicitar conexión ni una pestaña Pricing', async (t) => {
  const { window, client } = setup(t);
  const detected = client.detect();
  assert.equal(window.messages.length, 1);
  assert.equal(window.messages[0].message.action, 'presence');
  assert.equal(window.messages[0].message.ean, undefined);
  assert.equal(window.timers.values().next().value.delay, 1500);
  window.reply(0, { installed: true, extensionVersion: '1.0.2', pricingUrl: 'discard' });
  assert.deepEqual(JSON.parse(JSON.stringify(await detected)), { installed: true, extensionVersion: '1.0.2' });
  assert.equal(window.timers.size, 0);
});

test('detección exige presencia y versión válidas, sin aceptar un estado de Pricing', async (t) => {
  const { window, client } = setup(t);
  const invalid = [
    null, [], {}, status, { installed: false, extensionVersion: '1.0.2' },
    { installed: true }, { installed: true, extensionVersion: 102 },
    ...['', 'latest', '1.2.3.4.5', '1.0.2-beta', '01.2', '0.0.0.0', '65536.0', '1'.repeat(200)]
      .map((extensionVersion) => ({ installed: true, extensionVersion }))
  ];
  for (const result of invalid) {
    const detected = client.detect();
    window.reply(window.messages.length - 1, result);
    await assert.rejects(detected, errorCode('INVALID_RESPONSE'));
  }
  assert.equal(window.timers.size, 0);
});

test('detección ignora otros orígenes, ventanas e identificadores', async (t) => {
  const { window, client } = setup(t);
  const detected = client.detect();
  let settled = false;
  detected.then(() => { settled = true; });
  const response = { source: 'carrefour360-a4studio', version: 1,
    id: window.messages[0].message.id, ok: true, result: { installed: true, extensionVersion: '1.0.2' } };
  window.emit(response, { source: {} });
  window.emit(response, { origin: 'https://otro.example' });
  window.emit({ ...response, id: 'other-id' });
  window.emit({ ...response, version: 2 });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(window.timers.size, 1);
  window.emit(response);
  assert.equal((await detected).installed, true);
});

test('detección tiene plazo propio y ausencia no se confunde con sesión Pricing', async (t) => {
  const { window, client } = setup(t, { detectionTimeoutMs: 80 });
  const detected = client.detect();
  assert.equal(window.timers.values().next().value.delay, 80);
  window.expire();
  await assert.rejects(detected, errorCode('EXTENSION_NOT_AVAILABLE'));
  window.reply(0, { installed: true, extensionVersion: '1.0.2' });
  const connected = client.connect();
  assert.equal(window.timers.values().next().value.delay, 2500);
  window.reply(1, null, { ok: false, error: { code: 'LOGIN_REQUIRED', message: 'Iniciá sesión en Carrefour360.' } });
  await assert.rejects(connected, errorCode('LOGIN_REQUIRED'));
  assert.equal(window.timers.size, 0);
});

test('cancelar detección ignora respuesta tardía y permite reintentar', async (t) => {
  const { window, client } = setup(t);
  const first = client.detect();
  client.cancelPending();
  await assert.rejects(first, errorCode('CANCELLED'));
  const retry = client.detect();
  window.reply(0, { installed: true, extensionVersion: '1.0.2' });
  assert.equal(window.timers.size, 1);
  window.reply(1, { installed: true, extensionVersion: '1.0.2' });
  assert.equal((await retry).installed, true);
  client.destroy();
  await assert.rejects(client.detect(), errorCode('CLIENT_DESTROYED'));
});

test('conecta por el mismo origen y valida la pestaña Pricing', async (t) => {
  const { window, client } = setup(t);
  const connected = client.connect();
  assert.equal(window.messages[0].origin, 'https://claufrias.github.io');
  assert.equal(window.messages[0].message.source, 'a4studio-carrefour360');
  assert.equal(window.messages[0].message.version, 1);
  assert.equal(window.messages[0].message.action, 'status');
  assert.equal(window.timers.values().next().value.delay, 2500);
  window.reply(0, status);
  assert.deepEqual(JSON.parse(JSON.stringify(await connected)), status);
  assert.equal(window.timers.size, 0);
});

test('consulta EAN exacto, conserva ceros y centavos y descarta campos ajenos al DTO', async (t) => {
  const { window, client } = setup(t);
  const lookup = client.lookup('0012345678905');
  assert.equal(window.messages[0].message.ean, '0012345678905');
  assert.equal(window.timers.values().next().value.delay, 20000);
  window.reply(0, product({ irrelevant: 'ignored' }));
  assert.deepEqual(JSON.parse(JSON.stringify(await lookup)), product());
  assert.equal(window.timers.size, 0);
});

test('conecta también con la barra final de Pricing y conserva la query', async (t) => {
  const { window, client } = setup(t);
  const connected = client.connect();
  const trailingSlash = { ...status, pricingUrl: 'https://carrefour360.carrefour.com.ar/pricing/?tienda=1' };
  window.reply(0, trailingSlash);
  assert.deepEqual(JSON.parse(JSON.stringify(await connected)), trailingSlash);
});

test('ignora mensajes de otra ventana, origen, protocolo o identificador', async (t) => {
  const { window, client } = setup(t);
  const connected = client.connect();
  let settled = false;
  connected.then(() => { settled = true; });
  const response = { source: 'carrefour360-a4studio', version: 1,
    id: window.messages[0].message.id, ok: true, result: status };
  window.emit(response, { source: {} });
  window.emit(response, { origin: 'https://otro.example' });
  window.emit({ ...response, source: 'other' });
  window.emit({ ...response, version: 2 });
  window.emit({ ...response, id: 'unknown-id' });
  window.emit(null);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(window.timers.size, 1);
  window.emit(response);
  assert.equal((await connected).ready, true);
});

test('rechaza estados que señalan otra URL o una pestaña inválida', async (t) => {
  const { window, client } = setup(t);
  const cases = [
    { ready: false }, { pricingTabId: '42' }, { pricingTabId: -1 },
    { pricingUrl: 'https://carrefour360.carrefour.com.ar/login' },
    { pricingUrl: 'https://carrefour360.carrefour.com.ar.evil.example/pricing' },
    { pricingUrl: 'http://carrefour360.carrefour.com.ar/pricing' },
    { pricingUrl: 'https://usuario:clave@carrefour360.carrefour.com.ar/pricing' },
    { pricingUrl: 'https://carrefour360.carrefour.com.ar/pricing#otro' }
  ];
  for (const overrides of cases) {
    const pending = client.connect();
    window.reply(window.messages.length - 1, { ...status, ...overrides });
    await assert.rejects(pending, errorCode('INVALID_RESPONSE'));
  }
});

test('rechaza EAN distinto, precios inválidos y DTO incompleto', async (t) => {
  const { window, client } = setup(t);
  const invalid = [
    null, {}, product({ ean: '12345678905' }), product({ ean: 12345678905 }),
    product({ descripcion: '  ' }), product({ descripcion: 'x'.repeat(251) }),
    product({ precioNormalCentavos: -1 }), product({ precioNormalCentavos: 2541.5 }),
    product({ precioNormalCentavos: '254150' }), product({ precioNormalCentavos: NaN }),
    product({ precioNormalCentavos: Number.MAX_SAFE_INTEGER + 1 }),
    product({ consultadoEn: '2026-02-30T10:00:00.000Z' }),
    product({ consultadoEn: 'hoy' }), product({ consultadoEn: '2026-10-23' }),
    product({ source: 'otro' }), product({ tienda: undefined })
  ];
  for (const result of invalid) {
    const pending = client.lookup('0012345678905');
    window.reply(window.messages.length - 1, result);
    await assert.rejects(pending, errorCode('INVALID_RESPONSE'));
  }
  assert.equal(window.timers.size, 0);
});

test('valida el EAN de entrada antes de enviar una consulta', async (t) => {
  const { window, client } = setup(t);
  for (const ean of [1234, '', '123', '123456789012345', ' 1234', '1234 ', '123-4']) {
    await assert.rejects(client.lookup(ean), errorCode('INVALID_EAN'));
  }
  assert.equal(window.messages.length, 0);
  assert.equal(window.timers.size, 0);
});

test('sin extensión informa cómo instalarla; la consulta tiene su propio plazo', async (t) => {
  const { window, client } = setup(t, { connectTimeoutMs: 50, lookupTimeoutMs: 120 });
  const connection = client.connect();
  assert.equal(window.timers.values().next().value.delay, 50);
  window.expire();
  await assert.rejects(connection, errorCode('EXTENSION_NOT_AVAILABLE'));
  window.reply(0, status); // A response received after timeout cannot revive the request.
  const lookup = client.lookup('0012345678905');
  assert.equal(window.timers.values().next().value.delay, 120);
  window.expire();
  await assert.rejects(lookup, errorCode('TIMEOUT'));
  assert.equal(window.timers.size, 0);
});

test('conserva los errores de la extensión y rechaza errores malformados', async (t) => {
  const { window, client } = setup(t);
  const pending = client.lookup('0012345678905');
  window.reply(0, null, { ok: false, error: { code: 'LOGIN_REQUIRED', message: 'Iniciá sesión en Carrefour360.' } });
  await assert.rejects(pending, (error) => error.code === 'LOGIN_REQUIRED'
    && error.message === 'Iniciá sesión en Carrefour360.');
  for (const error of [null, {}, { code: 'LOGIN_REQUIRED', message: '' }, { code: {}, message: 'Error' }]) {
    const malformed = client.connect();
    window.reply(window.messages.length - 1, null, { ok: false, error });
    await assert.rejects(malformed, errorCode('INVALID_RESPONSE'));
  }
  const malformed = client.connect();
  window.reply(window.messages.length - 1, status, { ok: 'true' });
  await assert.rejects(malformed, errorCode('INVALID_RESPONSE'));
});

test('consultas simultáneas reciben su propio producto aunque respondan en otro orden', async (t) => {
  const { window, client } = setup(t);
  const first = client.lookup('0012345678905');
  const second = client.lookup('7790000000001');
  assert.notEqual(window.messages[0].message.id, window.messages[1].message.id);
  window.reply(1, product({ ean: '7790000000001', precioNormalCentavos: 190099 }));
  window.reply(0, product());
  assert.equal((await second).precioNormalCentavos, 190099);
  assert.equal((await first).ean, '0012345678905');
  assert.equal(window.timers.size, 0);
});

test('cancelar limpia plazos, ignora respuestas tardías y permite otra consulta', async (t) => {
  const { window, client } = setup(t);
  const first = client.connect();
  const second = client.lookup('0012345678905');
  client.cancelPending();
  await assert.rejects(first, errorCode('CANCELLED'));
  await assert.rejects(second, errorCode('CANCELLED'));
  assert.equal(window.timers.size, 0);
  const third = client.lookup('0012345678905');
  window.reply(0, status);
  window.reply(1, product());
  assert.equal(window.timers.size, 1);
  window.reply(2, product());
  assert.equal((await third).ean, '0012345678905');
});

test('destroy cancela pendientes, elimina el listener y cierra el cliente', async (t) => {
  const { window, client } = setup(t);
  const pending = client.lookup('0012345678905');
  client.destroy();
  client.destroy();
  await assert.rejects(pending, errorCode('CANCELLED'));
  assert.equal(window.listeners.size, 0);
  assert.equal(window.timers.size, 0);
  await assert.rejects(client.connect(), errorCode('CLIENT_DESTROYED'));
  await assert.rejects(client.lookup('0012345678905'), errorCode('CLIENT_DESTROYED'));
  assert.equal(window.messages.length, 1);
});

test('validador público devuelve sólo datos de producto y exige precio en centavos', () => {
  const validated = validateProduct(product({ precioNormalCentavos: 0, descripcion: '  PRODUCTO  ', extra: 'discard' }));
  assert.equal(validated.descripcion, 'PRODUCTO');
  assert.equal(validated.precioNormalCentavos, 0);
  assert.equal(validated.extra, undefined);
  assert.throws(() => validateProduct(product(), '7790000000001'), errorCode('INVALID_RESPONSE'));
});

test('usa identificadores distintos sin crypto y no envía consultas desde un archivo local', async (t) => {
  const { window, client } = setup(t);
  window.crypto = undefined;
  const first = client.connect();
  const second = client.connect();
  assert.notEqual(window.messages[0].message.id, window.messages[1].message.id);
  window.reply(0, status);
  window.reply(1, status);
  await Promise.all([first, second]);
  const localWindow = new FakeWindow();
  localWindow.location.origin = 'null';
  const local = createClient({ targetWindow: localWindow });
  t.after(() => local.destroy());
  await assert.rejects(local.connect(), errorCode('INVALID_ORIGIN'));
  assert.equal(localWindow.messages.length, 0);
});

test('dos clientes sin crypto no comparten identificadores ni respuestas', async (t) => {
  const window = new FakeWindow();
  window.crypto = undefined;
  const first = createClient({ targetWindow: window });
  const second = createClient({ targetWindow: window });
  t.after(() => { first.destroy(); second.destroy(); });
  const one = first.connect();
  const two = second.connect();
  assert.notEqual(window.messages[0].message.id, window.messages[1].message.id);
  window.reply(0, status);
  await one;
  assert.equal(window.timers.size, 1);
  window.reply(1, status);
  await two;
});

test('un fallo al enviar limpia el plazo y devuelve un error de conexión', async (t) => {
  const { window, client } = setup(t);
  window.postMessage = () => { throw new Error('send failed'); };
  await assert.rejects(client.connect(), errorCode('CONNECTION_ERROR'));
  assert.equal(window.timers.size, 0);
});
