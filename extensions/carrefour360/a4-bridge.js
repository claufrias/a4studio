(function (root) {
  'use strict';

  const REQUEST_SOURCE = 'a4studio-carrefour360';
  const RESPONSE_SOURCE = 'carrefour360-a4studio';
  const CHANNEL = 'a4studio-carrefour360-internal';
  const INSTALL_KEY = '__a4studioCarrefourBridge';

  function isAllowedLocation(location) {
    return (location.origin === 'https://claufrias.github.io'
      || (location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname)))
      && location.pathname.startsWith('/a4studio/');
  }

  function validRequest(request) {
    return !!request && typeof request === 'object' && !Array.isArray(request)
      && request.source === REQUEST_SOURCE && request.version === 1
      && typeof request.id === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(request.id)
      && (request.action === 'presence' || request.action === 'status'
        || (request.action === 'lookup' && typeof request.ean === 'string' && /^\d{1,14}$/.test(request.ean)));
  }

  function install(window, runtime) {
    if (window.top !== window || !isAllowedLocation(window.location)) return;
    let version = null;
    try { version = runtime.getManifest().version; } catch (_) {}
    const previous = window[INSTALL_KEY];
    if (previous && previous.runtime === runtime && previous.version === version) {
      previous.announce();
      return previous;
    }
    if (previous) previous.dispose();
    let active = true;
    let pricingTabId = null;
    const pending = new Set();

    function reply(id, response) {
      if (!active) return;
      window.postMessage({ source: RESPONSE_SOURCE, version: 1, id, ...response }, window.location.origin);
    }

    function announce() {
      if (!active) return;
      try {
        // Do not announce an invalidated extension context as available.
        if (!runtime.getManifest().version) return;
        window.postMessage({ source: RESPONSE_SOURCE, version: 1, action: 'ready' }, window.location.origin);
      } catch (_) {}
    }

    const listener = async (event) => {
      if (!active || event.source !== window || event.origin !== window.location.origin || !validRequest(event.data)) return;
      const request = event.data;
      if (pending.has(request.id)) return;
      // Presence is independent from Pricing and never opens or queries a tab.
      if (request.action === 'presence') {
        try {
          const extensionVersion = runtime.getManifest().version;
          if (typeof extensionVersion !== 'string' || !extensionVersion) throw new Error('Invalid extension context');
          reply(request.id, { ok: true, result: { installed: true, extensionVersion } });
        } catch (_) {
          reply(request.id, { ok: false, error: { code: 'EXTENSION_UNAVAILABLE', message: 'Recargá A4 Studio después de instalar o actualizar la extensión.' } });
        }
        return;
      }
      if (pending.size >= 8) {
        reply(request.id, { ok: false, error: { code: 'PRICING_BUSY', message: 'Hay varias consultas pendientes. Esperá unos segundos.' } });
        return;
      }
      if (request.action === 'lookup' && !pricingTabId) {
        reply(request.id, { ok: false, error: { code: 'NOT_CONNECTED', message: 'Conectá Carrefour360 antes de consultar un producto.' } });
        return;
      }
      pending.add(request.id);
      try {
        const response = await runtime.sendMessage({
          channel: CHANNEL, version: 1, id: request.id, action: request.action,
          ...(request.action === 'lookup' ? { ean: request.ean, pricingTabId } : {})
        });
        if (request.action === 'status') {
          pricingTabId = response && response.ok === true && response.result && response.result.ready === true
            && Number.isInteger(response.result.pricingTabId) ? response.result.pricingTabId : null;
        }
        if (response && response.ok === true && response.result) {
          reply(request.id, { ok: true, result: response.result });
        } else if (response && response.ok === false && response.error
          && typeof response.error.code === 'string' && typeof response.error.message === 'string') {
          reply(request.id, { ok: false, error: response.error });
        } else {
          reply(request.id, { ok: false, error: { code: 'INVALID_RESPONSE', message: 'La extensión devolvió una respuesta no válida.' } });
        }
      } catch (_) {
        pricingTabId = null;
        reply(request.id, { ok: false, error: { code: 'EXTENSION_UNAVAILABLE', message: 'Recargá A4 Studio y Pricing después de instalar o actualizar la extensión.' } });
      } finally {
        pending.delete(request.id);
      }
    };
    const installation = {
      runtime, version, announce,
      dispose() {
        active = false;
        window.removeEventListener?.('message', listener);
        if (window[INSTALL_KEY] === installation) delete window[INSTALL_KEY];
      }
    };
    window[INSTALL_KEY] = installation;
    window.addEventListener('message', listener);
    announce();
    return installation;
  }

  if (typeof module === 'object' && module.exports) module.exports = { isAllowedLocation, validRequest, install };
  if (root.window && root.chrome && root.chrome.runtime) install(root.window, root.chrome.runtime);
})(globalThis);
