'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {}, Intl });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../promotion-picker.js'), 'utf8'), context);
const { create } = context.window.A4PromotionPicker;
const promotions = [
  { type: 'dni', name: 'Cuenta DNI', percent: 10, preview: 'fondodni.jpg' },
  { type: 'carrefour', name: 'Cuenta Digital · 15%', percent: 15, preview: 'fondobanco.jpg' },
  { type: 'carrefour10', name: 'Cuenta Digital · 10%', percent: 10, preview: 'fondobanco10.png' },
  { type: 'consumo', name: 'Consumo inmediato', manual: true, preview: 'consumo.svg' }
];

class Element {
  constructor(document) {
    this.document = document;
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.tabIndex = 0;
    this.isConnected = true;
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this[name]; delete this.attributes[name]; }
  focus() { this.document.activeElement = this; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  async emit(type, overrides = {}) {
    const event = {
      type, key: '', defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...overrides
    };
    await Promise.all([...(this.listeners.get(type) || [])].map((handler) => handler(event)));
    return event;
  }
}

function fixture(t, { apply } = {}) {
  const document = {};
  const ids = ['Title', 'PreviewImage', 'PreviewName', 'PreviewDetail', 'PricePreview',
    'PickerStatus', 'Confirm', 'Cancel', 'Close', 'Scope', 'ScopeThis', 'ScopeAll'];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element(document)]));
  elements.Title.tabIndex = -1;
  const modal = new Element(document);
  const trigger = new Element(document);
  document.activeElement = trigger;
  const cards = promotions.map((promotion) => {
    const card = new Element(document);
    card.dataset.fondoOption = promotion.type;
    card.badge = new Element(document);
    card.badge.hidden = true;
    card.querySelector = (selector) => {
      assert.equal(selector, '[data-current-badge]');
      return card.badge;
    };
    return card;
  });
  const focusOrder = [elements.Close, ...cards, elements.ScopeThis, elements.ScopeAll, elements.Confirm, elements.Cancel];
  modal.querySelectorAll = (selector) => selector === '[data-fondo-option]' ? cards : focusOrder;
  for (const radio of [elements.ScopeThis, elements.ScopeAll]) {
    radio.getClientRects = () => elements.Scope.hidden ? [] : [{}];
  }
  document.getElementById = (id) => {
    if (id === 'modalFondo') return modal;
    if (id === 'promotionPickerTitle') return elements.Title;
    return elements[id.replace('promotion', '')];
  };
  const images = [];
  const window = {
    document,
    getComputedStyle: (element) => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible' }),
    Image: class { constructor() { images.push(this); } }
  };
  const applications = [];
  let closes = 0;
  let controller;
  controller = create({
    targetWindow: window, promotions,
    apply: async (type, all) => {
      applications.push({ type, all });
      return apply ? apply(type, all) : true;
    },
    requestClose: () => { closes += 1; controller.closed(); }
  });
  t.after(() => controller.destroy());
  return {
    controller, modal, elements, cards, images, applications, document, trigger,
    closes: () => closes,
    choose: (type) => cards.find((card) => card.dataset.fondoOption === type).emit('click'),
    load: (index = images.length - 1) => images[index].onload(),
    fail: (index = images.length - 1) => images[index].onerror(),
    open: (state = {}) => controller.open({ normalCents: 299050, allowAll: true, ...state })
  };
}

test('elegir una tarjeta solo prepara la vista previa; confirmar aplica una vez al cartel actual', async (t) => {
  const f = fixture(t);
  f.open({ allowAll: false });
  assert.equal(f.elements.Confirm.disabled, true);
  assert.equal(f.elements.Scope.hidden, true);
  await f.choose('carrefour10');
  assert.equal(f.applications.length, 0);
  assert.equal(f.elements.Confirm.disabled, true, 'espera a que se cargue el fondo');
  f.load();
  assert.equal(f.elements.PreviewImage.src, 'fondobanco10.png');
  assert.equal(f.elements.PreviewImage.hidden, false);
  assert.match(f.elements.PricePreview.textContent, /2\.990,50/);
  assert.match(f.elements.PricePreview.textContent, /2\.691,45/);
  assert.equal(f.elements.PricePreview.hidden, false);
  f.elements.ScopeAll.checked = true;
  await f.elements.Confirm.emit('click');
  assert.deepEqual(f.applications, [{ type: 'carrefour10', all: false }]);
  assert.equal(f.closes(), 1);
  assert.equal(f.document.activeElement, f.trigger);
});

test('la etiqueta Actual sigue al fondo aplicado y cancelar no modifica el cartel', async (t) => {
  const f = fixture(t);
  f.open({ currentType: 'carrefour' });
  f.load();
  await f.choose('carrefour10');
  assert.equal(f.cards[1].badge.hidden, false);
  assert.equal(f.cards[2].badge.hidden, true);
  assert.equal(f.cards[1].attributes['aria-pressed'], 'false');
  assert.equal(f.cards[2].attributes['aria-pressed'], 'true');
  await f.elements.Cancel.emit('click');
  assert.equal(f.applications.length, 0);
  f.open({ currentType: 'carrefour' });
  assert.equal(f.cards[1].attributes['aria-pressed'], 'true');
  assert.equal(f.elements.ScopeThis.checked, true);
  assert.equal(f.elements.ScopeAll.checked, false);
});

test('la carga tardía de otro fondo no habilita ni cambia la vista previa seleccionada', async (t) => {
  const f = fixture(t);
  f.open();
  await f.choose('dni');
  await f.choose('carrefour10');
  f.load(0);
  assert.equal(f.elements.Confirm.disabled, true);
  f.fail(0);
  assert.equal(f.elements.PickerStatus.textContent, 'Cargando vista previa…');
  f.load(1);
  assert.equal(f.elements.PreviewImage.src, 'fondobanco10.png');
  assert.equal(f.elements.Confirm.disabled, false);
});

test('confirmar captura el alcance y bloquea cambios, cierres y aplicaciones duplicadas durante la carga', async (t) => {
  let finish;
  const f = fixture(t, { apply: () => new Promise((resolve) => { finish = resolve; }) });
  f.open();
  await f.choose('carrefour10'); f.load();
  f.elements.ScopeAll.checked = true;
  const pending = f.elements.Confirm.emit('click');
  assert.equal(f.controller.busy, true);
  assert.ok(f.cards.every((card) => card.disabled));
  assert.equal(f.elements.ScopeAll.disabled, true);
  assert.equal(f.elements.Cancel.disabled, true);
  assert.equal(f.controller.open({ currentType: 'dni' }), false);
  await f.elements.Confirm.emit('click');
  await f.choose('dni');
  await f.elements.Close.emit('click');
  await f.modal.emit('keydown', { key: 'Escape' });
  assert.equal(f.closes(), 0);
  f.elements.ScopeAll.checked = false;
  assert.deepEqual(f.applications, [{ type: 'carrefour10', all: true }]);
  finish(true);
  await pending;
  assert.equal(f.controller.busy, false);
  assert.equal(f.closes(), 1);
});

test('una aplicación fallida mantiene la selección abierta y permite reintentar', async (t) => {
  let attempt = 0;
  const f = fixture(t, { apply: () => {
    attempt += 1;
    if (attempt === 1) return false;
    if (attempt === 2) throw new Error('El cartel cambió. Volvé a confirmar.');
    return true;
  } });
  f.open({ required: true });
  await f.choose('carrefour10'); f.load();
  await f.elements.Confirm.emit('click');
  assert.equal(f.closes(), 0);
  assert.match(f.elements.PickerStatus.textContent, /No se pudo aplicar/);
  assert.equal(f.elements.Confirm.disabled, false);
  await f.elements.Confirm.emit('click');
  assert.match(f.elements.PickerStatus.textContent, /El cartel cambió/);
  assert.equal(f.closes(), 0);
  await f.elements.Confirm.emit('click');
  assert.equal(f.closes(), 1, 'la selección inicial solo se libera después de aplicar');
});

test('Consumo explica su descuento manual y un fondo que no carga impide confirmar', async (t) => {
  const f = fixture(t);
  f.open();
  await f.choose('consumo');
  assert.equal(f.elements.PreviewDetail.textContent, 'Ingresás el descuento de cada producto.');
  assert.doesNotMatch(f.elements.PricePreview.textContent, /\$/);
  f.fail();
  assert.equal(f.elements.Confirm.disabled, true);
  assert.match(f.elements.PickerStatus.textContent, /No se pudo cargar/);
  await f.elements.Confirm.emit('click');
  assert.equal(f.applications.length, 0);
  await f.choose('dni'); f.load();
  assert.equal(f.elements.Confirm.disabled, false);
});

test('la selección inicial no puede cerrarse y su alcance siempre empieza en este cartel', async (t) => {
  const f = fixture(t);
  f.open({ required: true, allowAll: false });
  assert.equal(f.elements.Close.hidden, true);
  assert.equal(f.elements.Cancel.hidden, true);
  await f.elements.Close.emit('click');
  await f.elements.Cancel.emit('click');
  const escape = await f.modal.emit('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  assert.equal(f.closes(), 0);
  assert.equal(f.elements.ScopeThis.checked, true);
});

test('el teclado queda en el selector, conserva Tab y evita los atajos del canvas', async (t) => {
  const f = fixture(t);
  f.open({ currentType: 'dni' }); f.load();
  assert.equal(f.document.activeElement, f.elements.Title);
  await f.modal.emit('keydown', { key: 'Tab' });
  assert.equal(f.document.activeElement, f.elements.Close);
  await f.modal.emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(f.document.activeElement, f.elements.Cancel);
  await f.modal.emit('keydown', { key: 'Tab' });
  assert.equal(f.document.activeElement, f.elements.Close);
  const undo = await f.modal.emit('keydown', { key: 'z', ctrlKey: true });
  assert.equal(undo.defaultPrevented, true);
  assert.equal(undo.propagationStopped, true);
  const escape = await f.modal.emit('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(f.closes(), 1);
  assert.equal(f.document.activeElement, f.trigger);
});

test('al cerrar restaura el botón capturado antes de que el editor quede oculto', async (t) => {
  const f = fixture(t);
  const hiddenPageFocus = new Element(f.document);
  f.document.activeElement = hiddenPageFocus;
  f.open({ trigger: f.trigger });
  assert.equal(f.document.activeElement, f.elements.Title);
  await f.elements.Cancel.emit('click');
  assert.equal(f.document.activeElement, f.trigger);
});

test('cerrar o destruir ignora vistas previas pendientes y retira los controles', async (t) => {
  const f = fixture(t);
  f.open();
  await f.choose('dni');
  f.controller.closed();
  f.load();
  assert.equal(f.elements.PreviewImage.hidden, true);
  f.open();
  await f.choose('carrefour10');
  f.controller.destroy();
  f.load();
  await f.elements.Confirm.emit('click');
  await f.choose('dni');
  assert.equal(f.applications.length, 0);
  assert.equal(f.elements.PreviewImage.hidden, true);
});
