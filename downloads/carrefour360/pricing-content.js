(function (root) {
  'use strict';

  const CHANNEL = 'a4studio-carrefour360-internal';
  const LOOKUP_TIMEOUT_MS = 15000;

  function parseDecimalCents(value) {
    const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
  }

  function parseDisplayedPrice(value) {
    const match = /^\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?$/.exec(String(value ?? '').trim());
    return match ? parseDecimalCents(`${match[1].replace(/,/g, '')}.${match[2] || '00'}`) : null;
  }

  function failure(code, message) {
    return { ok: false, error: { code, message } };
  }

  function getControls(document) {
    return {
      input: document.querySelector('#ean_product_value'),
      button: document.querySelector('#btn_ean_product'),
      content: document.querySelector('#pricing_content'),
      loading: document.querySelector('#loadingContainer')
    };
  }

  function isLoading(document, environment) {
    const loading = document.querySelector('#loadingContainer');
    if (!loading || loading.hidden) return false;
    let style = loading.style;
    try {
      if (typeof environment.getComputedStyle === 'function') style = environment.getComputedStyle(loading);
    } catch (_) { /* A detached element may no longer have computed styles. */ }
    if (style && (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility))) return false;
    if (typeof loading.getClientRects === 'function' && loading.getClientRects().length === 0) return false;
    return true;
  }

  function isPricingLocation(environment) {
    // Unit fixtures do not need a real browser location.
    if (!environment.location) return true;
    return environment.location.origin === 'https://carrefour360.carrefour.com.ar'
      && ['/pricing', '/pricing/'].includes(environment.location.pathname);
  }

  function readProduct(content, ean, previousDescription) {
    const description = content.querySelector('#description');
    if (!description || description === previousDescription || !description.textContent.trim()) return null;
    const priceCell = content.querySelector('#td_data');
    if (!priceCell) return null;
    const rawPrice = priceCell.getAttribute('data-price');
    // Only #td_data is the verified PVP cell; never search other price/stock cells.
    const price = rawPrice === null ? parseDisplayedPrice(priceCell.textContent) : parseDecimalCents(rawPrice);
    if (price === null) return failure('INVALID_PRICE', 'El PVP recibido no es válido.');
    return { ok: true, result: {
      ean,
      descripcion: description.textContent.trim().replace(/\s+/g, ' '),
      precioNormalCentavos: price,
      consultadoEn: new Date().toISOString(),
      source: 'Carrefour360',
      tienda: null
    } };
  }

  function createQueryRunner(document, environment) {
    let busy = false;

    function status() {
      const { input, button, content } = getControls(document);
      return isPricingLocation(environment) && input && button && content
        ? { ok: true, result: { ready: true } }
        : failure('LOGIN_REQUIRED', 'Iniciá sesión en Carrefour360 y abrí Pricing.');
    }

    async function lookup(ean, timeoutMs = LOOKUP_TIMEOUT_MS) {
      if (typeof ean !== 'string' || !/^\d{1,14}$/.test(ean)) return failure('INVALID_REQUEST', 'El EAN no es válido.');
      if (busy) return failure('PRICING_BUSY', 'Hay otra consulta en curso.');
      const { input, button, content } = getControls(document);
      if (!isPricingLocation(environment) || !input || !button || !content) return failure('LOGIN_REQUIRED', 'Iniciá sesión en Carrefour360 y abrí Pricing.');
      if (isLoading(document, environment)) return failure('PRICING_BUSY', 'Hay una consulta en curso en Pricing. Esperá a que termine.');
      busy = true;
      const previousDescription = content.querySelector('#description');
      try {
        return await new Promise((resolve) => {
          let settled = false;
          let timer;
          const finish = (result) => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            environment.clearTimeout(timer);
            input.removeEventListener('input', onInputChange);
            input.removeEventListener('change', onInputChange);
            resolve(result);
          };
          const onInputChange = () => finish(failure('INPUT_CHANGED', 'Se editó el EAN de la consulta.'));
          const check = () => {
            const currentControls = getControls(document);
            if (!isPricingLocation(environment) || currentControls.input !== input
              || !currentControls.button || !currentControls.content) {
              finish(failure('LOGIN_REQUIRED', 'La sesión de Pricing cambió. Volvé a iniciar sesión.'));
              return;
            }
            if (input.value !== ean) {
              finish(failure('INPUT_CHANGED', 'El EAN de la consulta cambió.'));
              return;
            }
            if (isLoading(document, environment)) return;
            const product = readProduct(currentControls.content, ean, previousDescription);
            if (product) finish(product);
          };
          const observer = new environment.MutationObserver(check);
          observer.observe(document.documentElement, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['data-price', 'style', 'class', 'hidden']
          });
          const deadline = Number.isInteger(timeoutMs) && timeoutMs > 0
            ? Math.min(timeoutMs, LOOKUP_TIMEOUT_MS) : LOOKUP_TIMEOUT_MS;
          timer = environment.setTimeout(() => finish(failure('PRICING_TIMEOUT', 'Carrefour360 no respondió a tiempo.')), deadline);
          try {
            input.value = ean;
            input.addEventListener('input', onInputChange);
            input.addEventListener('change', onInputChange);
            // This is the verified search control, not an activation/label/price action.
            button.click();
            check();
          } catch (_) {
            finish(failure('PRICING_NOT_READY', 'No se pudo iniciar la consulta de Pricing.'));
          }
        });
      } finally { busy = false; }
    }

    return { status, lookup };
  }

  function install(document, runtime, environment) {
    const runner = createQueryRunner(document, environment);
    runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!sender || sender.id !== runtime.id || !request || request.channel !== CHANNEL || request.version !== 1) return false;
      if (request.action === 'status') {
        sendResponse(runner.status());
        return false;
      }
      if (request.action === 'lookup') {
        runner.lookup(request.ean, request.timeoutMs).then(sendResponse);
        return true;
      }
      return false;
    });
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { parseDecimalCents, parseDisplayedPrice, readProduct, isLoading, createQueryRunner, install };
  }
  if (root.document && root.chrome && root.chrome.runtime) install(root.document, root.chrome.runtime, root);
})(globalThis);
