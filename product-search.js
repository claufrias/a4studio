(function (root) {
  'use strict';

  function normalizeName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function createCatalog(products) {
    const byEan = new Map();
    const entries = [];
    products.forEach((product) => {
      const ean = String(product.ean);
      if (byEan.has(ean)) return;
      const entry = { ean, descripcion: String(product.descripcion) };
      byEan.set(ean, entry);
      entries.push({ product: entry, name: normalizeName(entry.descripcion) });
    });
    return {
      findByEan(value) {
        return byEan.get(String(value || '').replace(/\D/g, '')) || null;
      },
      search(value, limit = 8) {
        const query = normalizeName(value);
        if (query.length < 2) return [];
        const words = query.split(' ');
        const matches = entries.filter((entry) => words.every((word) => entry.name.includes(word)));
        matches.sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)));
        return matches.slice(0, limit).map((entry) => entry.product);
      }
    };
  }

  const catalog = createCatalog(root.A4_PRODUCT_CATALOG || []);
  const closers = new Set();
  let nextId = 0;

  function closeAll() {
    closers.forEach((close) => close());
  }

  function bindNameInput(input, onSelect) {
    const doc = input.ownerDocument;
    const popup = doc.createElement('div');
    popup.className = 'product-suggestions';
    popup.hidden = true;
    const status = doc.createElement('div');
    status.className = 'product-suggestions-status';
    status.setAttribute('role', 'status');
    const list = doc.createElement('div');
    list.id = `product-suggestions-${++nextId}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Productos del catálogo');
    popup.append(status, list);
    doc.body.appendChild(popup);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');
    let matches = [];
    let activeIndex = -1;

    function close() {
      popup.hidden = true;
      activeIndex = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function choose(index) {
      const product = matches[index];
      if (!product) return;
      input.value = product.descripcion;
      close();
      onSelect(product);
      input.setSelectionRange(input.value.length, input.value.length);
    }

    function refresh() {
      if (doc.activeElement !== input || doc.body.classList.contains('modal-open')) return;
      closeAll();
      if (normalizeName(input.value).length < 2) return;
      matches = catalog.search(input.value);
      list.replaceChildren();
      status.textContent = matches.length
        ? `${matches.length} sugerencias · Usá ↑ ↓ y Enter para elegir`
        : 'Sin coincidencias. Podés escribir un nombre libre.';
      matches.forEach((product, index) => {
        const option = doc.createElement('div');
        option.id = `${list.id}-${index}`;
        option.className = 'product-suggestion';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        const name = doc.createElement('span');
        name.textContent = product.descripcion;
        const ean = doc.createElement('small');
        ean.textContent = product.ean;
        option.append(name, ean);
        option.addEventListener('click', () => choose(index));
        list.appendChild(option);
      });
      const rect = input.getBoundingClientRect();
      const viewport = root.visualViewport;
      const viewportTop = viewport ? viewport.offsetTop : 0;
      const viewportBottom = viewportTop + (viewport ? viewport.height : root.innerHeight);
      const below = viewportBottom - rect.bottom - 8;
      const above = rect.top - viewportTop - 8;
      const showAbove = below < 180 && above > below;
      const height = Math.max(0, Math.min(280, showAbove ? above : below));
      if (height < 55) return;
      const width = Math.min(Math.max(rect.width, 250), root.innerWidth - 16);
      popup.style.width = `${width}px`;
      popup.style.left = `${Math.max(8, Math.min(rect.left, root.innerWidth - width - 8))}px`;
      popup.style.maxHeight = `${height}px`;
      popup.hidden = false;
      popup.style.top = `${showAbove ? rect.top - popup.offsetHeight - 4 : rect.bottom + 4}px`;
      input.setAttribute('aria-expanded', 'true');
    }

    function onKeyDown(event) {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (popup.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        activeIndex = activeIndex < 0
          ? (event.key === 'ArrowDown' ? 0 : matches.length - 1)
          : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        Array.from(list.children).forEach((option, index) => {
          option.setAttribute('aria-selected', String(index === activeIndex));
        });
        const active = list.children[activeIndex];
        input.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && activeIndex >= 0 && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(activeIndex);
      } else if (event.key === 'Tab') {
        close();
      }
    }

    function onInput(event) {
      if (!event.isComposing) refresh();
    }

    // Keep textarea focus, including the canvas editor, while choosing a result.
    popup.addEventListener('pointerdown', (event) => event.preventDefault());
    input.addEventListener('input', onInput);
    input.addEventListener('compositionend', refresh);
    input.addEventListener('keydown', onKeyDown, true);
    input.addEventListener('blur', close);
    closers.add(close);
    return {
      close,
      destroy() {
        close();
        closers.delete(close);
        input.removeEventListener('input', onInput);
        input.removeEventListener('compositionend', refresh);
        input.removeEventListener('keydown', onKeyDown, true);
        input.removeEventListener('blur', close);
        popup.remove();
      }
    };
  }

  if (root.document) {
    root.addEventListener('resize', closeAll);
    root.document.addEventListener('scroll', (event) => {
      if (!event.target.closest || !event.target.closest('.product-suggestions')) closeAll();
    }, true);
    root.document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.product-suggestions') && event.target.getAttribute('aria-autocomplete') !== 'list') closeAll();
    });
    if (root.visualViewport) root.visualViewport.addEventListener('resize', closeAll);
  }

  root.A4ProductSearch = { catalog, createCatalog, bindNameInput, closeAll };
})(globalThis);
