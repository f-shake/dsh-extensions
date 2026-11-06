window.__ModuleLoader__.load({
  id: '@local/mobile-fit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'mobile-fit';
    /** The frame width below which the shipped layout uses its narrow column. */
    const MOBILE_QUERY = '(max-width: 1023.98px)';
    /**
     * 外壳框架用本插件打的标记来认，不再靠内联样式匹配：dockkit 的面板容器同样
     * 带内联 grid-template-columns，按样式匹配会把右栏也当成左抽屉拽到左边。
     */
    const FRAME_ATTRIBUTE = 'data-msd-shell-frame';
    const FRAME_SELECTOR = '[' + FRAME_ATTRIBUTE + ']';
    /** 框架把这块遮罩层作为直接子节点渲染，用它定位框架本身。 */
    const OVERLAY_SELECTOR = '[data-shell-overlay]';
    /** 右栏打开/收起由面板自带的按钮驱动。 */
    const RIGHT_OPEN_SELECTOR = '[data-sidebar-right-expand]';
    const RIGHT_CLOSE_SELECTOR = '[data-sidebar-right-toggle]';
    /** 宿主在面板元素上公开的开合状态，比按钮在不在更可靠。 */
    const RIGHT_PANEL_OPEN_SELECTOR = '[data-sidebar-right-panel][data-sidebar-right-open]';
    /** 面板想展开、外壳却因宽度门槛不给轨道时，用它把抽屉顶出来。 */
    const RIGHT_WANT_ATTRIBUTE = 'data-msd-right-want';
    /** Style element marker so one copy exists per page. */
    const STYLE_TAG = 'mobile-fit';

    const en = {
      open: 'Open sidebar',
      close: 'Close sidebar',
    };
    const zh = {
      open: '打开侧边栏',
      close: '关闭侧边栏',
    };

    /*
     * Narrow-viewport shell adaptation.
     *
     * The shipped frame keeps a 56px rail when the left column is closed on
     * every platform except desktop macOS/Windows chrome, so the rail cannot be
     * removed through a slot. Below the layout's own 1024px breakpoint this
     * sheet drops the first grid track to zero and turns that column into an
     * off-canvas drawer; the other two tracks keep their children in place
     * because the drawer leaves the flow.
     */
    const css = `
@media (max-width: 1023.98px) {
  /* The frame follows the visual viewport while an on-screen keyboard is up. */
  html {
    height: var(--x-msd-app-height, 100%) !important;
  }
  [data-msd-shell-frame] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  [data-msd-shell-frame] > *:first-child {
    position: absolute !important;
    top: 0 !important;
    bottom: 0 !important;
    left: 0 !important;
    width: 280px !important;
    max-width: 100vw;
    z-index: 40 !important;
    transform: translateX(-100%);
    transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  [data-msd-shell-frame]:not([data-sidebar-collapsed]) > *:first-child {
    transform: translateX(0);
    box-shadow: 0 18px 48px rgb(0 0 0 / 0.28);
  }
  /*
   * 右栏在这个宽度以下一律收成抽屉。不能再按宿主的 768 分界拆成两段：外壳的
   * grid-template-columns 只能整体覆盖，第三列一旦不是 0，宿主算好的停靠轨道就被
   * 丢掉，而面板是绝对定位的、不会撑开 auto 轨道，结果面板压在会话上、又因为没
   * 有 z-index 落到遮罩层之下，点都点不动。
   */
  [data-msd-shell-frame] > *:nth-child(3) {
    position: absolute !important;
    top: 0 !important;
    bottom: 0 !important;
    right: 0 !important;
    width: min(92vw, 380px) !important;
    max-width: 100vw;
    z-index: 41 !important;
    overflow: hidden !important;
    transform: translateX(100%);
    transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  /*
   * 右栏面板自己按整屏宽度定位、锚在列尾，放进抽屉会向左溢出，在视口右边留一条。
   * 收成与抽屉同宽即可。
   */
  [data-msd-shell-frame] > *:nth-child(3) [data-sidebar-right-panel] {
    width: 100% !important;
    max-width: 100% !important;
    left: 0 !important;
    right: auto !important;
  }
  [data-msd-shell-frame]:not([data-rightbar-collapsed]) > *:nth-child(3) {
    transform: translateX(0);
    box-shadow: -18px 0 48px rgb(0 0 0 / 0.28);
  }
  /*
   * 外壳有宽度门槛（中栏至少 400px + 右栏 300px），窄屏上永远不满足，面板即使
   * 要求展开也没有轨道。这里按面板自己的开合状态放行。
   */
  [data-msd-shell-frame][data-msd-right-want] > *:nth-child(3) {
    transform: translateX(0);
    box-shadow: -18px 0 48px rgb(0 0 0 / 0.28);
  }
  [data-msd-shell-frame] > *:nth-child(2) {
    grid-column: 1 / 3 !important;
    grid-row: 1 !important;
  }
  [data-msd-shell-frame] > *:nth-child(4) {
    grid-column: 1 / -1 !important;
    grid-row: 2 !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-msd-shell-frame] > *:first-child,
  [data-msd-shell-frame] > *:nth-child(3) {
    transition: none !important;
  }
}
/*
 * Settings sheet on phone widths. The shipped dialog is a fixed two-column
 * panel (188px section list beside the content), which leaves a phone-width
 * content column of about 150px. Below 768px the same panel becomes a sheet:
 * sections wrap across the top, the content takes the full width.
 */
@media (max-width: 767.98px) {
  [data-shortcut-modal="settings"] {
    flex-direction: column !important;
    width: calc(100vw - 12px) !important;
    max-width: none !important;
    min-width: 0 !important;
    height: auto !important;
    max-height: calc(var(--x-msd-app-height, 100dvh) - 12px) !important;
  }
  [data-shortcut-modal="settings"] > nav {
    box-sizing: border-box;
    flex: none !important;
    min-width: 0 !important;
    flex-direction: row !important;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 10px !important;
    width: 100% !important;
    padding: 10px 46px 10px 14px !important;
  }
  [data-shortcut-modal="settings"] > nav > div:first-child {
    flex: none;
    padding: 0 !important;
    font-size: 15px !important;
    line-height: 20px !important;
  }
  [data-shortcut-modal="settings"] > nav > div:last-child {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    flex-direction: row !important;
    flex-wrap: wrap !important;
    gap: 6px !important;
    overflow: visible !important;
  }
  [data-shortcut-modal="settings"] > nav button {
    flex: none !important;
    width: auto !important;
    height: 32px !important;
    padding: 5px 10px !important;
    font-size: 13px !important;
    white-space: nowrap;
  }
  [data-shortcut-modal="settings"] > div:last-child {
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }
  [data-shortcut-modal="settings"] > div:last-child > div:first-child {
    position: absolute !important;
    top: 8px !important;
    right: 8px !important;
    z-index: 2;
    height: auto !important;
    padding: 0 !important;
  }
  [data-shortcut-modal="settings"] [class*="_options"] {
    padding: 2px 14px 16px !important;
  }
  [data-shortcut-modal="settings"] [class*="_row"] {
    flex-wrap: wrap;
    gap: 8px 12px !important;
  }
  [data-shortcut-modal="settings"] [class*="_row"] > * {
    min-width: 0;
  }
}
.x-msd-seat {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  margin: 0 2px 0 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #14181f);
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}
.x-msd-seat:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #14181f) 8%, transparent);
}
.x-msd-seat:active {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #14181f) 14%, transparent);
}
.x-msd-seat:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4176f5);
  outline-offset: 1px;
}
.x-msd-scrim {
  position: fixed;
  inset: 0;
  z-index: 25;
  background: rgb(0 0 0 / 0.38);
  pointer-events: auto;
  cursor: pointer;
}
`;

    /**
     * 面板自己是否要求展开。用宿主写在面板元素上的开合标记判断：拿「展开按钮
     * 在不在」推断会误判——切到全局面板（设置、插件页）时会话头部会卸载，
     * 按钮随之消失，但面板并没有要求展开。
     */
    function rightbarWanted() {
      return document.querySelector(RIGHT_PANEL_OPEN_SELECTOR) !== null;
    }

    /**
     * 给当前挂载的外壳框架打标记，所有窄屏规则都挂在这个标记上，并同步右栏的
     * 「面板想展开」状态。每次写属性前先比一次，避免无谓的 DOM 写入。
     */
    function syncFrame() {
      const overlay = document.querySelector(OVERLAY_SELECTOR);
      const frame = overlay === null ? null : overlay.parentElement;
      if (frame === null || frame === undefined) return;
      if (!frame.hasAttribute(FRAME_ATTRIBUTE)) frame.setAttribute(FRAME_ATTRIBUTE, '');
      const wanted = rightbarWanted();
      if (frame.hasAttribute(RIGHT_WANT_ATTRIBUTE) !== wanted) {
        frame.toggleAttribute(RIGHT_WANT_ATTRIBUTE, wanted);
      }
    }

    /**
     * 框架与面板状态都可能晚于插件变化，跟着 DOM 变化同步。聊天流式输出会持续
     * 产生 childList 变更，所以合并到每帧一次，不在每个 mutation 批次里扫 DOM。
     * 面板的开合同样要跟：有时只改属性、不增删节点（没有会话头部的宽度下用快捷键
     * 切换右栏），只监听 childList 会漏掉。
     */
    function installFrameTag() {
      let queued = 0;
      const schedule = () => {
        if (queued !== 0) return;
        queued = window.requestAnimationFrame(() => {
          queued = 0;
          syncFrame();
        });
      };
      syncFrame();
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, {
        childList: true,
        attributes: true,
        attributeFilter: ['data-sidebar-right-open'],
        subtree: true,
      });
      return () => {
        observer.disconnect();
        if (queued !== 0) window.cancelAnimationFrame(queued);
        const frame = document.querySelector(FRAME_SELECTOR);
        if (frame !== null) {
          frame.removeAttribute(FRAME_ATTRIBUTE);
          frame.removeAttribute(RIGHT_WANT_ATTRIBUTE);
        }
      };
    }

    /** Read the frame's narrow state without touching its DOM. */
    function readFrame() {
      const frame = document.querySelector(FRAME_SELECTOR);
      return {
        compact: window.matchMedia(MOBILE_QUERY).matches,
        left: frame !== null && !frame.hasAttribute('data-sidebar-collapsed'),
        right: frame !== null &&
          (!frame.hasAttribute('data-rightbar-collapsed') || frame.hasAttribute(RIGHT_WANT_ATTRIBUTE)),
      };
    }

    /** The current Session is the one the main view retains. */
    function selectCurrentSession(state) {
      const byId = (state && state.byId) || {};
      for (const session of Object.values(byId)) {
        if (session && session.retainedBy && session.retainedBy.mainView > 0) return session.id;
      }
      return null;
    }

    /** Drop this much viewport before calling it an on-screen keyboard. */
    const KEYBOARD_MIN = 120;

    /**
     * Height the shell should take while an on-screen keyboard is up.
     * @param layout - layout viewport height in px (window.innerHeight).
     * @param visual - visual viewport height in px.
     * @param scale - visual viewport zoom scale.
     * @returns the pinned height in px, or null when no keyboard is up.
     */
    function keyboardHeight(layout, visual, scale) {
      if (!(layout > 0) || !(visual > 0)) return null;
      if (scale > 1.01) return null;
      if (layout - visual <= KEYBOARD_MIN) return null;
      return Math.round(visual);
    }

    /**
     * Pin the document to the visual viewport while the keyboard is open. The
     * shell has no IME handling of its own: it sizes to the layout viewport,
     * which the keyboard does not resize, so the composer stays behind it and
     * the browser's own panning leaves a strip of page background.
     * @returns the disposer.
     */
    function installKeyboardFit() {
      const viewport = window.visualViewport;
      if (viewport === undefined) return () => {};
      const root = document.documentElement;
      let frame = 0;
      const apply = () => {
        frame = 0;
        const height = keyboardHeight(window.innerHeight, viewport.height, viewport.scale);
        if (height === null) root.style.removeProperty('--x-msd-app-height');
        else root.style.setProperty('--x-msd-app-height', height + 'px');
      };
      const schedule = () => {
        if (frame !== 0) return;
        frame = window.requestAnimationFrame(apply);
      };
      apply();
      viewport.addEventListener('resize', schedule);
      viewport.addEventListener('scroll', schedule);
      return () => {
        viewport.removeEventListener('resize', schedule);
        viewport.removeEventListener('scroll', schedule);
        if (frame !== 0) window.cancelAnimationFrame(frame);
        root.style.removeProperty('--x-msd-app-height');
      };
    }

    /** Track the frame's effective column state without touching its DOM. */
    function useFrameState() {
      const [state, setState] = React.useState(readFrame);
      React.useEffect(() => {
        const update = () => {
          setState(readFrame());
        };
        update();
        const observer = new MutationObserver(update);
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed', RIGHT_WANT_ATTRIBUTE, FRAME_ATTRIBUTE],
          subtree: true,
        });
        const query = window.matchMedia(MOBILE_QUERY);
        query.addEventListener('change', update);
        return () => {
          observer.disconnect();
          query.removeEventListener('change', update);
        };
      }, []);
      return state;
    }

    /** A deliberate swipe: this far, this horizontal, this quick. */
    const SWIPE_MIN = 56;
    const SWIPE_MAX_MS = 900;
    const SWIPE_DOMINANCE = 0.7;

    /**
     * 判断一次触摸手势对两个抽屉意味着什么。
     * @param gesture - 起点 x、相对起点的位移、耗时。
     * @param drawersOf - 取当前开合状态的函数，只在线性阈值都通过后才调用。
     * @param viewportWidth - 当前视口宽度（px）。
     * @returns 抽屉动作，或 null（这次手势不归抽屉管）。
     */
    function swipeIntent(gesture, drawersOf, viewportWidth) {
      const { startX, dx, dy, dt } = gesture;
      if (dt > SWIPE_MAX_MS) return null;
      if (Math.abs(dx) < SWIPE_MIN) return null;
      if (Math.abs(dy) > Math.abs(dx) * SWIPE_DOMINANCE) return null;
      const drawers = drawersOf();
      /* 同时只会开一个抽屉：先处理收起，再按起手位置决定展开哪一侧。 */
      if (drawers.right) return dx > 0 ? 'close-right' : null;
      if (drawers.left) return dx < 0 ? 'close-left' : null;
      if (startX > viewportWidth * 0.5) return dx < 0 ? 'open-right' : null;
      return dx > 0 ? 'open-left' : null;
    }

    /** Horizontal scrollers keep their own drags: code blocks, tables, rails. */
    function startsInHorizontalScroller(target) {
      let node = target instanceof Element ? target : null;
      for (let depth = 0; node !== null && depth < 6; depth += 1) {
        if (node.scrollWidth > node.clientWidth + 1) {
          const overflowX = window.getComputedStyle(node).overflowX;
          if (overflowX === 'auto' || overflowX === 'scroll') return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    /**
     * 窄屏触摸导航：左半屏向右滑展开左抽屉，右半屏向左滑展开右抽屉，抽屉开着时
     * 反向滑动收起。监听一律 passive，不取消滚动。
     * 抽屉状态在手势发生的瞬间现读，不用渲染时的快照——否则刚收起就反向滑动会
     * 撞上还没刷新的旧状态。
     * @param enabled - 窄屏布局是否生效。
     * @param run - 执行手势判定出来的动作。
     */
    function useSwipeGesture(enabled, run) {
      const runRef = React.useRef(run);
      runRef.current = run;
      React.useEffect(() => {
        if (!enabled) return undefined;
        let start = null;
        const onStart = (event) => {
          start = null;
          if (event.touches.length !== 1) return;
          /* A modal owns the screen: leave its drags to it (sliders, sheets). */
          if (document.querySelector('[aria-modal="true"]') !== null) return;
          const target = event.target;
          if (target instanceof Element) {
            if (target.closest('input, textarea, [contenteditable="true"]') !== null) return;
            if (startsInHorizontalScroller(target)) return;
          }
          const touch = event.touches[0];
          start = { startX: touch.clientX, x: touch.clientX, y: touch.clientY, at: Date.now() };
        };
        const onMove = (event) => {
          if (start === null || event.touches.length !== 1) return;
          const touch = event.touches[0];
          const intent = swipeIntent(
            {
              startX: start.startX,
              dx: touch.clientX - start.x,
              dy: touch.clientY - start.y,
              dt: Date.now() - start.at,
            },
            readFrame,
            window.innerWidth,
          );
          if (intent === null) return;
          start = null;
          runRef.current(intent);
        };
        const onEnd = () => {
          start = null;
        };
        document.addEventListener('touchstart', onStart, { passive: true });
        document.addEventListener('touchmove', onMove, { passive: true });
        document.addEventListener('touchend', onEnd, { passive: true });
        document.addEventListener('touchcancel', onEnd, { passive: true });
        return () => {
          document.removeEventListener('touchstart', onStart);
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onEnd);
          document.removeEventListener('touchcancel', onEnd);
        };
      }, [enabled]);
    }

    /*
     * The product mark. Geometry is copied verbatim from the shipped web
     * favicon (`dsh-web-frontend/dist/favicon.svg`, MIT); that artwork is
     * monochrome — black on light, white on dark — so it is painted with
     * `currentColor` to inherit the header's label color in either theme.
     */
    const MARK_PATH = "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z";
    const MARK_VIEW_BOX = '0 0 50 50';

    /** The official brand mark, sized for a header control. */
    function BrandMark() {
      return h(
        'svg',
        {
          viewBox: MARK_VIEW_BOX,
          width: 20,
          height: 20,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: MARK_PATH, fill: 'currentColor' }),
      );
    }

    /** 点一下页面上已有的控件：右栏的开关归面板自己管，本插件只替用户点它。 */
    function clickFirst(selector) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) element.click();
    }

    /**
     * 抽屉动作。实现由 apply 注入，组件层直接调用，不走 slot 的参数传递：
     * 这样手势、图标按钮和遮罩用的是同一条实现。
     */
    const drawers = {
      toggleLeft: () => {},
      openRight: () => {},
      closeRight: () => {},
    };

    /**
     * Header leading seat: the brand logo that opens the sidebar on narrow
     * viewports, rendered before the Session title.
     */
    function SidebarSeat({ t }) {
      const frame = useFrameState();
      if (!frame.compact) return null;
      return h(
        'button',
        {
          type: 'button',
          className: 'x-msd-seat',
          'aria-label': t(frame.left ? 'close' : 'open'),
          title: t(frame.left ? 'close' : 'open'),
          onClick: () => {
            drawers.toggleLeft();
          },
        },
        h(BrandMark),
      );
    }

    /** 两个抽屉的关闭层；切换会话或面板时也由它收口。 */
    function DrawerScrim({ useSessions, usePanelInfo }) {
      const frame = useFrameState();
      const session = useSessions(selectCurrentSession);
      const panel = usePanelInfo((info) => (info ? info.activePanelId : null));
      const seen = React.useRef({ session, panel });

      const run = React.useCallback((action) => {
        if (action === 'open-right') drawers.openRight();
        else if (action === 'close-right') drawers.closeRight();
        else drawers.toggleLeft();
      }, []);

      useSwipeGesture(frame.compact, run);

      const shown = frame.compact && (frame.left || frame.right);

      React.useEffect(() => {
        const previous = seen.current;
        seen.current = { session, panel };
        if (!frame.compact) return;
        if (previous.session === session && previous.panel === panel) return;
        if (frame.left) drawers.toggleLeft();
        if (frame.right) drawers.closeRight();
      }, [frame.compact, frame.left, frame.right, panel, session]);

      React.useEffect(() => {
        if (!shown) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (frame.right) drawers.closeRight();
          else if (frame.left) drawers.toggleLeft();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
          window.removeEventListener('keydown', onKeyDown);
        };
      }, [shown, frame.left, frame.right]);

      /*
       * 右栏在这里是覆盖层：打开时把焦点移进面板，关闭时还给原来的元素。
       * 不做焦点陷阱——面板内容归宿主所有，锁住 Tab 会和它自己的浮层打架。
       */
      const restoreFocus = React.useRef(null);
      React.useEffect(() => {
        if (!frame.compact || !frame.right) return undefined;
        const panel = document.querySelector('[data-sidebar-right-panel]');
        if (panel === null) return undefined;
        const previous = document.activeElement;
        restoreFocus.current = previous instanceof HTMLElement ? previous : null;
        const target = panel.querySelector('button, [href], input, [tabindex]:not([tabindex="-1"])');
        if (target instanceof HTMLElement) target.focus({ preventScroll: true });
        return () => {
          const back = restoreFocus.current;
          restoreFocus.current = null;
          if (back !== null && back.isConnected) back.focus({ preventScroll: true });
        };
      }, [frame.compact, frame.right]);

      if (!shown) return null;
      return h('div', {
        className: 'x-msd-scrim',
        'aria-hidden': 'true',
        onClick: () => {
          if (frame.right) drawers.closeRight();
          else drawers.toggleLeft();
        },
      });
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        drawers.toggleLeft = () => {
          ctx.layout.toggleSidebar();
        };
        drawers.openRight = () => {
          clickFirst(RIGHT_OPEN_SELECTOR);
        };
        /*
         * 面板上的按钮是开关，不是关闭。状态快照可能比真实 DOM 慢一拍，直接点
         * 下去会把已收起的面板重新打开，所以点之前先确认它确实开着。
         */
        drawers.closeRight = () => {
          if (document.querySelector(RIGHT_PANEL_OPEN_SELECTOR) === null) return;
          clickFirst(RIGHT_CLOSE_SELECTOR);
        };
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'mobile-fit: dictionaries');
        ctx.effect(() => installFrameTag(), 'mobile-fit: shell frame tag');
        ctx.effect(() => installKeyboardFit(), 'mobile-fit: keyboard fit');
        ctx.effect(() => {
          if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return undefined;
          const tag = document.createElement('style');
          tag.dataset.plugin = '@local/mobile-fit';
          tag.dataset.pluginCss = STYLE_TAG;
          tag.textContent = css;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'mobile-fit: narrow shell stylesheet');
        ctx.slots.inject('conversation.header.leading', () =>
          ctx.slots.register(
            {
              name: 'conversation.header.leading',
              locale: NS,
            },
            SidebarSeat,
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'mobile-fit',
              order: 90,
              locale: NS,
            },
            DrawerScrim,
          ),
        );
      },
    };
  },
});

