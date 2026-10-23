// Browser QA only. This file is never loaded by the production editor.
(function () {
  if (window.parent === window || !window.parent.location.pathname.endsWith('/tests/fixtures/carrefour-editor.html')) return;
  const products = {
    '7790895000997': { descripcion: 'GASEOSA COLA REGULAR COCA COLA PET X 2.25 LT', precioNormalCentavos: 600000 },
    '7798108349161': { descripcion: 'PRODUCTO DE PRUEBA CON CENTAVOS', precioNormalCentavos: 299050 }
  };
  window.addEventListener('message', (event) => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin || request?.source !== 'a4studio-carrefour360') return;
    let response;
    if (request.action === 'status') response = { ok: true, result: { ready: true, pricingTabId: 123, pricingUrl: 'https://carrefour360.carrefour.com.ar/pricing' } };
    else if (request.action === 'lookup' && products[request.ean]) {
      response = { ok: true, result: { ...products[request.ean], ean: request.ean, source: 'Carrefour360', tienda: null, consultadoEn: new Date().toISOString() } };
    } else response = { ok: false, error: { code: 'PRODUCT_NOT_FOUND', message: 'Producto inexistente en la prueba local.' } };
    setTimeout(() => window.postMessage({ source: 'carrefour360-a4studio', version: 1, id: request.id, ...response }, location.origin), 120);
  });
})();
