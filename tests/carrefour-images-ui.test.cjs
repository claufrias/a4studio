'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../carrefour-images-ui.js'), 'utf8'), context);
const { start } = context.window.A4CarrefourImagesUi;

class Element {
  constructor() { this.listeners = new Map(); this.disabled = false; this.hidden = false; this.textContent = ''; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  removeAttribute(name) { delete this[name]; }
  emit(type) { return Promise.all([...(this.listeners.get(type) || [])].map((listener) => listener({ type }))); }
}

function picture(ean = '0012345678905', overrides = {}) {
  return { ean, descripcion: 'PRODUCTO DE PRUEBA',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    imageUrl: 'https://carrefourar.vteximg.com.br/arquivos/ids/123/foto.png',
    productUrl: 'https://www.carrefour.com.ar/producto-de-prueba/p',
    source: 'Carrefour.com.ar', ...overrides };
}

function fixture(t, { ignoreCancel = false, applyImage } = {}) {
  const elements = Object.fromEntries(['Search', 'Preview', 'Photo', 'Caption', 'Source', 'Use', 'Status']
    .map((name) => [name, new Element()]));
  elements.Preview.hidden = true;
  elements.Use.disabled = true;
  const current = { pageId: 'page-1', ean: '0012345678905', consumo: false, image: { src: 'old-photo' } };
  let allowed = true;
  let destroyed = false;
  let cancellations = 0;
  const requests = [];
  const applications = [];
  const cancel = () => {
    cancellations += 1;
    if (!ignoreCancel) for (const request of requests) {
      request.reject(Object.assign(new Error('Consulta cancelada'), { code: 'CANCELLED' }));
    }
  };
  const client = {
    image(ean) { return new Promise((resolve, reject) => requests.push({ ean, resolve, reject })); },
    connect() { assert.fail('Buscar fotos no debe conectar Pricing'); },
    lookup() { assert.fail('Buscar fotos no debe consultar el precio'); },
    cancelPending: cancel,
    destroy() { destroyed = true; cancel(); }
  };
  const controller = start({
    targetWindow: { document: { getElementById: (id) => elements[id.replace('carrefourImage', '')] } },
    client,
    getTarget: () => ({ ...current }),
    isCurrentTarget: (target) => ['pageId', 'ean', 'consumo', 'image'].every((key) => current[key] === target[key]),
    canApply: () => allowed,
    applyImage: async (dataUrl, target) => {
      applications.push({ dataUrl, target });
      if (applyImage) return applyImage(dataUrl, target);
      current.image = { src: dataUrl };
      return true;
    }
  });
  t.after(() => controller.destroy());
  return { elements, current, controller, requests, applications,
    setAllowed: (value) => { allowed = value; },
    cancelled: () => cancellations, destroyed: () => destroyed,
    async find(result = picture(current.ean)) {
      const pending = controller.find();
      requests.at(-1).resolve(result);
      await pending;
    }
  };
}

test('buscar muestra una vista previa y conserva la foto hasta confirmar Usar esta imagen', async (t) => {
  const f = fixture(t);
  const original = f.current.image;
  await f.find();
  assert.equal(f.requests[0].ean, '0012345678905');
  assert.equal(f.current.image, original);
  assert.equal(f.applications.length, 0);
  assert.equal(f.elements.Preview.hidden, false);
  assert.equal(f.elements.Photo.src, picture().imageDataUrl);
  assert.equal(f.elements.Photo.alt, picture().descripcion);
  assert.match(f.elements.Caption.textContent, /0012345678905/);
  assert.equal(f.elements.Source.href, picture().productUrl);
  assert.equal(f.elements.Use.disabled, false);
  await f.elements.Use.emit('click');
  assert.equal(f.applications.length, 1);
  assert.equal(f.current.image.src, picture().imageDataUrl);
  assert.equal(f.elements.Preview.hidden, true);
  assert.equal(f.elements.Use.disabled, true);
  assert.match(f.elements.Status.textContent, /Foto agregada/);
});

test('una búsqueda fallida no sustituye la foto existente ni deja una vista previa aplicable', async (t) => {
  const f = fixture(t);
  const original = f.current.image;
  const pending = f.controller.find();
  f.requests[0].reject(Object.assign(new Error('Carrefour no encontró una foto para este código.'), { code: 'IMAGE_NOT_FOUND' }));
  await pending;
  assert.equal(f.current.image, original);
  assert.equal(f.applications.length, 0);
  assert.equal(f.elements.Preview.hidden, true);
  assert.equal(f.elements.Use.disabled, true);
  assert.equal(f.elements.Search.disabled, false);
  assert.match(f.elements.Status.textContent, /no encontró/);
});

test('descarta respuestas tardías si cambia la página, el EAN, el modo o la imagen manual', async (t) => {
  const cases = [
    ['pageId', 'page-2'], ['ean', '7790895000997'], ['consumo', true], ['image', { src: 'manual-photo' }]
  ];
  for (const [key, value] of cases) {
    const f = fixture(t);
    const pending = f.controller.find();
    f.current[key] = value;
    f.requests[0].resolve(picture());
    await pending;
    assert.equal(f.elements.Preview.hidden, true, key);
    assert.equal(f.applications.length, 0, key);
    assert.equal(f.elements.Search.disabled, false, key);
    assert.match(f.elements.Status.textContent, /cartel cambió/, key);
  }
});

test('rechaza aplicar una candidata cuando el usuario reemplazó la imagen después de buscar', async (t) => {
  const f = fixture(t);
  await f.find();
  const manual = { src: 'new-manual-image' };
  f.current.image = manual;
  await f.controller.apply();
  assert.equal(f.current.image, manual);
  assert.equal(f.applications.length, 0);
  assert.equal(f.elements.Preview.hidden, true);
  assert.match(f.elements.Status.textContent, /cartel o su imagen cambiaron/);
});

test('no aplica fotos durante recorte o restauración aunque la vista previa ya esté lista', async (t) => {
  const f = fixture(t);
  await f.find();
  const original = f.current.image;
  f.setAllowed(false);
  await f.controller.apply();
  assert.equal(f.current.image, original);
  assert.equal(f.applications.length, 0);
  assert.equal(f.elements.Preview.hidden, true);
});

test('Consumo inmediato, un EAN inválido y una edición activa no consultan el catálogo', async (t) => {
  for (const kind of ['consumo', 'ean', 'editing']) {
    const f = fixture(t);
    if (kind === 'consumo') f.current.consumo = true;
    if (kind === 'ean') f.current.ean = '123';
    if (kind === 'editing') f.setAllowed(false);
    await f.controller.find();
    assert.equal(f.requests.length, 0, kind);
    assert.equal(f.elements.Preview.hidden, true, kind);
    assert.match(f.elements.Status.textContent, /código de barras/, kind);
  }
});

test('una búsqueda nueva cancela la anterior y una respuesta antigua no reemplaza la nueva', async (t) => {
  const f = fixture(t, { ignoreCancel: true });
  const first = f.controller.find();
  f.current.ean = '7790895000997';
  const second = f.controller.find();
  assert.equal(f.cancelled(), 2);
  f.requests[0].resolve(picture());
  await first;
  assert.equal(f.elements.Preview.hidden, true);
  assert.equal(f.elements.Search.disabled, true, 'la búsqueda nueva sigue pendiente');
  f.requests[1].resolve(picture(f.current.ean, { descripcion: 'COCA COLA' }));
  await second;
  assert.match(f.elements.Caption.textContent, /COCA COLA/);
  assert.equal(f.elements.Search.disabled, false);
});

test('invalidar el destino durante una búsqueda no deja deshabilitado el botón Buscar', async (t) => {
  const f = fixture(t);
  const pending = f.controller.find();
  assert.equal(f.elements.Search.disabled, true);
  f.current.ean = '';
  await f.controller.find();
  await pending;
  assert.equal(f.elements.Search.disabled, false);
  assert.equal(f.elements.Preview.hidden, true);
  assert.equal(f.requests.length, 1);
  assert.match(f.elements.Status.textContent, /código de barras/);
});

test('un fallo o rechazo del cargador no informa que la imagen se agregó', async (t) => {
  for (const mode of ['stale', 'error']) {
    const f = fixture(t, { applyImage: () => {
      if (mode === 'error') throw new Error('Decoder failed');
      return false;
    } });
    const original = f.current.image;
    await f.find();
    await f.controller.apply();
    assert.equal(f.current.image, original, mode);
    assert.doesNotMatch(f.elements.Status.textContent, /Foto agregada/, mode);
    assert.equal(f.elements.Search.disabled, false, mode);
    assert.match(f.elements.Status.textContent, /No se (aplicó|pudo agregar)/, mode);
  }
});

test('clics repetidos no aplican dos veces ni inician otra búsqueda mientras se decodifica', async (t) => {
  let finish;
  const f = fixture(t, { applyImage: () => new Promise((resolve) => { finish = resolve; }) });
  await f.find();
  const pending = f.controller.apply();
  await f.controller.apply();
  await f.controller.find();
  assert.equal(f.applications.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.Search.disabled, true);
  finish(false);
  await pending;
  assert.equal(f.elements.Search.disabled, false);
});

test('una foto que no se puede mostrar no queda disponible para aplicar', async (t) => {
  const f = fixture(t);
  await f.find();
  await f.elements.Photo.emit('error');
  await f.controller.apply();
  assert.equal(f.elements.Preview.hidden, true);
  assert.equal(f.applications.length, 0);
  assert.match(f.elements.Status.textContent, /No se pudo mostrar/);
});

test('destruir la integración cancela búsquedas y retira los controles', async (t) => {
  const f = fixture(t, { ignoreCancel: true });
  const pending = f.controller.find();
  f.controller.destroy();
  f.requests[0].resolve(picture());
  await pending;
  await f.elements.Search.emit('click');
  await f.elements.Use.emit('click');
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.Preview.hidden, true);
  assert.equal(f.applications.length, 0);
  assert.equal(f.destroyed(), true);
});
