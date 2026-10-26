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
  emit(type) {
    const event = {
      type, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

function fixture(t, { initialModal = false, storage = new Map(), denyStorage = false } = {}) {
  const ids = ['Modal', 'Retry', 'Message', 'Open', 'Hint', 'Later', 'Close', 'Link'];
  const elements = Object.fromEntries(ids.map((id) => [id, Object.assign(new Target(), {
    textContent: '', disabled: false
  })]));
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
  assert.match(f.elements.Message.textContent, /No recibimos respuesta/);
});

test('una extensión presente no muestra el aviso ni solicita una sesión de Pricing', async (t) => {
  const f = fixture(t);
  await f.present();
  assert.equal(f.dialog.shown, 0);
  assert.match(f.elements.Hint.textContent, /Extensión detectada/);
  assert.equal(f.elements.Open.textContent, 'Comprobar extensión');
  assert.equal(f.storage.has(STORAGE_KEY), false, 'detectar la extensión no equivale a descartar el aviso');
  const nextPage = fixture(t, { storage: f.storage });
  assert.equal(nextPage.requests.length, 1, 'una nueva entrada debe comprobar si la extensión sigue disponible');
  await nextPage.absent();
  assert.equal(nextPage.dialog.open, true, 'se avisa si la extensión dejó de estar disponible');
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

test('reintentar con éxito cierra el aviso y confirma la extensión en el panel', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.elements.Retry.emit('click');
  assert.equal(f.elements.Retry.disabled, true);
  await f.present();
  assert.equal(f.dialog.open, false);
  assert.equal(f.elements.Retry.disabled, false);
  assert.match(f.elements.Hint.textContent, /Extensión detectada/);
  assert.equal(f.storage.has(STORAGE_KEY), false, 'el reintento exitoso tampoco recuerda un descarte');
});

test('un reintento pendiente no vuelve a abrir el aviso después de descartarlo', async (t) => {
  const f = fixture(t);
  await f.absent();
  f.elements.Retry.emit('click');
  f.elements.Later.emit('click');
  await f.absent();
  f.notify();
  assert.equal(f.dialog.open, false);
  assert.equal(f.dialog.shown, 1);
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
  assert.equal(f.dialog.open, false);
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
