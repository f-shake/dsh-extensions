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
     *
     * The mirror rule puts the keyboard away: while it is up, dragging the
     * conversation scrolls the chat and dismissing the keyboard is what every
     * chat client does. Only a drag that starts inside the conversation
     * scrollport counts — one that starts in the editor (selecting text) or in
     * a popup is left alone — and only once it has travelled far enough
     * vertically to be a scroll rather than a tap.
     *
     * The third rule is about focus the user did not ask for: the shell
     * focuses the draft editor whenever it binds a session, which is handy on
     * a desktop and raises the keyboard on a tablet every time the user
     * switches sessions. On a keyboard host a programmatic focus of the editor
     * is therefore ignored unless a tap inside the composer asked for it.
     */

    /** Anything the user types into. */
    const EDITABLE = '[contenteditable="true"], textarea';
    /** Popups and dialogs own their own focus behaviour; never interfere. */
    const POPUP =
      '[role="option"], [role="menuitem"], [role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"]';
    /** The conversation scrollport: a drag inside it is a scroll of the chat. */
    const CHAT_SCROLL = '[data-conversation-scroll]';
    /** The composer root: a tap inside it is a request to type. */
    const COMPOSER = '[data-conversation-region="composer"], [data-composer-seat]';
    /** How long the shell's own re-focus is ignored after a composer tap. */
    const SUPPRESS_MS = 400;
    /** A viewport this much shorter than the baseline has the keyboard up. */
    const KEYBOARD_MIN = 80;
    /** Vertical travel that separates a scroll drag from a tap. */
    const SCROLL_TRAVEL = 24;
    /** A tap this recent is the cause of the focus() call that follows it. */
    const GESTURE_MS = 700;

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
     * Whether focusing an editor here raises an on-screen keyboard. Stricter
     * than {@link touchHost}: a touch laptop whose primary pointer is a mouse
     * keeps the desktop behaviour.
     * @returns {boolean} true when the primary pointer is coarse.
     */
    function keyboardHost() {
      return window.matchMedia !== undefined && window.matchMedia('(pointer: coarse)').matches;
    }

    /**
     * Install the guard.
     * @returns {() => void} the disposer.
     */
    function install() {
      if (window.__dshComposerFocus === true) return () => {};
      window.__dshComposerFocus = true;

      const stats = { gestures: 0, blurred: 0, suppressed: 0, dismissed: 0, unfocused: 0 };
      window.__dshComposerFocusStats = stats;

      /** Tallest viewport seen; the keyboard only ever shrinks it. */
      let baseline = window.innerHeight;
      let baselineWidth = window.innerWidth;
      let suppressUntil = 0;
      /** Where and when the last pointer gesture landed. */
      let gesture = { at: -Infinity, target: null };

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
       *
       * The Android shell resizes the WebView when the IME opens, so the layout
       * viewport shrinks. A mobile browser instead keeps the layout viewport
       * and only shrinks the visual one (Chrome's default
       * `interactive-widget=resizes-visual`), which is why both signals count.
       * @returns {boolean} true while the viewport is contracted.
       */
      function keyboardUp() {
        if (window.innerHeight < baseline - KEYBOARD_MIN) return true;
        const visual = window.visualViewport;
        if (visual === undefined || visual === null) return false;
        /* Pinch zoom shrinks the visual viewport too; that is not a keyboard. */
        if (!(visual.scale <= 1.01)) return false;
        return window.innerHeight - visual.height > KEYBOARD_MIN;
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
       * Whether a programmatic focus may raise the keyboard.
       *
       * The shell focuses the draft editor whenever it binds a session, so
       * switching sessions on a keyboard host pops the keyboard up although
       * the user only meant to read another conversation. A focus() call is
       * the user's own only when it follows a tap inside the composer.
       *
       * Only the composer's own editor is governed: the terminal, question
       * dialogs and every other editable keep their focus behaviour.
       * @param {Element} node - the element about to be focused.
       * @returns {boolean} true when the focus may proceed.
       */
      function focusMayRaiseKeyboard(node) {
        if (!keyboardHost()) return true;
        if (!isEditable(node)) return true;
        if (node.closest(COMPOSER) === null) return true;
        if (performance.now() - gesture.at > GESTURE_MS) return false;
        const target = gesture.target;
        if (!(target instanceof Element)) return false;
        return target.closest(COMPOSER) !== null;
      }

      /**
       * Swallow the shell's re-focus of the editor right after a composer tap,
       * and any focus the user did not ask for.
       * @param {...unknown} args - forwarded focus options.
       * @returns {void}
       */
      function focusGuard(...args) {
        if (performance.now() < suppressUntil && isEditable(this)) {
          stats.suppressed += 1;
          return;
        }
        if (!focusMayRaiseKeyboard(this)) {
          stats.unfocused += 1;
          return;
        }
        return originalFocus.apply(this, args);
      }

      HTMLElement.prototype.focus = focusGuard;

      const onPointerDown = (event) => {
        stats.gestures += 1;
        gesture = { at: performance.now(), target: event.target };
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

      /**
       * Whether the touch starts in a scroller nested inside the conversation,
       * whose drag therefore belongs to that scroller and not to the chat.
       * @param {Element} target - the touched node.
       * @returns {boolean} true for a nested vertical scroller.
       */
      function nestedScroller(target) {
        let node = target;
        for (let depth = 0; node !== null && depth < 8; depth += 1) {
          if (node.hasAttribute('data-conversation-scroll')) return false;
          if (node.scrollHeight > node.clientHeight + 1) {
            const overflowY = window.getComputedStyle(node).overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') return true;
          }
          node = node.parentElement;
        }
        return false;
      }

      /** The touch currently being tested as a scroll of the conversation. */
      let scrollStart = null;

      /**
       * Track a touch that could dismiss the keyboard.
       * @param {TouchEvent} event - the touchstart.
       */
      const onTouchStart = (event) => {
        scrollStart = null;
        if (!touchHost()) return;
        if (!keyboardUp()) return;
        if (event.touches.length !== 1) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(EDITABLE) !== null) return;
        if (target.closest(POPUP) !== null) return;
        if (target.closest(CHAT_SCROLL) === null) return;
        if (nestedScroller(target)) return;
        const touch = event.touches[0];
        scrollStart = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
      };

      /**
       * Put the keyboard away once the touch has become a vertical drag.
       * @param {TouchEvent} event - the touchmove.
       */
      const onTouchMove = (event) => {
        if (scrollStart === null) return;
        const touch = Array.from(event.touches).find((item) => item.identifier === scrollStart.id);
        if (touch === undefined) return;
        const dx = touch.clientX - scrollStart.x;
        const dy = touch.clientY - scrollStart.y;
        if (Math.abs(dy) < SCROLL_TRAVEL) return;
        if (Math.abs(dy) <= Math.abs(dx)) return;
        scrollStart = null;
        const active = document.activeElement;
        const editor = isEditable(active) ? active : document.querySelector(EDITABLE);
        if (!isEditable(editor)) return;
        stats.dismissed += 1;
        editor.blur();
      };

      /** Forget the tracked touch once the gesture is over. */
      const onTouchEnd = () => {
        scrollStart = null;
      };

      window.addEventListener('resize', onResize);
      window.visualViewport?.addEventListener('resize', onResize);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
      document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
      document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });

      return () => {
        window.removeEventListener('resize', onResize);
        window.visualViewport?.removeEventListener('resize', onResize);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('touchstart', onTouchStart, true);
        document.removeEventListener('touchmove', onTouchMove, true);
        document.removeEventListener('touchend', onTouchEnd, true);
        document.removeEventListener('touchcancel', onTouchEnd, true);
        HTMLElement.prototype.focus = originalFocus;
        window.__dshComposerFocus = false;
      };
    }

    return {
      apply(ctx) {
        ctx.effect(() => install(), 'composer-focus: keyboard rules for focus, taps and chat scrolls');
      },
    };
  },
});
