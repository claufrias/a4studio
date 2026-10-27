(function (root) {
  'use strict';

  const CATALOG_URL = 'https://www.carrefour.com.ar/api/catalog_system/pub/products/search';
  const IMAGE_ORIGIN = 'https://carrefourar.vteximg.com.br';
  const JSON_LIMIT = 2 * 1024 * 1024;
  const IMAGE_LIMIT = 4 * 1024 * 1024;
  const MESSAGES = {
    INVALID_EAN: 'Ingresá un código de barras de 4 a 14 dígitos.',
    IMAGE_NOT_FOUND: 'Carrefour no tiene una imagen disponible para ese código de barras.',
    IMAGE_UNAVAILABLE: 'No pudimos obtener la imagen de Carrefour. Volvé a intentar.',
    IMAGE_INVALID: 'Carrefour devolvió una imagen o datos que no pudimos usar.',
    IMAGE_TIMEOUT: 'La búsqueda de imagen tardó demasiado. Volvé a intentar.'
  };

  function failure(code) {
    return Object.assign(new Error(MESSAGES[code]), { code });
  }

  function trustedImageUrl(value) {
    try {
      if (typeof value !== 'string' || value.length > 2000) return null;
      const url = new URL(value);
      if (url.origin !== IMAGE_ORIGIN || url.username || url.password || url.hash) return null;
      const path = /^\/arquivos\/ids\/[1-9]\d{0,15}(?:-\d{1,5}-\d{1,5})?\/([^/]+)$/.exec(url.pathname);
      if (!path) return null;
      const filename = decodeURIComponent(path[1]);
      if (!/^[^/\\?#\u0000-\u001f]{1,240}\.(?:jpe?g|png|webp)$/i.test(filename)) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function trustedProductUrl(value) {
    try {
      if (typeof value !== 'string' || value.length > 2000) return null;
      const url = new URL(value);
      return url.origin === 'https://www.carrefour.com.ar' && !url.username && !url.password && !url.hash
        && /^\/[^/]+\/p$/.test(url.pathname) ? url.href : null;
    } catch (_) { return null; }
  }

  async function readLimited(response, limit) {
    if (!response || response.status !== 200 || response.redirected) throw failure('IMAGE_UNAVAILABLE');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > limit) throw failure('IMAGE_INVALID');
    if (!response.body || typeof response.body.getReader !== 'function') throw failure('IMAGE_INVALID');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel();
          throw failure('IMAGE_INVALID');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!total) throw failure('IMAGE_INVALID');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  function selectImage(products, ean) {
    if (!Array.isArray(products)) throw failure('IMAGE_INVALID');
    let untrustedImage = false;
    for (const product of products) {
      if (!product || !Array.isArray(product.items)) continue;
      for (const item of product.items) {
        if (!item || item.ean !== ean || !Array.isArray(item.images)) continue;
        for (const image of item.images) {
          const imageUrl = trustedImageUrl(image && image.imageUrl);
          if (!imageUrl) { untrustedImage = true; continue; }
          const productUrl = trustedProductUrl(product.link);
          const name = typeof item.name === 'string' ? item.name : product.productName;
          const descripcion = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, 250) : '';
          if (!productUrl || !descripcion) throw failure('IMAGE_INVALID');
          return { ean, descripcion, imageUrl, productUrl, source: 'Carrefour.com.ar' };
        }
      }
    }
    throw failure(untrustedImage ? 'IMAGE_INVALID' : 'IMAGE_NOT_FOUND');
  }

  function imageMime(response, bytes) {
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const matches = mime === 'image/jpeg' && bytes.length >= 3
      && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      || mime === 'image/png' && bytes.length >= 8
      && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
      || mime === 'image/webp' && bytes.length >= 12
      && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
    if (!matches) throw failure('IMAGE_INVALID');
    return mime;
  }

  function base64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return root.btoa(binary);
  }

  async function lookup(ean, options = {}) {
    if (typeof ean !== 'string' || !/^\d{4,14}$/.test(ean)) throw failure('INVALID_EAN');
    const fetch = options.fetch || root.fetch;
    if (typeof fetch !== 'function') throw failure('IMAGE_UNAVAILABLE');
    const controller = new AbortController();
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 15000) : 15000;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(failure('IMAGE_TIMEOUT')); }, timeoutMs);
    });
    const requestOptions = {
      method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal
    };
    async function run() {
      const catalog = await fetch(`${CATALOG_URL}?fq=${encodeURIComponent(`alternateIds_Ean:${ean}`)}`, {
        ...requestOptions, headers: { Accept: 'application/json' }
      });
      const catalogBytes = await readLimited(catalog, JSON_LIMIT);
      if (!/^application\/json(?:;|$)/i.test(catalog.headers.get('content-type') || '')) throw failure('IMAGE_INVALID');
      let products;
      try { products = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)); }
      catch (_) { throw failure('IMAGE_INVALID'); }
      const result = selectImage(products, ean);
      const image = await fetch(result.imageUrl, { ...requestOptions, headers: { Accept: 'image/jpeg,image/png,image/webp' } });
      const bytes = await readLimited(image, IMAGE_LIMIT);
      return { ...result, imageDataUrl: `data:${imageMime(image, bytes)};base64,${base64(bytes)}` };
    }
    try { return await Promise.race([run(), deadline]); }
    catch (error) {
      if (error && Object.hasOwn(MESSAGES, error.code)) throw error;
      throw failure(controller.signal.aborted ? 'IMAGE_TIMEOUT' : 'IMAGE_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }

  const api = { lookup };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.A4CarrefourImages = api;
})(globalThis);
