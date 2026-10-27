'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lookup } = require('../extensions/carrefour360/catalog-images.js');

const EAN = '7790895000997';
const IMAGE = 'https://carrefourar.vteximg.com.br/arquivos/ids/332148/7790895000997_E01.jpg?v=639148981511530000';
const PRODUCT = 'https://www.carrefour.com.ar/gaseosa-cola-coca-cola-sabor-original-225-lts-30138/p';
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
const product = (overrides = {}) => ({
  productName: 'Gaseosa cola Coca Cola sabor original 2,25 lts', link: PRODUCT,
  items: [{ ean: EAN, name: 'Gaseosa cola Coca Cola sabor original 2,25 lts', images: [{ imageUrl: IMAGE }] }],
  ...overrides
});
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });
const picture = (data = JPEG, mime = 'image/jpeg') => new Response(data, { headers: { 'content-type': mime } });
const fails = (code) => (error) => error.code === code && typeof error.message === 'string' && error.message.length > 10;

function fetches(catalog = [product()], image = () => picture()) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? json(catalog) : image();
    }
  };
}

test('consulta el catálogo por EAN exacto y trae solo la imagen permitida sin enviar sesión', async () => {
  const f = fetches();
  const result = await lookup(EAN, f);
  assert.deepEqual(result, {
    ean: EAN, descripcion: product().productName, imageUrl: IMAGE, productUrl: PRODUCT,
    source: 'Carrefour.com.ar', imageDataUrl: `data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`
  });
  assert.equal(f.calls[0].url, `https://www.carrefour.com.ar/api/catalog_system/pub/products/search?fq=alternateIds_Ean%3A${EAN}`);
  assert.equal(f.calls[1].url, IMAGE);
  for (const { options } of f.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
  }
});

test('conserva ceros y no acepta coincidencias de nombre, prefijo ni EAN de otra variante', async () => {
  const code = '0012345678905';
  const f = fetches([product({ items: [
    { ean: '12345678905', name: 'OTRA VARIANTE', images: [{ imageUrl: IMAGE }] },
    { ean: code, name: '  Variante\n exacta ', images: [{ imageUrl: IMAGE }] }
  ] })]);
  const result = await lookup(code, f);
  assert.equal(result.ean, code);
  assert.equal(result.descripcion, 'Variante exacta');
  assert.ok(f.calls[0].url.endsWith(code));
  for (const catalog of [[], [product({ items: [{ ean: 1234, images: [{ imageUrl: IMAGE }] }] })], [product()]]) {
    const other = fetches(catalog);
    await assert.rejects(lookup(code, other), fails('IMAGE_NOT_FOUND'));
    assert.equal(other.calls.length, 1);
  }
});

test('EAN inválido no hace solicitudes y la descripción queda acotada', async () => {
  for (const ean of [null, 7790895000997, '123', '1'.repeat(15), '7790895000997&url=http://evil.test']) {
    await assert.rejects(lookup(ean, { fetch: () => assert.fail('Invalid code fetched') }), fails('INVALID_EAN'));
  }
  const f = fetches([product({ items: [{ ean: EAN, name: 'x'.repeat(500), images: [{ imageUrl: IMAGE }] }] })]);
  assert.equal((await lookup(EAN, f)).descripcion.length, 250);
});

test('no descarga URLs ajenas, credenciales, redirecciones ni rutas manipuladas', async () => {
  for (const imageUrl of [
    'https://evil.test/arquivos/ids/332148/product.jpg',
    'http://carrefourar.vteximg.com.br/arquivos/ids/332148/product.jpg',
    'https://carrefourar.vteximg.com.br.evil.test/arquivos/ids/332148/product.jpg',
    'https://user:pass@carrefourar.vteximg.com.br/arquivos/ids/332148/product.jpg',
    'https://carrefourar.vteximg.com.br:8443/arquivos/ids/332148/product.jpg',
    'https://carrefourar.vteximg.com.br/arquivos/ids/332148/product.jpg#fragment',
    'https://carrefourar.vteximg.com.br/arquivos/ids/332148/%2e%2e%2fprivate.jpg',
    'https://carrefourar.vteximg.com.br/private/product.jpg',
    'https://carrefourar.vteximg.com.br/arquivos/ids/332148/product.svg'
  ]) {
    const f = fetches([product({ items: [{ ean: EAN, images: [{ imageUrl }] }] })]);
    await assert.rejects(lookup(EAN, f), fails('IMAGE_INVALID'));
    assert.equal(f.calls.length, 1, imageUrl);
  }
  const f = fetches([product({ link: 'https://evil.test/product/p' })]);
  await assert.rejects(lookup(EAN, f), fails('IMAGE_INVALID'));
  assert.equal(f.calls.length, 1);
  const redirect = fetches([product()], () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }));
  await assert.rejects(lookup(EAN, redirect), fails('IMAGE_UNAVAILABLE'));
});

test('busca una imagen válida de la variante exacta y rechaza falta de imagen', async () => {
  const f = fetches([product({ items: [{ ean: EAN, name: 'Producto correcto', images: [
    { imageUrl: 'https://evil.test/image.jpg' }, { imageUrl: IMAGE }
  ] }] })]);
  assert.equal((await lookup(EAN, f)).imageUrl, IMAGE);
  const empty = fetches([product({ items: [{ ean: EAN, images: [] }] })]);
  await assert.rejects(lookup(EAN, empty), fails('IMAGE_NOT_FOUND'));
});

test('acepta PNG y WebP y rechaza HTML, SVG o MIME distinto a la firma', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const webp = new TextEncoder().encode('RIFF1234WEBP0000');
  for (const [bytes, mime] of [[png, 'image/png'], [webp, 'image/webp']]) {
    const result = await lookup(EAN, fetches([product()], () => picture(bytes, mime)));
    assert.ok(result.imageDataUrl.startsWith(`data:${mime};base64,`));
  }
  for (const [bytes, mime] of [[JPEG, 'text/html'], [JPEG, 'image/png'], [new TextEncoder().encode('<svg/>'), 'image/svg+xml'], [new TextEncoder().encode('<html>error</html>'), 'image/jpeg']]) {
    await assert.rejects(lookup(EAN, fetches([product()], () => picture(bytes, mime))), fails('IMAGE_INVALID'));
  }
});

test('limita JSON e imagen tanto por encabezado como durante la lectura', async () => {
  const oversizedCatalog = () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) } });
  await assert.rejects(lookup(EAN, { fetch: oversizedCatalog }), fails('IMAGE_INVALID'));
  const imageTooLarge = new Uint8Array(4 * 1024 * 1024 + 1);
  imageTooLarge.set(JPEG);
  await assert.rejects(lookup(EAN, fetches([product()], () => picture(imageTooLarge))), fails('IMAGE_INVALID'));
  const imageHeader = fetches([product()], () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg', 'content-length': String(4 * 1024 * 1024 + 1) } }));
  await assert.rejects(lookup(EAN, imageHeader), fails('IMAGE_INVALID'));
  await assert.rejects(lookup(EAN, { fetch: () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }) }), fails('IMAGE_INVALID'));
});

test('respuestas ajenas al formato y fallos de red producen errores controlados', async () => {
  for (const value of [{ error: 'login' }, null, 'HTML']) {
    await assert.rejects(lookup(EAN, fetches(value)), fails('IMAGE_INVALID'));
  }
  await assert.rejects(lookup(EAN, { fetch: () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) }), fails('IMAGE_INVALID'));
  await assert.rejects(lookup(EAN, { fetch: () => { throw new TypeError('Failed to fetch'); } }), fails('IMAGE_UNAVAILABLE'));
  await assert.rejects(lookup(EAN, { fetch: () => new Response('Denied', { status: 403 }) }), fails('IMAGE_UNAVAILABLE'));
  const redirected = json([product()]);
  Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(lookup(EAN, { fetch: () => redirected }), fails('IMAGE_UNAVAILABLE'));
});

test('el plazo total aborta la búsqueda sin esperar una respuesta infinita', async () => {
  let signal;
  await assert.rejects(lookup(EAN, { timeoutMs: 5, fetch: (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), fails('IMAGE_TIMEOUT'));
  assert.equal(signal.aborted, true);
});
