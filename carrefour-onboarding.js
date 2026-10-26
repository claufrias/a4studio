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
      message.textContent = 'Comprobando si el conector está disponible…';
      if (manual) { wanted = true; flush(); }
      try {
        await client.detect();
        if (destroyed) return;
        hint.textContent = 'Extensión detectada. Abrí Pricing con tu sesión y pulsá Conectar.';
        panelButton.textContent = 'Comprobar extensión';
        hide();
      } catch (error) {
        if (destroyed || error?.code === 'CANCELLED') return;
        message.textContent = 'No recibimos respuesta del conector. Si ya lo instalaste, comprobá que esté actualizado y habilitado para esta página. Recargá A4 Studio y volvé a intentar.';
        hint.textContent = 'Podés instalar o comprobar el conector cuando quieras.';
        // Closing the dialog while a retry is pending must not reopen it.
        if (manual ? wanted : !dismissed) { wanted = true; flush(); }
      } finally {
        checking = false;
        retry.disabled = false;
        retry.textContent = 'Ya la instalé · Reintentar';
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
    listen(dialog, 'cancel', (event) => { event.preventDefault(); dismiss(); });
    // Keep the editor's global keyboard shortcuts out of this dialog.
    listen(dialog, 'keydown', (event) => event.stopPropagation());
    listen(document.getElementById('carrefourInstallLink'), 'click', () => {
      awaitingInstallation = true;
      message.textContent = 'Completá la instalación en Chrome Web Store y volvé a esta página. Si todavía no se detecta, recargá A4 Studio después de guardar tu trabajo.';
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
