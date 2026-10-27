(function (root) {
  'use strict';

  function start(options) {
    const window = options.targetWindow || root;
    const document = window.document;
    const client = options.client || window.A4Carrefour360.createClient();
    const search = document.getElementById('carrefourImageSearch');
    const preview = document.getElementById('carrefourImagePreview');
    const image = document.getElementById('carrefourImagePhoto');
    const caption = document.getElementById('carrefourImageCaption');
    const source = document.getElementById('carrefourImageSource');
    const use = document.getElementById('carrefourImageUse');
    const status = document.getElementById('carrefourImageStatus');
    let generation = 0;
    let candidate = null;
    let applying = false;
    let destroyed = false;

    function clearPreview() {
      candidate = null;
      preview.hidden = true;
      image.removeAttribute('src');
      use.disabled = true;
    }

    function targetAvailable(target) {
      return !target.consumo && /^\d{4,14}$/.test(target.ean) && options.canApply();
    }

    async function find() {
      if (destroyed || applying) return;
      const request = ++generation;
      client.cancelPending();
      clearPreview();
      search.disabled = false;
      const target = options.getTarget();
      if (!targetAvailable(target)) {
        status.textContent = 'Ingresá el código de barras de un cartel normal y terminá de editar para buscar su foto.';
        return;
      }
      search.disabled = true;
      status.textContent = 'Buscando la foto de este producto en Carrefour…';
      try {
        const result = await client.image(target.ean);
        if (destroyed || request !== generation) return;
        if (!options.isCurrentTarget(target) || !options.canApply()) {
          status.textContent = 'El cartel cambió durante la búsqueda. Volvé a buscar la foto del producto actual.';
          return;
        }
        candidate = { result, target };
        image.src = result.imageDataUrl;
        image.alt = result.descripcion;
        caption.textContent = `${result.descripcion} · Código ${result.ean}`;
        source.href = result.productUrl;
        preview.hidden = false;
        use.disabled = false;
        status.textContent = 'Revisá que sea el producto correcto. Tu cartel conserva su imagen hasta que elijas usar esta foto.';
      } catch (error) {
        if (destroyed || request !== generation || error?.code === 'CANCELLED') return;
        status.textContent = error?.message || 'No pudimos buscar la foto. Podés agregar una imagen desde tu computadora.';
      } finally {
        if (!destroyed && request === generation) search.disabled = false;
      }
    }

    async function apply() {
      if (destroyed || applying || !candidate) return;
      const selected = candidate;
      if (!options.isCurrentTarget(selected.target) || !options.canApply()) {
        clearPreview();
        status.textContent = 'El cartel o su imagen cambiaron. Volvé a buscar antes de reemplazar la foto.';
        return;
      }
      applying = true;
      search.disabled = true;
      use.disabled = true;
      status.textContent = 'Agregando la foto al cartel…';
      try {
        const applied = await options.applyImage(selected.result.imageDataUrl, selected.target);
        if (destroyed) return;
        clearPreview();
        status.textContent = applied
          ? 'Foto agregada. Podés moverla, recortarla o deshacer el cambio.'
          : 'No se aplicó la foto. Revisá el cartel y volvé a buscar.';
      } catch (_) {
        if (!destroyed) status.textContent = 'No se pudo agregar la foto. Tu imagen anterior se conserva.';
      } finally {
        applying = false;
        if (!destroyed) {
          search.disabled = false;
          use.disabled = !candidate;
        }
      }
    }

    function failedPreview() {
      clearPreview();
      status.textContent = 'No se pudo mostrar la foto. Podés volver a buscar o agregar una imagen desde tu computadora.';
    }

    search.addEventListener('click', find);
    use.addEventListener('click', apply);
    image.addEventListener('error', failedPreview);
    return {
      find, apply,
      destroy() {
        destroyed = true;
        generation += 1;
        client.destroy();
        search.removeEventListener('click', find);
        use.removeEventListener('click', apply);
        image.removeEventListener('error', failedPreview);
        clearPreview();
      }
    };
  }

  root.A4CarrefourImagesUi = { start };
})(window);
