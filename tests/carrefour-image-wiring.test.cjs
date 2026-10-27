'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const worker = require('../extensions/carrefour360/service-worker.js');
const bridge = require('../extensions/carrefour360/a4-bridge.js');

const EAN = '0012345678905';
const PRICING_URL = 'https://carrefour360.carrefour.com.ar/pricing';
const sender = { url: 'https://claufrias.github.io/a4studio/', frameId: 0, tab: { id: 20 } };
const request = (extra = {}) => ({ channel: worker.CHANNEL, version: 1, id: 'image-1', action: 'image', ean: EAN, ...extra });
const image = () => ({
  ean: EAN, descripcion: 'Producto exacto', source: 'Carrefour.com.ar',
  imageUrl: 'https://carrefourar.vteximg.com.br/arquivos/ids/332148/product.jpg',
  productUrl: 'https://www.carrefour.com.ar/producto-exacto/p',
  imageDataUrl: 'data:image/jpeg;base64,/9j/4AAC/9k='
});

function noPricingBrowser() {
  return { tabs: new Proxy({}, { get: (_, property) => () => assert.fail(`Image request accessed tabs.${String(property)}`) }) };
}

test('worker busca imágenes sin conexión ni operaciones con pestañas y conserva el EAN exacto', async () => {
  const calls = [];
  const controller = worker.createController(noPricingBrowser(), {
    lookupImage: async (...args) => { calls.push(args); return image(); }
  });
  const result = await controller.handle(request({ url: 'https://evil.test/private', pricingTabId: 999 }), sender);
  assert.deepEqual(result, { ok: true, result: image() });
  assert.deepEqual(calls, [[EAN]], 'solo el EAN validado llega al catálogo, nunca una URL elegida por la página');
});

test('worker rechaza orígenes, frames y códigos inválidos antes de acceder al catálogo', async () => {
  const controller = worker.createController(noPricingBrowser(), {
    lookupImage: () => assert.fail('Unauthorized request reached the catalog')
  });
  for (const badSender of [undefined, { ...sender, frameId: 1 }, { ...sender, url: 'https://evil.test/a4studio/' }, { url: sender.url, frameId: 0 }]) {
    assert.equal((await controller.handle(request(), badSender)).error.code, 'UNAUTHORIZED_ORIGIN');
  }
  for (const extra of [{ ean: '123' }, { ean: 1234 }, { ean: '1'.repeat(15) }, { ean: '1234&url=evil' }, { action: 'fetch' }, { id: 'bad id' }, { version: 2 }]) {
    assert.equal((await controller.handle(request(extra), sender)).error.code, 'INVALID_REQUEST');
  }
});

test('worker informa fallos de imagen sin filtrar errores internos ni confundirlos con Pricing', async () => {
  for (const code of ['INVALID_EAN', 'IMAGE_NOT_FOUND', 'IMAGE_UNAVAILABLE', 'IMAGE_INVALID', 'IMAGE_TIMEOUT', 'UNKNOWN_INTERNAL']) {
    const controller = worker.createController(noPricingBrowser(), {
      lookupImage: async () => { throw Object.assign(new Error('private upstream response'), { code }); }
    });
    const response = await controller.handle(request(), sender);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, code === 'UNKNOWN_INTERNAL' ? 'IMAGE_UNAVAILABLE' : code);
    assert.ok(response.error.message.length > 10);
    assert.ok(!response.error.message.includes('private'));
  }
});

test('el worker de Chrome importa el catálogo y responde mediante el canal interno existente', async () => {
  let onMessage;
  const imports = [];
  const context = {
    URL, setTimeout, clearTimeout,
    chrome: {
      ...noPricingBrowser(),
      runtime: {
        onMessage: { addListener(listener) { onMessage = listener; } },
        onInstalled: { addListener() {} }
      }
    },
    importScripts(file) {
      imports.push(file);
      context.A4CarrefourImages = { lookup: async (ean) => { assert.equal(ean, EAN); return image(); } };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extensions/carrefour360/service-worker.js'), 'utf8'), context);
  assert.deepEqual(imports, ['catalog-images.js']);
  let callback;
  const response = new Promise((resolve) => { callback = resolve; });
  assert.equal(onMessage(request(), sender, callback), true);
  const result = await response;
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, image());
});

function bridgeFixture() {
  const posts = [];
  const calls = [];
  let listener;
  let failImage = false;
  const window = {
    location: new URL('https://claufrias.github.io/a4studio/'),
    addEventListener: (_, callback) => { listener = callback; },
    removeEventListener() {},
    postMessage: (message) => posts.push(message)
  };
  window.top = window;
  bridge.install(window, {
    getManifest: () => ({ version: '1.0.4' }),
    sendMessage: async (message) => {
      calls.push(message);
      if (message.action === 'image') {
        if (failImage) throw new Error('Image channel unavailable');
        return { ok: true, result: image() };
      }
      if (message.action === 'status') return { ok: true, result: { ready: true, pricingTabId: 7, pricingUrl: PRICING_URL } };
      return { ok: true, result: { ean: message.ean } };
    }
  });
  let id = 0;
  return {
    posts, calls, window,
    failImage() { failImage = true; },
    async emit(action, extra = {}, eventOverrides = {}) {
      await listener({
        source: window, origin: window.location.origin,
        data: { source: 'a4studio-carrefour360', version: 1, id: `image-${++id}`, action, ean: EAN, ...extra },
        ...eventOverrides
      });
      return posts.at(-1);
    }
  };
}

test('el puente permite buscar imagen antes de conectar y no adjunta la pestaña Pricing', async () => {
  const f = bridgeFixture();
  const response = await f.emit('image', { url: 'https://evil.test/', pricingTabId: 999 });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, image());
  assert.deepEqual(f.calls, [{ channel: worker.CHANNEL, version: 1, id: 'image-1', action: 'image', ean: EAN }]);
  await f.emit('lookup');
  assert.equal(f.posts.at(-1).error.code, 'NOT_CONNECTED', 'la búsqueda de imagen no conecta Pricing');
  assert.equal(f.calls.length, 1);
});

test('imágenes exitosas o fallidas conservan una conexión Pricing existente', async () => {
  const f = bridgeFixture();
  await f.emit('status');
  await f.emit('image');
  f.failImage();
  await f.emit('image');
  assert.equal(f.posts.at(-1).error.code, 'EXTENSION_UNAVAILABLE');
  await f.emit('lookup');
  assert.equal(f.calls.at(-1).action, 'lookup');
  assert.equal(f.calls.at(-1).pricingTabId, 7);
});

test('el puente ignora solicitudes de imagen ajenas o malformadas', async () => {
  const f = bridgeFixture();
  await f.emit('image', {}, { source: {} });
  await f.emit('image', {}, { origin: 'https://evil.test' });
  await f.emit('image', { ean: '123' });
  await f.emit('image', { ean: 1234 });
  await f.emit('image', { ean: '1234&url=https://evil.test' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.posts.filter((post) => post.id).length, 0);
});
