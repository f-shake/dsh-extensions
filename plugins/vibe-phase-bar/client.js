window.__ModuleLoader__.load({
  id: '@local/vibe-phase-bar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 阶段短名。与 SKILL.md 的横幅、脚注同一套词。 */
    const PHASES = [
      { n: 1, label: '计划' },
      { n: 2, label: '开发' },
      { n: 3, label: '复核' },
      { n: 4, label: '验证' },
      { n: 5, label: '提交' },
    ];

    /** 轮询间隔。宿主状态只由工具与点击改动，一秒一次足够。 */
    const POLL_MS = 1000;
    /** 启动消息。用自然语言而不是 /vibe-coding，避免落到命令通道上不产生模型消息。 */
    const START_TEXT = '用 vibe coding 开一个新流程，进入阶段一，等我说构想。';
    const STYLE_ID = 'vibe-phase-bar';

    /**
     * 每个会话一份状态源。图标与条共用它，所以用引用计数决定何时轮询。
     * @param {string} sessionId - 会话 id。
     * @returns {object} 订阅入口。
     */
    function createStore(sessionId) {
      let snapshot = { loaded: false, state: null, error: false };
      const listeners = new Set();
      let timer = null;
      let refs = 0;
      let fetching = false;

      const publish = (patch) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of [...listeners]) listener();
      };

      const load = async () => {
        if (fetching) return;
        fetching = true;
        try {
          const response = await fetch(`/vibe-phase/state?session=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          const next = body?.state ?? null;
          // 只在内容真变了才换快照：否则每秒一次轮询都会触发整棵子树重渲染。
          // 「两边都是 null」也算没变——大多数会话根本没有流程，不该秒秒重渲染。
          // error 为真时必须放行一次：点击失败时本地那个乐观快照沿用了旧 version，
          // 只看 version 会把宿主的真实状态判成「没变」，错位就一直挂着。
          const changed =
            snapshot.error ||
            !snapshot.loaded ||
            (next === null) !== (snapshot.state === null) ||
            (next !== null && next.version !== snapshot.state.version);
          if (changed) publish({ loaded: true, state: next, error: false });
        } catch {
          // 保留上一次状态，只把条标成「未同步」；首次就失败时保持 loaded=false，
          // 这样启动图标不会在「不知道有没有流程」的时候冒出来。
          publish({ error: true });
        } finally {
          fetching = false;
        }
      };

      const start = () => {
        refs += 1;
        if (refs === 1) {
          void load();
          timer = window.setInterval(() => void load(), POLL_MS);
        }
        return () => {
          refs -= 1;
          if (refs === 0 && timer !== null) {
            window.clearInterval(timer);
            timer = null;
          }
        };
      };

      const request = async (path, payload) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot() {
          return snapshot;
        },
        start,
        /**
         * 点一个阶段：先本地乐观置位（点击即停止闪烁），再用宿主返回的状态对齐。
         * @param {number} phase - 目标阶段。
         */
        async click(phase) {
          const current = snapshot.state;
          if (current === null) return;
          publish({ state: { ...current, phase, pending: null }, error: false });
          try {
            const body = await request('/vibe-phase/confirm', { session: sessionId, phase });
            publish({ state: body?.state ?? null, error: false });
          } catch {
            publish({ error: true });
            void load();
          }
        },
        async reset() {
          try {
            await request('/vibe-phase/reset', { session: sessionId });
            publish({ state: null, error: false });
          } catch {
            publish({ error: true });
          }
        },
      };
    }

    const stores = new Map();

    /**
     * 取（或建）某个会话的状态源。
     * @param {string} sessionId - 会话 id。
     * @returns {object} 状态源。
     */
    function storeFor(sessionId) {
      let store = stores.get(sessionId);
      if (store === undefined) {
        store = createStore(sessionId);
        stores.set(sessionId, store);
      }
      return store;
    }

    /**
     * 订阅某个会话的阶段状态，并在挂载期间维持轮询。
     * @param {string} sessionId - 会话 id。
     * @returns {{ store: object, snapshot: object }} 状态源与当前快照。
     */
    function usePhaseStore(sessionId) {
      const store = storeFor(sessionId);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      React.useEffect(() => store.start(), [store]);
      return { store, snapshot };
    }

    /**
     * 一个 chip 的显示态。
     * @param {number} phase - 阶段号。
     * @param {object} state - 当前状态。
     * @returns {'pending' | 'skipped' | 'done' | 'current' | 'future'} 显示态。
     */
    function chipState(phase, state) {
      if (state.pending === phase) return 'pending';
      if (state.skipped.includes(phase)) return 'skipped';
      if (phase < state.phase) return 'done';
      if (phase === state.phase) return 'current';
      return 'future';
    }

    /**
     * 阶段五的附加态：预提交待授权 / 已授权。
     * @param {object} state - 当前状态。
     * @returns {string | undefined} 附加态。
     */
    function commitSubstate(state) {
      if (state.phase !== 5) return undefined;
      if (state.authorized) return 'authorized';
      if (state.precommit) return 'precommit';
      return undefined;
    }

    /**
     * 某个 chip 的悬停说明。
     * @param {number} phase - 阶段号。
     * @param {object} state - 当前状态。
     * @returns {string} 说明文字。
     */
    function chipTitle(phase, state) {
      const name = PHASES[phase - 1].label;
      if (state.pending === phase) return `阶段 ${phase}（${name}）等待你确认`;
      if (phase === 5 && state.phase === 5) {
        if (state.authorized) return '已授权提交';
        if (state.precommit) return '再次点击授权提交';
        return '点击进入预提交';
      }
      return `阶段 ${phase}（${name}）`;
    }

    /**
     * 点击 chip。阶段合法性、冷却与幂等都由宿主判定——浏览器时钟和宿主时钟可能
     * 不一致（本仓库支持远端访问），在本地先拦一次会让远端用户「点了没反应」。
     * @param {object} store - 状态源。
     * @param {object} state - 当前状态。
     * @param {number} target - 目标阶段。
     */
    function onChipClick(store, state, target) {
      if (target === state.phase && (target !== 5 || state.authorized)) return;
      void store.click(target);
    }

    /**
     * 注入样式表，返回卸载时移除它的清理函数。
     * 同时写 data-plugin 与 data-plugin-css：客户端模块系统只认前者回收旧样式，
     * 少了它，HMR 换代后旧样式会一直留着，改动必须整页刷新才生效。
     * @returns {() => void} 清理函数。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/vibe-phase-bar';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = `
[data-vibe-phase]{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:2px 14px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary,#14181f)}
[data-vibe-phase] .vpb-track{display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none}
[data-vibe-phase] .vpb-track::-webkit-scrollbar{display:none}
[data-vibe-phase] .vpb-chip{flex:0 0 auto;border:0;background:transparent;color:inherit;font:inherit;padding:3px 9px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:background .15s ease,color .15s ease,opacity .15s ease}
[data-vibe-phase] .vpb-chip:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 6%,transparent)}
[data-vibe-phase] .vpb-chip[data-state="done"]{opacity:.82}
[data-vibe-phase] .vpb-chip[data-state="current"]{opacity:1;font-weight:600;color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176f5) 82%,var(--dsw-alias-label-primary,#14181f));background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176f5) 11%,transparent)}
[data-vibe-phase] .vpb-chip[data-state="skipped"]{opacity:.4;text-decoration:line-through}
[data-vibe-phase] .vpb-chip[data-state="future"]{opacity:.42}
[data-vibe-phase] .vpb-chip[data-state="pending"]{opacity:1;background:color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 8%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176f5) 68%,var(--dsw-alias-label-primary,#14181f));animation:vpb-blink 1.2s ease-in-out infinite}
[data-vibe-phase] .vpb-chip[data-substate="precommit"]::after{content:"·";margin-left:4px}
[data-vibe-phase] .vpb-chip[data-substate="authorized"]::after{content:"✓";margin-left:4px;opacity:.8}
[data-vibe-phase] .vpb-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
[data-vibe-phase] .vpb-error{flex:0 0 auto;opacity:.7}
[data-vibe-phase] .vpb-close{flex:0 0 auto;border:0;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1;padding:2px 6px;border-radius:6px;cursor:pointer;opacity:.45}
[data-vibe-phase] .vpb-close:hover{opacity:1;background:color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 8%,transparent)}
[data-vibe-phase] .vpb-close[data-confirming]{opacity:1;font-size:12px;padding:3px 9px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 10%,transparent)}
@keyframes vpb-blink{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion: reduce){
[data-vibe-phase] .vpb-chip[data-state="pending"]{animation:none;font-weight:600}
[data-vibe-phase] .vpb-chip[data-state="pending"]::before{content:"";display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:currentColor;vertical-align:middle}
}
[data-vibe-start]{display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;opacity:.7}
[data-vibe-start]:hover{opacity:1;background:color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 8%,transparent)}
`;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * 左下角的启动图标：只在没有流程状态时出现。
     * @param {object} props - 插槽标准属性。
     * @returns {object | null} 按钮。
     */
    function StartButton({ sessionId, inputActions, useInput }) {
      const { snapshot } = usePhaseStore(sessionId);
      const readInput = typeof useInput === 'function' ? useInput : () => '';
      const draft = readInput((value) => value?.draft ?? '');

      if (!snapshot.loaded || snapshot.state !== null) return null;

      const start = () => {
        if (inputActions === undefined) return;
        const saved = draft;
        inputActions.setDraft(START_TEXT);
        inputActions.submit();
        // 启动消息借道正常提交，草稿会被一起带走；用户原来写的字在提交后放回去。
        if (saved !== '') window.setTimeout(() => inputActions.setDraft(saved), 60);
      };

      return h(
        'button',
        {
          type: 'button',
          'data-vibe-start': '',
          title: '用 vibe coding 开始一个流程',
          'aria-label': '用 vibe coding 开始一个流程',
          onClick: start,
        },
        h('span', { 'aria-hidden': 'true' }, '</>'),
      );
    }

    /**
     * 输入框上方的五阶段条。
     * @param {object} props - 插槽标准属性。
     * @returns {object | null} 阶段条。
     */
    function PhaseBar({ sessionId }) {
      const { store, snapshot } = usePhaseStore(sessionId);
      const [confirming, setConfirming] = React.useState(false);
      React.useEffect(() => {
        if (!confirming) return undefined;
        // 二次确认只等一次点击；四秒没动就收回，免得下一眼还停在「关闭？」上。
        const timer = window.setTimeout(() => setConfirming(false), 4000);
        return () => window.clearTimeout(timer);
      }, [confirming]);

      const state = snapshot.state;
      if (!snapshot.loaded || state === null) return null;

      const close = () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        void store.reset();
      };

      const chips = PHASES.map((item) =>
        h(
          'button',
          {
            key: item.n,
            type: 'button',
            role: 'tab',
            className: 'vpb-chip',
            'data-state': chipState(item.n, state),
            'data-substate': item.n === 5 ? commitSubstate(state) : undefined,
            'aria-current': item.n === state.phase ? 'step' : undefined,
            // 等待语义只放在 title（描述）里；名称保持「N 短名」，免得聚焦时被连读两句近义内容。
            'aria-label': `${item.n} ${item.label}`,
            title: chipTitle(item.n, state),
            onClick: () => onChipClick(store, state, item.n),
          },
          item.label,
        ),
      );

      return h(
        'div',
        {
          'data-vibe-phase': '',
          role: 'group',
          'aria-label': 'vibe coding 阶段',
        },
        h('div', { className: 'vpb-track', role: 'tablist' }, chips),
        // 容器常驻、只换文字：live region 必须先在 DOM 里，后填入内容才会被播报。
        h(
          'span',
          { className: 'vpb-sr', role: 'status' },
          state.pending !== null
            ? `等待确认进入阶段 ${state.pending}（${PHASES[state.pending - 1].label}）`
            : '',
        ),
        snapshot.error ? h('span', { className: 'vpb-error', role: 'status' }, '状态未同步') : null,
        h(
          'button',
          {
            type: 'button',
            className: 'vpb-close',
            'data-confirming': confirming ? '' : undefined,
            title: confirming ? '再点一次关闭流程' : '关闭流程',
            'aria-label': confirming ? '再点一次确认关闭流程' : '关闭流程',
            onClick: close,
          },
          confirming ? '关闭？' : '×',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ensureStyle(), 'vibe-phase-bar: styles');
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'vibe-phase-start', order: 60 },
            StartButton,
          ),
        );
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'vibe-phase', order: 40 }, PhaseBar),
        );
      },
    };
  },
});
