'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { attachOpenTabs } = require('../extensions/carrefour360/service-worker.js');

const PATTERNS = [
  'https://claufrias.github.io/a4studio/*',
  'http://localhost/a4studio/*',
  'http://127.0.0.1/a4studio/*',
  'https://carrefour360.carrefour.com.ar/pricing*'
];

function browserFor(tabs, { rejectTab, rejectQuery = false } = {}) {
  const queries = [];
  const injections = [];
  return {
    queries, injections,
    tabs: {
      async query(options) {
        queries.push(options);
        if (rejectQuery) throw new Error('Access unavailable');
        return tabs;
      },
      reload() { assert.fail('Installation must preserve unsaved editor state'); },
      create() { assert.fail('Installation must not open Pricing'); },
      sendMessage() { assert.fail('Installation must not consult a product or Pricing session'); }
    },
    scripting: {
      async executeScript(options) {
        injections.push(options);
        if (options.target.tabId === rejectTab) throw new Error('Tab closed');
      }
    }
  };
}

test('al instalar conecta solo las pestañas A4 y Pricing ya abiertas, sin recargar ni consultar', async () => {
  const browser = browserFor([
    { id: 1, url: 'https://claufrias.github.io/a4studio/' },
    { id: 2, url: 'http://localhost:8123/a4studio/index.html' },
    { id: 3, url: 'http://127.0.0.1:8123/a4studio/?project=one' },
    { id: 4, url: 'https://carrefour360.carrefour.com.ar/pricing?tienda=1' },
    { id: 5, url: 'https://carrefour360.carrefour.com.ar/pricing/' }
  ]);
  assert.equal(await attachOpenTabs(browser), 5);
  assert.deepEqual(browser.queries, [{ url: PATTERNS }]);
  assert.deepEqual(browser.injections, [
    { target: { tabId: 1, frameIds: [0] }, files: ['a4-bridge.js'] },
    { target: { tabId: 2, frameIds: [0] }, files: ['a4-bridge.js'] },
    { target: { tabId: 3, frameIds: [0] }, files: ['a4-bridge.js'] },
    { target: { tabId: 4, frameIds: [0] }, files: ['pricing-content.js'] },
    { target: { tabId: 5, frameIds: [0] }, files: ['pricing-content.js'] }
  ]);
});

test('revalida origen, ruta y tabId antes de ejecutar archivos de la extensión', async () => {
  const browser = browserFor([
    { id: 1, url: 'https://claufrias.github.io/otro/' },
    { id: 2, url: 'https://claufrias.github.io/a4studio-otro/' },
    { id: 3, url: 'https://claufrias.github.io.evil.test/a4studio/' },
    { id: 4, url: 'https://carrefour360.carrefour.com.ar/pricing-other' },
    { id: 5, url: 'https://carrefour360.carrefour.com.ar/login' },
    { id: 6, url: 'http://carrefour360.carrefour.com.ar/pricing' },
    { id: 7, url: 'https://carrefour360.carrefour.com.ar.evil.test/pricing' },
    { id: 8, url: 'file:///a4studio/index.html' },
    { id: -1, url: 'https://claufrias.github.io/a4studio/' },
    { id: 0, url: 'https://claufrias.github.io/a4studio/' },
    { id: '9', url: 'https://claufrias.github.io/a4studio/' },
    { id: 10.5, url: 'https://claufrias.github.io/a4studio/' },
    { id: 11 }, null
  ]);
  assert.equal(await attachOpenTabs(browser), 0);
  assert.deepEqual(browser.injections, []);
});

test('una pestaña cerrada o sin permisos no impide conectar las demás', async () => {
  const browser = browserFor([
    { id: 1, url: 'https://claufrias.github.io/a4studio/' },
    { id: 2, url: 'https://claufrias.github.io/a4studio/index.html' },
    { id: 3, url: 'https://carrefour360.carrefour.com.ar/pricing' }
  ], { rejectTab: 1 });
  assert.equal(await attachOpenTabs(browser), 2);
  assert.deepEqual(browser.injections.map((entry) => entry.target.tabId), [1, 2, 3]);
  const unavailable = browserFor([], { rejectQuery: true });
  assert.equal(await attachOpenTabs(unavailable), 0);
  assert.deepEqual(unavailable.injections, []);
});

test('onInstalled conecta pestañas en instalación, sin reinyección automática al actualizar', async () => {
  let installed;
  const browser = browserFor([{ id: 1, url: 'https://claufrias.github.io/a4studio/' }]);
  browser.runtime = {
    onMessage: { addListener() {} },
    onInstalled: { addListener(callback) { installed = callback; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extensions/carrefour360/service-worker.js'), 'utf8'), {
    chrome: browser, URL, setTimeout, clearTimeout
  });
  assert.equal(typeof installed, 'function');
  await installed({ reason: 'chrome_update' });
  await installed({ reason: 'shared_module_update' });
  await installed({ reason: 'update', previousVersion: '1.0.2' });
  assert.equal(browser.injections.length, 0);
  await installed({ reason: 'install' });
  assert.equal(browser.injections.length, 1);
  assert.equal(browser.queries.length, 1);
});
