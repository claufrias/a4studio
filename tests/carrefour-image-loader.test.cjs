'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('    function loadImageFromDataUrl(');
const end = html.indexOf('    function loadImageFromFile(', start);
assert.ok(start >= 0 && end > start, 'El cargador de imágenes debe existir en el editor');
const loaderSource = html.slice(start, end);

function fixture() {
  const images = [];
  const events = [];
  const statuses = [];
  const previous = { srcData: 'data:image/png;base64,anterior', img: {}, x: 10, y: 20 };
  class DeferredImage {
    constructor() { this.width = 800; this.height = 600; images.push(this); }
    set src(value) { this.source = value; }
  }
  const context = vm.createContext({
    Image: DeferredImage,
    CANVAS_W: 900,
    imagenObj: previous,
    cropActive: true,
    cropMode: true,
    cropSessionOriginalState: { previous: true },
    lastCropRect: { x: 1 },
    selected: 'producto',
    cropTool: { rect: { old: true }, reset() { events.push('resetCrop'); } },
    updateCropUI() { events.push('cropUI'); },
    mostrarHeaderTools() { events.push('header'); },
    updateView() { events.push('view'); },
    captureStateChange(message) { events.push({ history: message, image: context.imagenObj }); },
    setImageSearchStatus(message, warning = false) { statuses.push({ message, warning }); }
  });
  vm.runInContext(loaderSource, context);
  return { context, images, events, statuses, previous, load: context.loadImageFromDataUrl };
}

test('si cambia el destino durante la decodificación conserva la imagen y el historial anteriores', async () => {
  const f = fixture();
  let currentPage = 'page-1';
  const targetPage = currentPage;
  const pending = f.load('data:image/png;base64,nueva', 'Foto agregada', 'Imagen de Carrefour', {
    shouldApply: () => currentPage === targetPage,
    beforeApply: () => assert.fail('No debe modificar el historial de otra página')
  });
  assert.equal(f.context.imagenObj, f.previous);
  currentPage = 'page-2';
  f.images[0].onload();
  assert.equal(await pending, false);
  assert.equal(f.context.imagenObj, f.previous);
  assert.equal(f.context.cropMode, true);
  assert.equal(f.context.cropActive, true);
  assert.equal(f.context.selected, 'producto');
  assert.deepEqual(f.events, []);
  assert.equal(f.statuses.at(-1).warning, true);
});

test('aceptar la foto guarda el estado previo antes del reemplazo y registra una sola imagen nueva', async () => {
  const f = fixture();
  let beforeImage;
  const dataUrl = 'data:image/png;base64,nueva';
  const pending = f.load(dataUrl, 'Foto agregada', 'Imagen de Carrefour', {
    shouldApply: () => true,
    beforeApply() {
      beforeImage = f.context.imagenObj;
      f.events.push('savePrevious');
    }
  });
  assert.equal(f.events.length, 0, 'La decodificación no debe modificar el cartel antes de terminar');
  f.images[0].onload();
  assert.equal(await pending, true);
  assert.equal(beforeImage, f.previous);
  assert.notEqual(f.context.imagenObj, f.previous);
  assert.equal(f.context.imagenObj.img, f.images[0]);
  assert.equal(f.context.imagenObj.srcData, dataUrl);
  const history = f.events.filter((event) => typeof event === 'object');
  assert.equal(history.length, 1);
  assert.equal(history[0].history, 'Imagen de Carrefour');
  assert.equal(history[0].image, f.context.imagenObj);
  assert.equal(f.events[0], 'savePrevious', 'Guardar el estado anterior precede a cualquier cambio de imagen');
  assert.equal(f.context.cropMode, false);
  assert.equal(f.context.selected, 'img');
  assert.deepEqual(f.statuses.at(-1), { message: 'Foto agregada', warning: false });
});

test('una imagen que no se puede decodificar conserva el cartel y no guarda cambios de imagen', async () => {
  const f = fixture();
  const pending = f.load('data:image/png;base64,invalida', 'Foto agregada', 'Imagen de Carrefour', {
    shouldApply: () => true,
    beforeApply: () => assert.fail('Una imagen fallida no debe guardar ni reemplazar el estado')
  });
  f.images[0].onerror();
  assert.equal(await pending, false);
  assert.equal(f.context.imagenObj, f.previous);
  assert.equal(f.context.cropMode, true);
  assert.equal(f.context.selected, 'producto');
  assert.deepEqual(f.events, []);
  assert.equal(f.statuses.at(-1).warning, true);
});
