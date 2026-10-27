'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../carrefour-onboarding.js'), 'utf8'), context);
const { start } = context.window.A4CarrefourOnboarding;
const STORAGE_KEY = 'a4studio.carrefour.install.dismissed';
const settle = () => new Promise((resolve) => setImmediate(resolve));

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, overrides = {}) {
    const event = {
      type, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...overrides
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

function fixture(t, { initialModal = false, storage = new Map(), denyStorage = false } = {}) {
  const ids = ['Modal', 'Retry', 'Message', 'Open', 'Hint', 'Later', 'Close', 'Link',
    'Title', 'Description', 'Steps', 'Ready', 'Done', 'Pricing'];
  const elements = Object.fromEntries(ids.map((id) => [id, Object.assign(new Target(), {
    textContent: '', disabled: false, hidden: false
  })]));
  elements.Ready.hidden = true;
  const dialog = elements.Modal;
  dialog.open = false;
  dialog.shown = 0;
  dialog.showModal = () => { dialog.open = true; dialog.shown += 1; };
  dialog.close = () => { dialog.open = false; };
  const otherModal = { style: { display: initialModal ? 'flex' : 'none' } };
  const document = Object.assign(new Target(), {
    visibilityState: 'visible',
    getElementById: (id) => elements[id.replace('carrefourInstall', '')],
    querySelectorAll: (selector) => {
      assert.ok(['.modal, dialog[open]', '.modal, dialog'].includes(selector));
      return selector === '.modal, dialog' || dialog.open ? [otherModal, dialog] : [otherModal];
    }
  });
  let notify;
  let disconnected = false;
  const window = Object.assign(new Target(), {
    document,
    location: {
      origin: 'https://claufrias.github.io',
      reload() { assert.fail('Installing the extension must not reload the editor'); }
    },
    open() { assert.fail('An installation announcement must not open Pricing'); },
    getComputedStyle: (element) => ({ display: element === dialog ? (dialog.open ? 'block' : 'none') : element.style.display }),
    sessionStorage: {
      getItem(key) { if (denyStorage) throw new Error('Storage denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (denyStorage) throw new Error('Storage denied'); storage.set(key, value); }
    },
    MutationObserver: class {
      constructor(callback) { notify = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    }
  });
  const requests = [];
  let destroyed = false;
  const client = {
    detect() { return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
    connect() { assert.fail('Presence must not connect to Pricing'); },
    lookup() { assert.fail('Presence must not look up a product'); },
    destroy() {
      destroyed = true;
      requests.forEach((request) => request.reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })));
    }
  };
  const controller = start({ targetWindow: window, client });
  t.after(() => controller.destroy());
  return {
    elements, dialog, otherModal, document, window, requests, controller, storage,
    ready: (overrides = {}) => window.emit('message', {
      source: window, origin: window.location.origin,
      data: { source: 'carrefour360-a4studio', version: 1, action: 'ready' },
      ...overrides
    }),
    notify: () => { if (!disconnected) notify(); },
    absent: async (index = requests.length - 1) => {
      requests[index].reject(Object.assign(new Error('Not detected'), { code: 'EXTENSION_NOT_AVAILABLE' }));
      await settle();
    },
    present: async (index = requests.length - 1) => {
      requests[index].resolve({ installed: true, extensionVersion: '1.0.2' });
      await settle();
    },
    destroyed: () => destroyed,
    disconnected: () => disconnected
  };
}

test('espera al cierre del selector inicial antes de mostrar el aviso, sin abrir Pricing', async (t) => {
  const f = fixture(t, { initialModal: true });
  assert.equal(f.requests.length, 1);
  await f.absent();
  assert.equal(f.dialog.open, false);
  f.otherModal.style.display = 'none';
  f.notify();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements.Message.textContent, '', 'la explicación inicial no debe incluir un error');
  assert.equal(f.elements.Steps.hidden, false);
  assert.equal(f.elements.Ready.hidden, true);
});

test('una extensión presente muestra los pasos para conectar sin abrir Pricing', async (t) => {
  const f = fixture(t);
  await f.present();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements.Title.textContent, '¡La herramienta está instalada!');
  assert.equal(f.elements.Steps.hidden, true);
  assert.equal(f.elements.Ready.hidden, false);
  assert.match(f.elements.Hint.textContent, /La herramienta está instalada/);
  assert.equal(f.elements.Open.textContent, 'Ver cómo conectar Carrefour360');
  assert.equal(f.storage.has(STORAGE_KEY), false, 'detectar la extensión no equivale a descartar el aviso');
  const nextPage = fixture(t, { storage: f.storage });
  assert.equal(nextPage.requests.length, 1, 'una nueva entrada debe comprobar si la extensión sigue disponible');
  await nextPage.absent();
  assert.equal(nextPage.dialog.open, true, 'se avisa si la extensión dejó de estar disponible');
});

test('los pasos para conectar también esperan al selector inicial de plantilla', async (t) => {
  const f = fixture(t, { initialModal: true });
  await f.present();
  assert.equal(f.dialog.open, false);
  assert.equal(f.elements.Ready.hidden, false);
  f.otherModal.style.display = 'none';
  f.notify();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements.Title.textContent, '¡La herramienta está instalada!');
});

test('cede el foco a otro modal y recupera el aviso sin recordar un descarte', async (t) => {
  const f = fixture(t);
  await f.absent();
  assert.equal(f.dialog.open, true);
  f.otherModal.style.display = 'flex';
  f.notify();
  assert.equal(f.dialog.open, false, 'el diálogo nativo no debe bloquear el modal del editor');
  assert.equal(f.storage.has(STORAGE_KEY), false);
  f.notify();
  assert.equal(f.dialog.open, false, 'no vuelve a abrirse mientras el otro modal siga visible');
  f.otherModal.style.display = 'none';
  f.notify();
  assert.equal(f.dialog.open, true, 'retoma el aviso al terminar el otro modal');
  assert.equal(f.dialog.shown, 2);
  assert.equal(f.storage.has(STORAGE_KEY), false);
});

test('seguir sin extensión, cerrar y Escape recuerdan la decisión durante la sesión', async (t) => {
  for (const action of ['Later', 'Close', 'Escape']) {
    const storage = new Map();
    const f = fixture(t, { storage });
    await f.absent();
    if (action === 'Escape') assert.equal(f.dialog.emit('cancel').defaultPrevented, true);
    else f.elements[action].emit('click');
    assert.equal(f.dialog.open, false, action);
    assert.equal(storage.get(STORAGE_KEY), 'true', action);
    f.notify();
    assert.equal(f.dialog.open, false, action);
    const nextPage = fixture(t, { storage });
    assert.equal(nextPage.requests.length, 0, action);
    nextPage.elements.Open.emit('click');
    assert.equal(nextPage.requests.length, 1, 'la comprobación manual sigue disponible');
    await nextPage.present();
  }
});

test('reintentar con éxito pasa de la instalación a los pasos para conectar', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.elements.Retry.emit('click');
  assert.equal(f.elements.Retry.disabled, true);
  await f.present();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements.Retry.disabled, false);
  assert.equal(f.elements.Retry.textContent, 'Ya la instalé');
  assert.equal(f.elements.Title.textContent, '¡La herramienta está instalada!');
  assert.equal(f.elements.Steps.hidden, true);
  assert.equal(f.elements.Ready.hidden, false);
  assert.match(f.elements.Hint.textContent, /La herramienta está instalada/);
  assert.equal(f.storage.has(STORAGE_KEY), false, 'el reintento exitoso tampoco recuerda un descarte');
});

test('la guía se puede cerrar, recuerda la decisión y se puede recuperar desde el panel', async (t) => {
  for (const action of ['Done', 'Pricing', 'Close', 'Escape']) {
    const f = fixture(t);
    await f.present();
    if (action === 'Escape') assert.equal(f.dialog.emit('cancel').defaultPrevented, true);
    else f.elements[action].emit('click');
    assert.equal(f.dialog.open, false, action);
    assert.equal(f.storage.get(STORAGE_KEY), 'true', action);
    f.notify();
    assert.equal(f.dialog.open, false, action);
    const nextPage = fixture(t, { storage: f.storage });
    assert.equal(nextPage.requests.length, 0, action);
    nextPage.elements.Open.emit('click');
    await nextPage.present();
    assert.equal(nextPage.dialog.open, true, 'el panel permite volver a leer los pasos');
    assert.equal(nextPage.elements.Ready.hidden, false);
  }
});

test('un reintento fallido muestra ayuda solo después de pedir comprobar la instalación', async (t) => {
  const f = fixture(t);
  await f.absent();
  assert.equal(f.elements.Message.textContent, '');
  f.elements.Retry.emit('click');
  await f.absent();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements.Steps.hidden, false);
  assert.equal(f.elements.Ready.hidden, true);
  assert.ok(f.elements.Message.textContent.trim().length > 0, 'el fallo del reintento debe explicar qué hacer');
  assert.equal(f.elements.Retry.textContent, 'Ya la instalé');
});

test('un reintento pendiente no vuelve a abrir el aviso después de descartarlo', async (t) => {
  for (const result of ['absent', 'present']) {
    const f = fixture(t);
    await f.absent();
    f.elements.Retry.emit('click');
    f.elements.Later.emit('click');
    await f[result]();
    f.notify();
    assert.equal(f.dialog.open, false, result);
    assert.equal(f.dialog.shown, 1, result);
  }
});

test('clics repetidos no duplican una comprobación pendiente', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.elements.Retry.emit('click');
  f.elements.Retry.emit('click');
  f.elements.Open.emit('click');
  assert.equal(f.requests.length, 2);
  await f.present();
});

test('abrir la tienda no consulta Pricing y reintenta solo al volver al editor', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.elements.Link.emit('click');
  assert.equal(f.requests.length, 1);
  f.document.visibilityState = 'hidden';
  f.window.emit('focus');
  assert.equal(f.requests.length, 1);
  f.document.visibilityState = 'visible';
  f.document.emit('visibilitychange');
  f.window.emit('focus');
  assert.equal(f.requests.length, 2);
  await f.present();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements.Ready.hidden, false);
});

test('la instalación en una página abierta inicia una nueva comprobación sin recargar', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.ready();
  assert.equal(f.requests.length, 2, 'el aviso de instalación debe pedir una prueba nueva de presencia');
  assert.equal(f.elements.Ready.hidden, true, 'el aviso no basta para confirmar que la herramienta funciona');
  await f.present();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements.Ready.hidden, false);
  assert.equal(f.elements.Title.textContent, '¡La herramienta está instalada!');
});

test('la instalación que llega durante la primera comprobación se verifica al terminar esta', async (t) => {
  const f = fixture(t);
  f.ready();
  f.ready();
  f.ready();
  assert.equal(f.requests.length, 1, 'se acumula una sola comprobación posterior');
  await f.absent(0);
  assert.equal(f.requests.length, 2, 'la solicitud enviada antes de instalar no debe dejar el editor sin detectar');
  assert.equal(f.elements.Ready.hidden, true);
  await f.present(1);
  assert.equal(f.elements.Ready.hidden, false);
  assert.equal(f.requests.length, 2);
});

test('ignora avisos de instalación de otra ventana, origen, versión o formato', async (t) => {
  const f = fixture(t);
  await f.absent();
  for (const overrides of [
    { source: {} },
    { origin: 'https://otro.example' },
    { data: { source: 'other', version: 1, action: 'ready' } },
    { data: { source: 'carrefour360-a4studio', version: 2, action: 'ready' } },
    { data: { source: 'carrefour360-a4studio', version: 1, action: 'presence' } },
    { data: null },
    { data: [] },
    { data: 'ready' }
  ]) f.ready(overrides);
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.Ready.hidden, true);
});

test('un aviso de instalación espera a que la pestaña vuelva a estar visible', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.document.visibilityState = 'hidden';
  f.ready();
  f.window.emit('focus');
  assert.equal(f.requests.length, 1);
  f.document.visibilityState = 'visible';
  f.document.emit('visibilitychange');
  f.window.emit('focus');
  assert.equal(f.requests.length, 2, 'los eventos de retorno no deben duplicar la comprobación');
  await f.present();
  assert.equal(f.elements.Ready.hidden, false);
});

test('descartar la guía cancela una comprobación pendiente solicitada por el aviso de instalación', async (t) => {
  for (const result of ['absent', 'present']) {
    const f = fixture(t);
    await f.absent();
    f.elements.Retry.emit('click');
    f.ready();
    f.elements.Later.emit('click');
    await f[result]();
    f.notify();
    assert.equal(f.requests.length, 2, result);
    assert.equal(f.dialog.open, false, result);
  }
});

test('la instalación no vuelve a abrir un aviso descartado ni revive una integración destruida', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.elements.Later.emit('click');
  f.ready();
  assert.equal(f.requests.length, 1);
  assert.equal(f.dialog.open, false);
  const nextPage = fixture(t, { storage: f.storage });
  nextPage.ready();
  assert.equal(nextPage.requests.length, 0, 'un descarte recordado se sigue respetando');
  const destroyed = fixture(t);
  destroyed.controller.destroy();
  await settle();
  destroyed.ready();
  assert.equal(destroyed.requests.length, 1);
  assert.equal(destroyed.dialog.open, false);
});

test('funciona con almacenamiento bloqueado y no interfiere con atajos del editor', async (t) => {
  const f = fixture(t, { denyStorage: true });
  await f.absent();
  const keyboard = f.dialog.emit('keydown');
  assert.equal(keyboard.propagationStopped, true);
  assert.equal(keyboard.defaultPrevented, false, 'se mantiene el manejo nativo de Tab y Escape');
  f.elements.Later.emit('click');
  f.notify();
  f.window.emit('focus');
  assert.equal(f.dialog.open, false);
});

test('el aviso se aparta al imprimir y espera mientras la página está oculta', async (t) => {
  const f = fixture(t);
  f.document.visibilityState = 'hidden';
  await f.absent();
  assert.equal(f.dialog.open, false);
  f.document.visibilityState = 'visible';
  f.document.emit('visibilitychange');
  assert.equal(f.dialog.open, true);
  f.window.emit('beforeprint');
  assert.equal(f.dialog.open, false);
  f.notify();
  assert.equal(f.dialog.open, false);
  f.window.emit('afterprint');
  assert.equal(f.dialog.open, true);
});

test('destruir la integración retira los listeners e ignora respuestas pendientes', async (t) => {
  const f = fixture(t);
  f.controller.destroy();
  await settle();
  f.elements.Open.emit('click');
  f.notify();
  assert.equal(f.requests.length, 1);
  assert.equal(f.dialog.open, false);
  assert.equal(f.destroyed(), true);
  assert.equal(f.disconnected(), true);
});
