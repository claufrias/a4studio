(function (root) {
  'use strict';

  function create(options) {
    const window = options.targetWindow || root;
    const document = window.document;
    const modal = document.getElementById('modalFondo');
    const title = document.getElementById('promotionPickerTitle');
    const image = document.getElementById('promotionPreviewImage');
    const name = document.getElementById('promotionPreviewName');
    const detail = document.getElementById('promotionPreviewDetail');
    const price = document.getElementById('promotionPricePreview');
    const status = document.getElementById('promotionPickerStatus');
    const confirm = document.getElementById('promotionConfirm');
    const cancel = document.getElementById('promotionCancel');
    const close = document.getElementById('promotionClose');
    const scope = document.getElementById('promotionScope');
    const scopeThis = document.getElementById('promotionScopeThis');
    const scopeAll = document.getElementById('promotionScopeAll');
    const cards = Array.from(modal.querySelectorAll('[data-fondo-option]'));
    const promotions = new Map(options.promotions.map((promotion) => [promotion.type, promotion]));
    const listeners = [];
    let currentType = null;
    let candidate = null;
    let normalCents = null;
    let allowAll = false;
    let required = false;
    let opened = false;
    let busy = false;
    let destroyed = false;
    let previewReady = false;
    let previewGeneration = 0;
    let applyGeneration = 0;
    let previousFocus = null;

    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }

    function syncControls() {
      for (const card of cards) {
        card.disabled = busy;
        card.setAttribute('aria-pressed', candidate?.type === card.dataset.fondoOption ? 'true' : 'false');
        const currentBadge = card.querySelector('[data-current-badge]');
        if (currentBadge) currentBadge.hidden = card.dataset.fondoOption !== currentType;
      }
      confirm.disabled = busy || !candidate || !previewReady;
      confirm.textContent = busy ? 'Aplicando…' : 'Usar esta promoción';
      cancel.hidden = required;
      close.hidden = required;
      cancel.disabled = busy || required;
      close.disabled = busy || required;
      scope.hidden = !allowAll;
      scopeThis.disabled = busy;
      scopeAll.disabled = busy || !allowAll;
    }

    function money(cents) {
      return new Intl.NumberFormat('es-AR', {
        style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2
      }).format(cents / 100);
    }

    function choose(type) {
      if (destroyed || !opened || busy || !promotions.has(type)) return;
      candidate = promotions.get(type);
      previewReady = false;
      const generation = ++previewGeneration;
      image.hidden = true;
      image.removeAttribute('src');
      name.textContent = candidate.name;
      detail.textContent = candidate.manual
        ? 'Ingresás el descuento de cada producto.'
        : `${candidate.percent}% de descuento sobre el precio normal.`;
      price.textContent = !candidate.manual && Number.isSafeInteger(normalCents) && normalCents >= 0
        ? `Precio normal: ${money(normalCents)} · Precio final: ${money(Math.round(normalCents * (100 - candidate.percent) / 100))}`
        : candidate.manual ? 'El precio final se calcula al completar cada producto.' : '';
      price.hidden = !price.textContent;
      status.textContent = 'Cargando vista previa…';
      syncControls();
      const selected = candidate;
      const loader = new window.Image();
      loader.onload = () => {
        if (destroyed || !opened || generation !== previewGeneration) return;
        image.src = selected.preview;
        image.alt = `Fondo de ${selected.name}`;
        image.hidden = false;
        previewReady = true;
        status.textContent = '';
        syncControls();
      };
      loader.onerror = () => {
        if (destroyed || !opened || generation !== previewGeneration) return;
        previewReady = false;
        status.textContent = 'No se pudo cargar este fondo. Elegí otra promoción o volvé a intentarlo.';
        syncControls();
      };
      loader.src = selected.preview;
    }

    function requestClose() {
      if (destroyed || !opened || busy || required) return;
      options.requestClose();
    }

    async function apply() {
      if (destroyed || !opened || busy || !candidate || !previewReady) return;
      const selected = candidate;
      const all = allowAll && scopeAll.checked;
      const generation = ++applyGeneration;
      busy = true;
      status.textContent = all ? 'Aplicando a todos los carteles…' : 'Aplicando a este cartel…';
      syncControls();
      let applied = false;
      try {
        applied = await options.apply(selected.type, all);
        if (destroyed || !opened || generation !== applyGeneration) return;
        if (!applied) status.textContent = 'No se pudo aplicar la promoción. Revisá el cartel y volvé a intentar.';
      } catch (error) {
        if (destroyed || !opened || generation !== applyGeneration) return;
        status.textContent = typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim().slice(0, 300)
          : 'No se pudo aplicar la promoción. Volvé a intentar.';
      } finally {
        if (!destroyed && generation === applyGeneration) {
          busy = false;
          syncControls();
        }
      }
      if (applied && !destroyed && opened && generation === applyGeneration) {
        currentType = selected.type;
        required = false;
        status.textContent = '';
        syncControls();
        options.requestClose();
      }
    }

    function focusable() {
      return Array.from(modal.querySelectorAll('button, input, select, a[href], summary, [tabindex]')).filter((element) => {
        if (element.disabled || element.hidden || element.tabIndex < 0) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && (!element.getClientRects || element.getClientRects().length > 0);
      });
    }

    function onKeydown(event) {
      if (!opened || destroyed) return;
      // Native controls keep their behavior, while canvas shortcuts stay behind the dialog.
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && ['z', 'y', 's'].includes(event.key.toLowerCase())) event.preventDefault();
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
      }
      if (event.key === 'Tab') {
        const elements = focusable();
        if (!elements.length) { event.preventDefault(); title.focus(); return; }
        const first = elements[0];
        const last = elements[elements.length - 1];
        const active = document.activeElement;
        if (!elements.includes(active) || event.shiftKey && active === first || !event.shiftKey && active === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    }

    for (const card of cards) listen(card, 'click', () => choose(card.dataset.fondoOption));
    listen(confirm, 'click', apply);
    listen(cancel, 'click', requestClose);
    listen(close, 'click', requestClose);
    listen(modal, 'keydown', onKeydown);

    return {
      get busy() { return busy; },
      open(state = {}) {
        if (destroyed || busy) return false;
        previewGeneration += 1;
        applyGeneration += 1;
        previousFocus = state.trigger || document.activeElement;
        currentType = promotions.has(state.currentType) ? state.currentType : null;
        normalCents = state.normalCents;
        allowAll = !!state.allowAll;
        required = !!state.required;
        opened = true;
        candidate = null;
        previewReady = false;
        scopeThis.checked = true;
        scopeAll.checked = false;
        image.hidden = true;
        image.removeAttribute('src');
        name.textContent = 'Elegí una promoción';
        detail.textContent = 'Seleccioná una tarjeta para ver el fondo y el descuento.';
        price.textContent = '';
        price.hidden = true;
        status.textContent = '';
        syncControls();
        if (currentType) choose(currentType);
        title.focus();
        return true;
      },
      closed() {
        opened = false;
        busy = false;
        previewGeneration += 1;
        applyGeneration += 1;
        const focus = previousFocus;
        previousFocus = null;
        if (focus && focus.isConnected !== false) focus.focus();
      },
      destroy() {
        destroyed = true;
        opened = false;
        busy = false;
        previewGeneration += 1;
        applyGeneration += 1;
        listeners.forEach((remove) => remove());
      }
    };
  }

  root.A4PromotionPicker = { create };
})(window);
