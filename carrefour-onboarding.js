(function (root) {
  'use strict';

  const DISMISSED_KEY = 'a4studio.carrefour.install.dismissed';

  function start(options = {}) {
    const window = options.targetWindow || root;
    const document = window.document;
    const dialog = document.getElementById('carrefourInstallModal');
    const retry = document.getElementById('carrefourInstallRetry');
    const message = document.getElementById('carrefourInstallMessage');
    const panelButton = document.getElementById('carrefourInstallOpen');
    const hint = document.getElementById('carrefourInstallHint');
    const title = document.getElementById('carrefourInstallTitle');
    const description = document.getElementById('carrefourInstallDescription');
    const installSteps = document.getElementById('carrefourInstallSteps');
    const ready = document.getElementById('carrefourInstallReady');
    // Presence checks must not be cancelled by the editor's product requests.
    const client = options.client || window.A4Carrefour360.createClient();
    let dismissed = false;
    try { dismissed = window.sessionStorage.getItem(DISMISSED_KEY) === 'true'; } catch (_) {}
    let wanted = false;
    let checking = false;
    let awaitingInstallation = false;
    let printing = false;
    let destroyed = false;

    function rememberDismissal() {
      dismissed = true;
      try { window.sessionStorage.setItem(DISMISSED_KEY, 'true'); } catch (_) {}
    }

    function hide() {
      wanted = false;
      awaitingInstallation = false;
      if (dialog.open) dialog.close();
    }

    function dismiss() {
      hide();
      rememberDismissal();
    }

    function showStep(installed) {
      title.textContent = installed ? '¡La herramienta está instalada!'
        : 'Completá el nombre y el precio sin copiarlos a mano';
      description.textContent = installed
        ? 'Ahora abrí Carrefour360, iniciá sesión y entrá a Pricing. Dejá esa pestaña abierta.'
        : 'A4 Studio puede buscar los datos del producto en Carrefour360 usando su código de barras.';
      installSteps.hidden = installed;
      ready.hidden = !installed;
      if (dialog.open) title.focus?.();
    }

    function flush() {
      if (destroyed || !wanted || printing || document.visibilityState === 'hidden') return;
      const anotherModal = Array.from(document.querySelectorAll('.modal, dialog[open]')).some((modal) => {
        return modal !== dialog && window.getComputedStyle(modal).display !== 'none';
      });
      if (anotherModal) {
        // A native dialog must not keep the editor inert behind a custom modal.
        if (dialog.open) dialog.close();
      } else if (!dialog.open) dialog.showModal();
    }

    async function check(manual = false) {
      if (destroyed || checking) return;
      checking = true;
      awaitingInstallation = false;
      retry.disabled = true;
      retry.textContent = 'Comprobando…';
      message.textContent = manual ? 'Comprobando si ya está instalada…' : '';
      if (manual) { showStep(false); wanted = true; flush(); }
      try {
        await client.detect();
        if (destroyed) return;
        hint.textContent = 'La herramienta está instalada. Abrí Carrefour360 y seguí los pasos para conectar.';
        panelButton.textContent = 'Ver cómo conectar Carrefour360';
        // A late response must not reopen a guide the user already closed.
        if (manual ? wanted : !dismissed) {
          showStep(true);
          message.textContent = '';
          wanted = true;
          flush();
        }
      } catch (error) {
        if (destroyed || error?.code === 'CANCELLED') return;
        message.textContent = manual
          ? 'Todavía no encontramos la herramienta. Si acabás de instalarla, guardá tus carteles, recargá esta página y tocá «Ya la instalé».'
          : '';
        hint.textContent = 'Podés seguir creando carteles sin instalar la herramienta.';
        // Closing the dialog while a retry is pending must not reopen it.
        if (manual ? wanted : !dismissed) { wanted = true; flush(); }
      } finally {
        checking = false;
        retry.disabled = false;
        retry.textContent = 'Ya la instalé';
      }
    }

    function returnedToEditor() {
      if (awaitingInstallation && document.visibilityState !== 'hidden') check(true);
      flush();
    }

    const listeners = [];
    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }
    listen(panelButton, 'click', () => check(true));
    listen(retry, 'click', () => check(true));
    listen(document.getElementById('carrefourInstallLater'), 'click', dismiss);
    listen(document.getElementById('carrefourInstallClose'), 'click', dismiss);
    function returnToEditor() {
      dismiss();
      document.getElementById('carrefourConnect')?.focus();
    }
    listen(document.getElementById('carrefourInstallDone'), 'click', returnToEditor);
    listen(document.getElementById('carrefourInstallPricing'), 'click', returnToEditor);
    listen(dialog, 'cancel', (event) => { event.preventDefault(); dismiss(); });
    // Keep the editor's global keyboard shortcuts out of this dialog.
    listen(dialog, 'keydown', (event) => event.stopPropagation());
    listen(document.getElementById('carrefourInstallLink'), 'click', () => {
      awaitingInstallation = true;
      message.textContent = 'Cuando termines de agregarla a Chrome, volvé acá y tocá «Ya la instalé».';
    });
    listen(window, 'focus', returnedToEditor);
    listen(document, 'visibilitychange', returnedToEditor);
    listen(window, 'beforeprint', () => { printing = true; if (dialog.open) dialog.close(); });
    listen(window, 'afterprint', () => { printing = false; flush(); });

    const observer = new window.MutationObserver(flush);
    document.querySelectorAll('.modal, dialog').forEach((modal) => {
      observer.observe(modal, { attributes: true, attributeFilter: ['style', 'class', 'open'] });
    });
    if (!dismissed) check();

    return {
      check() { return check(true); },
      destroy() {
        destroyed = true;
        wanted = false;
        observer.disconnect();
        listeners.forEach((remove) => remove());
        client.destroy();
        if (dialog.open) dialog.close();
      }
    };
  }

  root.A4CarrefourOnboarding = { start };
})(window);
