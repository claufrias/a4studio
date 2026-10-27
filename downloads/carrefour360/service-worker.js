(function (root) {
  'use strict';

  if (typeof root.importScripts === 'function') root.importScripts('catalog-images.js');
  const imageCatalog = typeof module === 'object' && module.exports
    ? require('./catalog-images.js') : root.A4CarrefourImages;
  const CHANNEL = 'a4studio-carrefour360-internal';
  const PRICING_URL = 'https://carrefour360.carrefour.com.ar/pricing';
  const TRANSPORT_TIMEOUT_MS = 18000;
  const OPEN_TAB_PATTERNS = [
    'https://claufrias.github.io/a4studio/*',
    'http://localhost/a4studio/*',
    'http://127.0.0.1/a4studio/*',
    `${PRICING_URL}*`
  ];

  function isA4Url(value) {
    try {
      const url = new URL(value);
      const allowedHost = url.origin === 'https://claufrias.github.io'
        || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
      return allowedHost && url.pathname.startsWith('/a4studio/');
    } catch (_) { return false; }
  }

  function isPricingUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://carrefour360.carrefour.com.ar'
        && ['/pricing', '/pricing/'].includes(url.pathname);
    } catch (_) { return false; }
  }

  async function attachOpenTabs(browser) {
    let tabs;
    try { tabs = await browser.tabs.query({ url: OPEN_TAB_PATTERNS }); }
    catch (_) { return 0; }
    if (!Array.isArray(tabs)) return 0;
    const results = await Promise.all(tabs.map(async (tab) => {
      if (!tab || !Number.isSafeInteger(tab.id) || tab.id <= 0) return false;
      const file = isA4Url(tab.url) ? 'a4-bridge.js'
        : isPricingUrl(tab.url) ? 'pricing-content.js' : null;
      if (!file) return false;
      try {
        // Declarative scripts cover future navigations; attach to tabs that were
        // already open before installation without reloading their editor state.
        await browser.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] }, files: [file]
        });
        return true;
      } catch (_) {
        // A tab may close or navigate, or its site permission may be withheld.
        return false;
      }
    }));
    return results.filter(Boolean).length;
  }

  function validEan(value) {
    return typeof value === 'string' && /^\d{1,14}$/.test(value);
  }

  function validRequest(request) {
    return !!request && typeof request === 'object' && !Array.isArray(request)
      && request.channel === CHANNEL && request.version === 1
      && typeof request.id === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(request.id)
      && (request.action === 'status'
        || (request.action === 'image' && typeof request.ean === 'string' && /^\d{4,14}$/.test(request.ean))
        || (request.action === 'lookup' && validEan(request.ean)
          && Number.isInteger(request.pricingTabId) && request.pricingTabId > 0));
  }

  function failure(code, message) {
    return { ok: false, error: { code, message } };
  }

  function withTimeout(promise, milliseconds) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('PRICING_TIMEOUT')), milliseconds);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function validProduct(product, ean) {
    return !!product && product.ean === ean && validEan(product.ean)
      && typeof product.descripcion === 'string' && product.descripcion.trim().length > 0
      && product.descripcion.length <= 1000
      && Number.isSafeInteger(product.precioNormalCentavos) && product.precioNormalCentavos >= 0
      && typeof product.consultadoEn === 'string' && Number.isFinite(Date.parse(product.consultadoEn))
      && product.source === 'Carrefour360';
  }

  function normalizeFailure(response) {
    const errors = {
      LOGIN_REQUIRED: 'Iniciá sesión en Carrefour360 y abrí Pricing.',
      PRICING_NOT_READY: 'Pricing todavía no está listo. Esperá y volvé a conectar.',
      PRICING_TIMEOUT: 'Carrefour360 no respondió a tiempo. Volvé a consultar.',
      INPUT_CHANGED: 'La consulta de Carrefour360 cambió. Volvé a consultar el producto.',
      PRODUCT_NOT_FOUND: 'Carrefour360 no encontró el producto.',
      INVALID_PRICE: 'Carrefour360 devolvió un PVP que no se pudo interpretar.',
      PRICING_BUSY: 'Hay otra consulta en curso en Pricing. Esperá unos segundos.'
    };
    const code = response && response.error && response.error.code;
    return Object.hasOwn(errors, code)
      ? failure(code, errors[code])
      : failure('INVALID_RESPONSE', 'La respuesta de Carrefour360 no es válida.');
  }

  function createController(browser, options = {}) {
    const queues = new Map();
    const lookupImage = options.lookupImage || ((ean) => imageCatalog.lookup(ean));

    async function image(ean) {
      const errors = {
        INVALID_EAN: 'Ingresá un código de barras de 4 a 14 dígitos.',
        IMAGE_NOT_FOUND: 'Carrefour no tiene una imagen disponible para ese código de barras.',
        IMAGE_UNAVAILABLE: 'No pudimos obtener la imagen de Carrefour. Volvé a intentar.',
        IMAGE_INVALID: 'Carrefour devolvió una imagen o datos que no pudimos usar.',
        IMAGE_TIMEOUT: 'La búsqueda de imagen tardó demasiado. Volvé a intentar.'
      };
      try {
        return { ok: true, result: await lookupImage(ean) };
      } catch (error) {
        const code = error && Object.hasOwn(errors, error.code) ? error.code : 'IMAGE_UNAVAILABLE';
        return failure(code, errors[code]);
      }
    }

    async function sendToPricing(tabId, request, timeoutMs = TRANSPORT_TIMEOUT_MS) {
      try {
        return await withTimeout(browser.tabs.sendMessage(tabId, {
          channel: CHANNEL, version: 1, action: request.action, ean: request.ean,
          timeoutMs: Math.max(1, Math.min(15000, timeoutMs - 250))
        }), timeoutMs);
      } catch (error) {
        if (error.message === 'PRICING_TIMEOUT') return failure('PRICING_TIMEOUT', 'Carrefour360 no respondió a tiempo.');
        return failure('PRICING_NOT_READY', 'Recargá la pestaña Pricing después de instalar la extensión.');
      }
    }

    async function status() {
      const tabs = (await browser.tabs.query({ url: `${PRICING_URL}*` }))
        .filter((tab) => Number.isInteger(tab.id) && isPricingUrl(tab.url));
      if (!tabs.length) {
        await browser.tabs.create({ url: PRICING_URL });
        return failure('PRICING_NOT_OPEN', 'Se abrió Carrefour360. Iniciá sesión, abrí Pricing y volvé a conectar.');
      }
      if (tabs.length > 1) {
        return failure('MULTIPLE_PRICING_TABS', 'Hay varias pestañas Pricing. Dejá abierta solo la sucursal que querés consultar y volvé a conectar.');
      }
      const tab = tabs[0];
      const response = await sendToPricing(tab.id, { action: 'status' });
      if (!response || response.ok !== true || !response.result || response.result.ready !== true) return normalizeFailure(response);
      return { ok: true, result: { ready: true, pricingTabId: tab.id, pricingUrl: tab.url } };
    }

    async function lookup(request, remainingMs) {
      let tab;
      try { tab = await browser.tabs.get(request.pricingTabId); }
      catch (_) { return failure('PRICING_NOT_OPEN', 'La pestaña Pricing se cerró. Volvé a conectar.'); }
      if (!isPricingUrl(tab.url)) return failure('LOGIN_REQUIRED', 'Iniciá sesión y volvé a abrir Pricing.');
      const response = await sendToPricing(tab.id, request, remainingMs);
      if (!response || response.ok !== true) return normalizeFailure(response);
      if (!validProduct(response.result, request.ean)) return failure('INVALID_RESPONSE', 'La respuesta de Carrefour360 no coincide con el producto consultado.');
      const product = response.result;
      return { ok: true, result: {
        ean: product.ean,
        descripcion: product.descripcion.trim(),
        precioNormalCentavos: product.precioNormalCentavos,
        consultadoEn: product.consultadoEn,
        source: 'Carrefour360',
        tienda: typeof product.tienda === 'string' && product.tienda.length <= 200 ? product.tienda : null
      } };
    }

    function enqueue(tabId, operation) {
      const previous = queues.get(tabId) || Promise.resolve();
      const queuedAt = Date.now();
      let expired = false;
      const current = previous.catch(() => {}).then(() => {
        if (expired) return failure('PRICING_TIMEOUT', 'La consulta venció mientras esperaba.');
        const remainingMs = TRANSPORT_TIMEOUT_MS - (Date.now() - queuedAt);
        if (remainingMs <= 250) return failure('PRICING_TIMEOUT', 'La consulta venció mientras esperaba.');
        return operation(remainingMs);
      });
      queues.set(tabId, current);
      current.finally(() => {
        if (queues.get(tabId) === current) queues.delete(tabId);
      }).catch(() => {});
      return withTimeout(current, TRANSPORT_TIMEOUT_MS).catch(() => {
        expired = true;
        return failure('PRICING_TIMEOUT', 'Carrefour360 no respondió a tiempo.');
      });
    }

    async function handle(request, sender) {
      if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)
        || sender.frameId !== 0 || !isA4Url(sender.url)) {
        return failure('UNAUTHORIZED_ORIGIN', 'Esta página no puede consultar Carrefour360.');
      }
      if (!validRequest(request)) return failure('INVALID_REQUEST', 'La consulta de producto no es válida.');
      try {
        if (request.action === 'image') return await image(request.ean);
        if (request.action === 'status') return await status();
        return await enqueue(request.pricingTabId, (remainingMs) => lookup(request, remainingMs));
      } catch (_) {
        return failure('CONNECTION_ERROR', 'No se pudo comunicar con Carrefour360. Volvé a conectar.');
      }
    }

    return { handle };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { CHANNEL, isA4Url, isPricingUrl, validEan, validRequest, validProduct, createController, attachOpenTabs };
  }
  if (root.chrome && root.chrome.runtime && root.chrome.tabs) {
    const controller = createController(root.chrome);
    root.chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!request || request.channel !== CHANNEL) return false;
      controller.handle(request, sender).then(sendResponse);
      return true;
    });
    root.chrome.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') {
        return attachOpenTabs(root.chrome);
      }
    });
  }
})(globalThis);
