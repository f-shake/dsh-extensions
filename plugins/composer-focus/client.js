window.__ModuleLoader__.load({
  id: '@local/composer-focus',
  factory() {
    /*
     * Keep a touch on a composer control from summoning the keyboard.
     *
     * The shell keeps the draft editor focused while the user taps the
     * composer's buttons (`+`, permission, model, send), so a half-written
     * message survives the tap. On a touch host that focus is what the
     * keyboard follows: with the keyboard dismissed but the editor still
     * focused, the next tap anywhere re-opens it, even when the tap only
     * meant to open a menu.
     *
     * The rule is narrow: when the keyboard is down and a touch lands on a
     * composer control (not the editor itself, not an open popup), drop the
     * focus first and ignore the focus the shell immediately takes back. The
     * draft lives in shell state, so nothing is lost; the keyboard simply
     * stays closed until the user taps the editor again.
     */

    /** Anything the user types into. */
    const EDITABLE = '[contenteditable="true"], textarea';
    /** Popups and dialogs own their own focus behaviour; never interfere. */
    const POPUP =
      '[role="option"], [role="menuitem"], [role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"]';
    /** How long the shell's own re-focus is ignored after a composer tap. */
    const SUPPRESS_MS = 400;
    /** A viewport this much shorter than the baseline has the keyboard up. */
    const KEYBOARD_MIN = 80;

    /**
     * Whether a node is something the user types into.
     * @param {{ isContentEditable?: boolean, tagName?: string }|null} node - candidate.
     * @returns {boolean} true for a focus-capable editor.
     */
    function isEditable(node) {
      if (node === null || node === undefined) return false;
      if (node.isContentEditable === true) return true;
      return node.tagName === 'TEXTAREA';
    }

    /**
     * Whether this host is driven by touch. Evaluated per gesture: the media
     * query is unreliable in the first frames of an embedded WebView.
     * @returns {boolean} true for a coarse-pointer host.
     */
    function touchHost() {
      if (navigator.maxTouchPoints > 0) return true;
      return window.matchMedia !== undefined && window.matchMedia('(pointer: coarse)').matches;
    }

    /**
     * Install the guard.
     * @returns {() => void} the disposer.
     */
    function install() {
      if (window.__dshComposerFocus === true) return () => {};
      window.__dshComposerFocus = true;

      const stats = { gestures: 0, blurred: 0, suppressed: 0 };
      window.__dshComposerFocusStats = stats;

      /** Tallest viewport seen; the keyboard only ever shrinks it. */
      let baseline = window.innerHeight;
      let baselineWidth = window.innerWidth;
      let suppressUntil = 0;

      const onResize = () => {
        /* Rotation changes what "tall" means, so re-seed instead of comparing. */
        if (window.innerWidth !== baselineWidth) {
          baselineWidth = window.innerWidth;
          baseline = window.innerHeight;
          return;
        }
        if (window.innerHeight > baseline) baseline = window.innerHeight;
      };

      /**
       * Whether the keyboard is currently up.
       * @returns {boolean} true while the viewport is contracted.
       */
      function keyboardUp() {
        return window.innerHeight < baseline - KEYBOARD_MIN;
      }

      /**
       * Nearest ancestor of the tapped node that also holds the focused
       * editor — the composer root. A popup rendered into a portal has no such
       * ancestor, which is what keeps menu taps out of this rule.
       * @param {Element} target - the tapped node.
       * @param {Element} editor - the focused editor.
       * @returns {Element|null} the composer root, or null outside it.
       */
      function composerRoot(target, editor) {
        let node = target;
        while (node !== null && node !== document.body) {
          if (node.contains(editor)) return node;
          node = node.parentElement;
        }
        return null;
      }

      const originalFocus = HTMLElement.prototype.focus;

      /**
       * Swallow the shell's re-focus of the editor right after a composer tap.
       * @param {...unknown} args - forwarded focus options.
       * @returns {void}
       */
      function focusGuard(...args) {
        if (performance.now() < suppressUntil && isEditable(this)) {
          stats.suppressed += 1;
          return;
        }
        return originalFocus.apply(this, args);
      }

      HTMLElement.prototype.focus = focusGuard;

      const onPointerDown = (event) => {
        stats.gestures += 1;
        if (!touchHost()) return;
        if (keyboardUp()) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(EDITABLE) !== null) return;
        if (target.closest(POPUP) !== null) return;
        const active = document.activeElement;
        const editor = isEditable(active) ? active : document.querySelector(EDITABLE);
        if (!isEditable(editor)) return;
        if (composerRoot(target, editor) === null) return;
        suppressUntil = performance.now() + SUPPRESS_MS;
        stats.blurred += 1;
        editor.blur();
      };

      window.addEventListener('resize', onResize);
      window.visualViewport?.addEventListener('resize', onResize);
      document.addEventListener('pointerdown', onPointerDown, true);

      return () => {
        window.removeEventListener('resize', onResize);
        window.visualViewport?.removeEventListener('resize', onResize);
        document.removeEventListener('pointerdown', onPointerDown, true);
        HTMLElement.prototype.focus = originalFocus;
        window.__dshComposerFocus = false;
      };
    }

    return {
      apply(ctx) {
        ctx.effect(() => install(), 'composer-focus: keep composer taps from raising the keyboard');
      },
    };
  },
});
