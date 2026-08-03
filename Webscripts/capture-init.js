/*
 * Playwright document-start bootstrap for faithful map capture.
 *
 * Install before navigating to bonk.io so it runs in the game frame:
 *   await context.addInitScript({ path: 'Webscripts/capture-init.js' });
 *
 * It installs the same narrow state/game-settings hook used by mapexporter.js.
 * If the standard codeinjector userscript installs afterwards, that script
 * replaces this append hook and consumes the already-registered injector.
 */
(function () {
  'use strict';

  const MARKER = '__bonkCaptureInitV1';
  const INJECTED_MARKER = '__bonkCaptureInitV1Hook';
  if (window[MARKER]) return;
  window[MARKER] = true;

  if (!Array.isArray(window.bonkCodeInjectors)) window.bonkCodeInjectors = [];
  window.bonkCodeInjectors.push(function captureStateInjector(alpha2sCode) {
    if (typeof alpha2sCode !== 'string' || alpha2sCode.includes(INJECTED_MARKER)) return alpha2sCode;
    const match = alpha2sCode.match(/[A-Za-z]\[[A-Za-z0-9$_]{3}(\[[0-9]{1,3}\]){2}\]={discs/);
    if (!match) {
      console.warn('[BonkCapture] State creation anchor not found; source was left unchanged');
      return alpha2sCode;
    }
    const capture = '{try{window.' + INJECTED_MARKER + '=1;if(arguments[0]&&arguments[0].physics&&arguments[0].physics.bodies){window.__bonkExportState=arguments[0];}if(arguments[4]){window.__bonkExportGameSettings=arguments[4];}}catch(e){}}';
    return alpha2sCode.replace(match[0], capture + match[0]);
  });

  function isAlphaScript(node) {
    return node && node.tagName === 'SCRIPT' && typeof node.src === 'string' && node.src.includes('alpha2s.js');
  }

  function installAppendHook() {
    const head = document.head;
    if (!head || head.__bonkCaptureInitAppendHook) return;
    head.__bonkCaptureInitAppendHook = true;
    const originalAppendChild = head.appendChild.bind(head);

    head.appendChild = function captureAppendChild() {
      const args = Array.prototype.slice.call(arguments);
      const script = args[0];
      if (!isAlphaScript(script) || script.__bonkCaptureInitIntercepted) {
        return originalAppendChild.apply(head, args);
      }

      script.__bonkCaptureInitIntercepted = true;
      const sourceUrl = script.src;
      script.removeAttribute('src');

      (async function () {
        try {
          const response = await fetch(sourceUrl, { credentials: 'same-origin' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          let code = await response.text();
          for (const injector of window.bonkCodeInjectors) {
            if (typeof injector === 'function') code = injector(code);
          }
          script.textContent = code;
          script.dispatchEvent(new Event('load'));
          originalAppendChild.apply(head, args);
          console.log('[BonkCapture] alpha2s state hook installed');
        } catch (error) {
          console.warn('[BonkCapture] injection failed; loading unmodified alpha2s.js', error);
          script.src = sourceUrl;
          originalAppendChild.apply(head, args);
        }
      })();

      // RequireJS expects an append operation, but the reference injector also
      // completes it asynchronously after fetch-and-patch succeeds.
      return script;
    };
  }

  if (document.head) {
    installAppendHook();
  } else {
    const observer = new MutationObserver(function () {
      if (!document.head) return;
      observer.disconnect();
      installAppendHook();
    });
    observer.observe(document, { childList: true, subtree: true });
  }
})();
