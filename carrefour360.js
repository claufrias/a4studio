(function (root) {
  'use strict';

  const REQUEST_SOURCE = 'a4studio-carrefour360';
  const RESPONSE_SOURCE = 'carrefour360-a4studio';
  const VERSION = 1;
  const EAN_PATTERN = /^\d{4,14}$/;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  let clientSequence = 0;

  function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validDateTime(value) {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false;
    if (match[7] !== 'Z') {
      const hours = Number(match[7].slice(1, 3));
      const minutes = Number(match[7].slice(4, 6));
      if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
    }
    return true;
  }

  function validateProduct(value, expectedEan) {
    if (!isRecord(value)
      || typeof value.ean !== 'string' || !EAN_PATTERN.test(value.ean)
      || (expectedEan !== undefined && value.ean !== expectedEan)
      || typeof value.descripcion !== 'string' || !value.descripcion.trim()
      || value.descripcion.length > 250
      || !Number.isSafeInteger(value.precioNormalCentavos) || value.precioNormalCentavos < 0
      || !validDateTime(value.consultadoEn)
      || value.source !== 'Carrefour360' || value.tienda !== null) {
      throw failure('INVALID_RESPONSE', 'Carrefour360 devolvió datos de producto inválidos. Volvé a consultar el EAN.');
    }
    // Copy only the agreed product fields. No session data is kept by the editor.
    return {
      ean: value.ean,
      descripcion: value.descripcion.trim(),
      precioNormalCentavos: value.precioNormalCentavos,
      consultadoEn: value.consultadoEn,
      source: 'Carrefour360',
      tienda: null
    };
  }

  function validateStatus(value) {
    let url;
    try {
      if (!isRecord(value) || typeof value.pricingUrl !== 'string') throw new Error();
      url = new URL(value.pricingUrl);
    } catch (_) {
      throw failure('INVALID_RESPONSE', 'La extensión devolvió un estado de conexión inválido.');
    }
    if (value.ready !== true || !Number.isSafeInteger(value.pricingTabId) || value.pricingTabId < 0
      || url.protocol !== 'https:' || url.host !== 'carrefour360.carrefour.com.ar'
      || !['/pricing', '/pricing/'].includes(url.pathname) || url.username || url.password || url.hash) {
      throw failure('INVALID_RESPONSE', 'La extensión devolvió un estado de conexión inválido.');
    }
    return { ready: true, pricingTabId: value.pricingTabId, pricingUrl: value.pricingUrl };
  }

  function validatePresence(value) {
    if (!isRecord(value) || value.installed !== true
      || typeof value.extensionVersion !== 'string'
      || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value.extensionVersion)) {
      throw failure('INVALID_RESPONSE', 'La extensión devolvió una detección inválida.');
    }
    const parts = value.extensionVersion.split('.').map(Number);
    if (parts.some((part) => part > 65535) || !parts.some((part) => part > 0)) {
      throw failure('INVALID_RESPONSE', 'La extensión devolvió una detección inválida.');
    }
    return { installed: true, extensionVersion: value.extensionVersion };
  }

  function validImageDataUrl(value) {
    if (typeof value !== 'string' || value.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 32) return false;
    const prefix = /^data:image\/(jpeg|png|webp);base64,/.exec(value);
    if (!prefix) return false;
    const base64 = value.slice(prefix[0].length);
    if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return false;
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    if (base64.length / 4 * 3 - padding > MAX_IMAGE_BYTES) return false;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes = [];
    let bits = 0;
    let count = 0;
    for (const character of base64.slice(0, 16)) {
      if (character === '=') break;
      bits = (bits << 6) | alphabet.indexOf(character);
      count += 6;
      if (count >= 8) { count -= 8; bytes.push((bits >> count) & 255); }
    }
    if (prefix[1] === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (prefix[1] === 'png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
    return [82, 73, 70, 70].every((byte, i) => bytes[i] === byte)
      && [87, 69, 66, 80].every((byte, i) => bytes[i + 8] === byte);
  }

  function validImageLink(value, product = false) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      return product
        ? url.origin === 'https://www.carrefour.com.ar' && /^\/.+\/p$/.test(url.pathname)
        : url.origin === 'https://carrefourar.vteximg.com.br'
          && /^\/arquivos\/ids\/\d+(?:-\d+-\d+)?\/[^/]+$/.test(url.pathname);
    } catch (_) { return false; }
  }

  function validateImage(value, expectedEan) {
    if (!isRecord(value) || typeof value.ean !== 'string' || !EAN_PATTERN.test(value.ean)
      || (expectedEan !== undefined && value.ean !== expectedEan)
      || typeof value.descripcion !== 'string' || !value.descripcion.trim() || value.descripcion.length > 250
      || !validImageDataUrl(value.imageDataUrl) || !validImageLink(value.imageUrl)
      || !validImageLink(value.productUrl, true) || value.source !== 'Carrefour.com.ar') {
      throw failure('INVALID_RESPONSE', 'Carrefour devolvió una imagen inválida. Volvé a buscar el producto.');
    }
    return {
      ean: value.ean, descripcion: value.descripcion.trim(), imageDataUrl: value.imageDataUrl,
      imageUrl: value.imageUrl, productUrl: value.productUrl, source: 'Carrefour.com.ar'
    };
  }

  function createClient(options) {
    options = options || {};
    const targetWindow = options.targetWindow || root;
    const origin = targetWindow.location.origin;
    const pending = new Map();
    const clientId = ++clientSequence;
    let destroyed = false;
    let sequence = 0;
    const detectionTimeoutMs = positiveTimeout(options.detectionTimeoutMs, 1500);
    const connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, 2500);
    const lookupTimeoutMs = positiveTimeout(options.lookupTimeoutMs, 20000);
    const imageTimeoutMs = positiveTimeout(options.imageTimeoutMs, 20000);

    function nextId() {
      sequence += 1;
      try {
        return `${targetWindow.crypto.randomUUID()}-${sequence}`;
      } catch (_) {
        return `a4c360-${Date.now().toString(36)}-${clientId}-${sequence}`;
      }
    }

    function settle(id, error, result) {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      targetWindow.clearTimeout(request.timer);
      if (error) request.reject(error);
      else request.resolve(result);
    }

    function receive(event) {
      if (event.source !== targetWindow || event.origin !== origin) return;
      const message = event.data;
      if (!isRecord(message) || message.source !== RESPONSE_SOURCE || message.version !== VERSION
        || typeof message.id !== 'string' || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      try {
        if (message.ok === false) {
          if (!isRecord(message.error) || typeof message.error.code !== 'string'
            || !/^[A-Z][A-Z0-9_]{0,63}$/.test(message.error.code)
            || typeof message.error.message !== 'string' || !message.error.message.trim()
            || message.error.message.length > 500) {
            throw failure('INVALID_RESPONSE', 'La extensión devolvió un error con formato inválido.');
          }
          throw failure(message.error.code, message.error.message.trim());
        }
        if (message.ok !== true) throw failure('INVALID_RESPONSE', 'La extensión devolvió una respuesta inválida.');
        const result = request.action === 'presence' ? validatePresence(message.result)
          : request.action === 'status' ? validateStatus(message.result)
          : request.action === 'image' ? validateImage(message.result, request.ean)
          : validateProduct(message.result, request.ean);
        settle(message.id, null, result);
      } catch (error) {
        settle(message.id, error && error.code ? error
          : failure('INVALID_RESPONSE', 'No se pudo validar la respuesta de Carrefour360.'));
      }
    }

    function request(action, ean) {
      if (destroyed) return Promise.reject(failure('CLIENT_DESTROYED', 'La conexión con Carrefour360 está cerrada.'));
      if (origin === 'null' || !/^https?:\/\//.test(origin)) {
        return Promise.reject(failure('INVALID_ORIGIN', 'Abrí A4 Studio desde su dirección web para conectar Carrefour360.'));
      }
      if ((action === 'lookup' || action === 'image') && (typeof ean !== 'string' || !EAN_PATTERN.test(ean))) {
        return Promise.reject(failure('INVALID_EAN', 'Ingresá un EAN de 4 a 14 dígitos, sin espacios.'));
      }
      return new Promise((resolve, reject) => {
        const id = nextId();
        const timeout = action === 'presence' ? detectionTimeoutMs
          : action === 'image' ? imageTimeoutMs
          : action === 'status' ? connectTimeoutMs : lookupTimeoutMs;
        const timer = targetWindow.setTimeout(() => {
          settle(id, action === 'image'
            ? failure('IMAGE_TIMEOUT', 'No se pudo obtener la imagen a tiempo. Actualizá el conector de A4 Studio y volvé a buscar.')
            : action !== 'lookup'
            ? failure('EXTENSION_NOT_AVAILABLE', 'No se detectó la extensión de Carrefour360. Instalá o activá la extensión y recargá A4 Studio.')
            : failure('TIMEOUT', 'Carrefour360 tardó demasiado en responder. Volvé a consultar el producto.'));
        }, timeout);
        pending.set(id, { action, ean, resolve, reject, timer });
        const message = { source: REQUEST_SOURCE, version: VERSION, id, action };
        if (action === 'lookup' || action === 'image') message.ean = ean;
        try {
          targetWindow.postMessage(message, origin);
        } catch (_) {
          settle(id, failure('CONNECTION_ERROR', 'No se pudo enviar la consulta a la extensión de Carrefour360.'));
        }
      });
    }

    function cancelPending() {
      for (const id of pending.keys()) {
        settle(id, failure('CANCELLED', 'La consulta a Carrefour360 fue cancelada.'));
      }
    }

    targetWindow.addEventListener('message', receive);
    return {
      detect() { return request('presence'); },
      connect() { return request('status'); },
      lookup(ean) { return request('lookup', ean); },
      image(ean) { return request('image', ean); },
      cancelPending,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        targetWindow.removeEventListener('message', receive);
        cancelPending();
      }
    };
  }

  function positiveTimeout(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  root.A4Carrefour360 = { createClient, validateProduct, validateImage };
})(window);
