'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../promotion-picker.js'), 'utf8'), context);
const { create } = context.window.A4PromotionPicker;
const promotions = [
  { type: 'dni', name: 'Cuenta DNI', percent: 10 },
  { type: 'carrefour', name: 'Cuenta Digital · 15%', percent: 15 },
  { type: 'carrefour10', name: 'Cuenta Digital · 10%', percent: 10 },
  { type: 'consumo', name: 'Consumo inmediato', manual: true }
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
  const ids = ['Title', 'PickerStatus', 'Confirm', 'Cancel', 'Close', 'Scope', 'ScopeThis', 'ScopeAll'];
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
    const element = elements[id.replace('promotion', '')];
    assert.ok(element, `control inesperado: ${id}`);
    return element;
  };
  const window = {
    document,
    getComputedStyle: (element) => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible' }),
    Image: class { constructor() { throw new Error('El selector no debe cargar imágenes de vista previa'); } }
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
    controller, modal, elements, cards, applications, document, trigger,
    closes: () => closes,
    choose: (type) => cards.find((card) => card.dataset.fondoOption === type).emit('click'),
    open: (state = {}) => controller.open({ allowAll: true, ...state })
  };
}

test('elegir una tarjeta habilita confirmar sin cargar imágenes ni modificar el cartel', async (t) => {
  const f = fixture(t);
  f.open({ allowAll: false });
  assert.equal(f.elements.Confirm.disabled, true);
  assert.equal(f.elements.Scope.hidden, true);
  await f.choose('carrefour10');
  assert.equal(f.applications.length, 0);
  assert.equal(f.elements.Confirm.disabled, false, 'la confirmación queda disponible inmediatamente');
  f.elements.ScopeAll.checked = true;
  await f.elements.Confirm.emit('click');
  assert.deepEqual(f.applications, [{ type: 'carrefour10', all: false }]);
  assert.equal(f.closes(), 1);
  assert.equal(f.document.activeElement, f.trigger);
});

test('la etiqueta Actual sigue al fondo aplicado y cancelar no modifica el cartel', async (t) => {
  const f = fixture(t);
  f.open({ currentType: 'carrefour' });
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

test('cambiar de tarjeta aplica únicamente la última selección al confirmar', async (t) => {
  const f = fixture(t);
  f.open();
  await f.choose('dni');
  await f.choose('carrefour10');
  assert.equal(f.applications.length, 0);
  assert.equal(f.cards[0].attributes['aria-pressed'], 'false');
  assert.equal(f.cards[2].attributes['aria-pressed'], 'true');
  assert.equal(f.elements.Confirm.disabled, false);
  await f.elements.Confirm.emit('click');
  assert.deepEqual(f.applications, [{ type: 'carrefour10', all: false }]);
});

test('confirmar captura el alcance y bloquea cambios, cierres y aplicaciones duplicadas durante la carga', async (t) => {
  let finish;
  const f = fixture(t, { apply: () => new Promise((resolve) => { finish = resolve; }) });
  f.open();
  await f.choose('carrefour10');
  f.elements.ScopeAll.checked = true;
  f.elements.Confirm.focus();
  const pending = f.elements.Confirm.emit('click');
  assert.equal(f.controller.busy, true);
  assert.equal(f.document.activeElement, f.elements.Title, 'el foco sigue dentro del diálogo al deshabilitar confirmar');
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
  await f.choose('carrefour10');
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

test('Consumo explica su descuento manual y permite confirmarlo sin vista previa', async (t) => {
  const f = fixture(t);
  f.open();
  await f.choose('consumo');
  assert.equal(f.elements.PickerStatus.textContent, 'Consumo inmediato: ingresás el descuento de cada producto.');
  assert.equal(f.elements.Confirm.disabled, false);
  assert.equal(f.applications.length, 0);
  await f.elements.Confirm.emit('click');
  assert.deepEqual(f.applications, [{ type: 'consumo', all: false }]);
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
  f.open({ currentType: 'dni' });
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

test('cerrar o destruir ignora aplicaciones pendientes y retira los controles', async (t) => {
  let finish;
  const f = fixture(t, { apply: () => new Promise((resolve) => { finish = resolve; }) });
  f.open();
  await f.choose('dni');
  const pending = f.elements.Confirm.emit('click');
  f.controller.closed();
  f.open({ currentType: 'carrefour10' });
  finish(true);
  await pending;
  assert.equal(f.closes(), 0, 'la respuesta anterior no cierra una selección nueva');
  assert.equal(f.cards[2].attributes['aria-pressed'], 'true');
  f.controller.destroy();
  await f.elements.Confirm.emit('click');
  await f.choose('dni');
  assert.deepEqual(f.applications, [{ type: 'dni', all: false }]);
});
