/**
 * 窄屏抽屉的滑动手势。
 *
 * 为什么还要这个插件：0.2.2 的官方布局在 768px 以下已经自带抽屉（`data-sidebar-drawer`
 * + 遮罩 `data-sidebar-mask` + 左上角开关），但**没有**任何触摸手势——左滑右滑
 * 打不开也关不掉侧边栏。旧 mobile-fit 里这套手势是好用的，只是它的 CSS 抽屉
 * 已和官方重复，所以单独抽出来：只保留手势，不碰布局。
 *
 * 规则（沿用 mobile-fit 实测过的参数）：
 * - 左半屏向右滑 → 展开左抽屉；右半屏向左滑 → 展开右栏；
 * - 任一侧开着时，反向滑动就是收起（一次只开一侧，所以先判收起）；
 * - 位移 ≥56px、耗时 ≤900ms、横向位移占优（|dy| ≤ 0.7·|dx|）才算数。
 *
 * 不抢手势的场景：模态框打开时、起手落在输入区、起手落在横向滚动容器里。
 * 监听全部 passive，不阻断页面自己的滚动。
 */
window.__ModuleLoader__.load({
  id: '@local/swipe-sidebar',
  factory() {
    /** A deliberate swipe: this far, this horizontal, this quick. */
    const SWIPE_MIN = 56;
    const SWIPE_MAX_MS = 900;
    const SWIPE_DOMINANCE = 0.7;

    /** 官方抽屉遮罩；它在抽屉模式下始终渲染，用它认"现在是窄屏抽屉模式"。 */
    const MASK = '[data-sidebar-mask]';
    /** 帧元素在抽屉打开时没有 data-sidebar-collapsed（收起才有）。 */
    const COLLAPSED = 'data-sidebar-collapsed';
    /** 右侧栏打开状态挂在这个元素上；开关按钮由面板自己管，这里只替用户点。 */
    const RIGHT_PANEL_OPEN = '[data-sidebar-right-panel][data-sidebar-right-open]';
    const RIGHT_OPEN_BUTTON = '[data-sidebar-right-expand]';
    const RIGHT_CLOSE_BUTTON = '[data-sidebar-right-toggle]';

    /**
     * 判断一次触摸手势对两个抽屉意味着什么。
     *
     * 抽屉状态在调用时才读，不用事件开始时的快照：刚收起就反向滑动时，状态
     * 可能还没刷新完。
     * @param {{ startX: number, dx: number, dy: number, dt: number }} gesture - 位移与耗时。
     * @param {() => { left: boolean, right: boolean }} drawersOf - 读当前开合状态。
     * @param {number} viewportWidth - 当前视口宽度（px）。
     * @returns {'open-left' | 'close-left' | 'open-right' | 'close-right' | null} 动作或 null。
     */
    function swipeIntent(gesture, drawersOf, viewportWidth) {
      const { startX, dx, dy, dt } = gesture;
      if (dt > SWIPE_MAX_MS) return null;
      if (Math.abs(dx) < SWIPE_MIN) return null;
      if (Math.abs(dy) > Math.abs(dx) * SWIPE_DOMINANCE) return null;
      const drawers = drawersOf();
      if (drawers.right) return dx > 0 ? 'close-right' : null;
      if (drawers.left) return dx < 0 ? 'close-left' : null;
      if (startX > viewportWidth * 0.5) return dx < 0 ? 'open-right' : null;
      return dx > 0 ? 'open-left' : null;
    }

    /**
     * 横向滚动容器保留自己的拖动：代码块、表格、横向卡片列表。
     * @param {Element | null} target - 起手元素。
     * @returns {boolean} 是否在横向滚动器里。
     */
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
     * 读两个抽屉的当前状态。
     * @returns {{ left: boolean, right: boolean }} 状态。
     */
    function readDrawers() {
      const mask = document.querySelector(MASK);
      const frame = mask === null ? null : mask.parentElement;
      return {
        left: frame !== null && !frame.hasAttribute(COLLAPSED),
        right: document.querySelector(RIGHT_PANEL_OPEN) !== null,
      };
    }

    /**
     * 点一下页面上已有的控件：右栏的开关归面板自己管，本插件只替用户点它。
     * @param {string} selector - 目标选择器。
     */
    function clickFirst(selector) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) element.click();
    }

    /**
     * 执行手势判定出来的动作。
     * @param {'open-left' | 'close-left' | 'open-right' | 'close-right'} action - 动作。
     * @param {{ toggleSidebar: () => void }} layout - 官方布局服务。
     */
    function run(action, layout) {
      if (action === 'open-right') clickFirst(RIGHT_OPEN_BUTTON);
      else if (action === 'close-right') clickFirst(RIGHT_CLOSE_BUTTON);
      else layout.toggleSidebar();
    }

    /**
     * 装上手势监听，返回卸载函数。
     * @param {{ toggleSidebar: () => void }} layout - 官方布局服务。
     * @returns {() => void} 卸载函数。
     */
    function install(layout) {
      let start = null;

      const onStart = (event) => {
        start = null;
        if (event.touches.length !== 1) return;
        /*
         * 模态框占着屏幕时，手势必归它（滑杆、抽屉、sheet）。
         *
         * 但官方抽屉在窄屏下**自己**就是 `aria-modal="true"`（`dsh-client-ui-sidebar`
         * 在 `drawer && !collapsed` 时给它写这个属性），而它正是本插件要操作的对象：
         * 按「文档里存在 aria-modal 就退出」来判断，左抽屉一开，手势就永远收不起来。
         * 官方给抽屉打了 `data-shortcut-modal="sidebar"`，用这个标记把它摘出去。
         *
         * 必须看**全部** aria-modal 而不是 `querySelector` 的第一个：抽屉留在 `#root` 里，
         * 官方弹窗（设置、快捷键、账号面板）经 createPortal 挂在 body 末尾。两者同时打开时
         * 第一个永远是被摘出去的抽屉，只取首个就会放行，手势会作用在弹窗背后的抽屉上。
         */
        const modals = document.querySelectorAll('[aria-modal="true"]');
        if ([...modals].some((el) => el.getAttribute('data-shortcut-modal') !== 'sidebar')) return;
        /* 只有官方抽屉模式下才有左抽屉可开合；宽屏交给鼠标。 */
        if (document.querySelector(MASK) === null) return;
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
          readDrawers,
          window.innerWidth,
        );
        if (intent === null) return;
        start = null;
        run(intent, layout);
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
    }

    return {
      /** 只用官方布局服务的开关，不注入任何插槽。 */
      inject: ['layout'],
      apply(ctx) {
        ctx.effect(
          () => install(ctx.layout),
          'swipe-sidebar: drawer swipe gestures',
        );
      },
      /** 只给单测用。 */
      __test: {
        swipeIntent,
        startsInHorizontalScroller,
        install,
      },
    };
  },
});
