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
    /**
     * 点「计划」时填进输入框的命令。
     *
     * 与在 `/` 菜单里选技能落下的文本完全一致（`dsh-client-ui-skill` 的 onPick 返回
     * `/${name} `），所以填完之后光标就在末尾，用户接着写构想即可。
     */
    const SKILL_COMMAND = '/vibe-coding ';
    /** 阶段四的验证方式。id 与宿主一致，顺序即弹框顺序。 */
    const VERIFY_CHOICES = [
      { id: 'unit', label: '全量单元测试', note: '整套单元测试跑一遍' },
      {
        id: 'unit-scope',
        label: '改动相关单元测试',
        note: '只跑这次改动涉及模块的单测',
      },
      { id: 'e2e', label: '端到端验证', note: '按真实路径把流程走通' },
      { id: 'release', label: '发布测试', note: '打包与发布链路' },
    ];
    /** 阶段四弹框的默认勾选：单测 + 端到端。 */
    const DEFAULT_VERIFY = ['unit', 'e2e'];
    const STYLE_ID = 'vibe-phase-bar';

    /**
     * 点击瞬间的本地状态：只算条上要显示的那几个字段，其余仍以宿主返回为准。
     * @param {object} state - 点击前的状态。
     * @param {number} phase - 目标阶段。
     * @param {object} [options] - 这次点击的选项。
     * @returns {object} 乐观状态。
     */
    function optimistic(state, phase, options) {
      const next = { ...state, phase, pending: null };
      if (phase === 2 && options !== undefined && options.devSplit === true) {
        next.devMode = 'split';
        next.devStep = 'a';
      } else if (phase === 2 && state.devMode === 'split' && state.devStep === 'a') {
        next.devStep = 'b';
      }
      if (options !== undefined && Array.isArray(options.verify)) next.verify = options.verify;
      return next;
    }

    /**
     * 每个会话一份状态源。按钮与条共用它，所以用引用计数决定何时轮询。
     * @param {string} sessionId - 会话 id。
     * @returns {object} 订阅入口。
     */
    function createStore(sessionId) {
      // hidden 与 lastVerify 只属于这一侧：隐藏是纯视觉开关，上次选的验证方式只用来
      // 给弹框当默认值，都不写回宿主。
      let snapshot = {
        loaded: false,
        state: null,
        error: false,
        hidden: false,
        lastVerify: [...DEFAULT_VERIFY],
        notice: null,
      };
      const listeners = new Set();
      let timer = null;
      let refs = 0;
      let fetching = false;
      // 每次本地写入都 +1。轮询出发时记下票号，回来时票号对不上就丢掉结果——
      // 否则一次在飞的旧轮询会把刚点出来的状态覆盖回去（条闪一下就没了）。
      let issued = 0;
      let noticeTimer = null;

      const publish = (patch) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of [...listeners]) listener();
      };

      /**
       * 在条尾留一句话，四秒后自己消失。
       * @param {string} text - 提示文案。
       */
      const showNotice = (text) => {
        if (noticeTimer !== null) window.clearTimeout(noticeTimer);
        publish({ notice: text });
        noticeTimer = window.setTimeout(() => {
          noticeTimer = null;
          publish({ notice: null });
        }, 4000);
      };

      const load = async () => {
        if (fetching) return;
        fetching = true;
        const ticket = ++issued;
        try {
          const response = await fetch(`/vibe-phase/state?session=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          const next = body?.state ?? null;
          // 这中间发生过点击/开条/关闭，这次结果已经过期，丢掉。
          if (ticket !== issued) return;
          // 只在内容真变了才换快照：否则每秒一次轮询都会触发整棵子树重渲染。
          // 「两边都是 null」也算没变——大多数会话根本没有流程，不该秒秒重渲染。
          // error 为真时必须放行一次：点击失败时本地那个乐观快照沿用了旧 version，
          // 只看 version 会把宿主的真实状态判成「没变」，错位就一直挂着。
          const changed =
            snapshot.error ||
            !snapshot.loaded ||
            (next === null) !== (snapshot.state === null) ||
            (next !== null && next.version !== snapshot.state.version);
          // 流程在别处被关掉时（另一个标签页点 ×）把隐藏与上次选项一并复位，
          // 否则按钮会停在「已隐藏」却再也点不出条来，下一轮还会沿用上一轮的选项。
          if (changed) {
            publish({
              loaded: true,
              state: next,
              error: false,
              hidden: next === null ? false : snapshot.hidden,
              lastVerify: next === null ? [...DEFAULT_VERIFY] : snapshot.lastVerify,
            });
          }
        } catch {
          // 保留上一次状态，只把条标成「未同步」；首次就失败时保持 loaded=false，
          // 这样按钮不会在「不知道有没有流程」的时候冒出来。
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
        if (!response.ok) {
          // 把状态码带出去：选项非法（400）与会话已不在（409/502）该给用户的提示不同。
          const error = new Error(`HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
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
         * @param {object} [options] - 弹框里选好的选项。
         */
        async click(phase, options) {
          const current = snapshot.state;
          if (current === null) return;
          issued += 1;
          publish({ state: optimistic(current, phase, options), error: false });
          try {
            const body = await request('/vibe-phase/confirm', { session: sessionId, phase, options });
            publish({ state: body?.state ?? null, error: false, notice: null });
          } catch (error) {
            // 界面上只留一句话，具体原因留在控制台，排查时不用靠猜。
            console.warn('[vibe-phase] 确认失败', error);
            publish({ error: true });
            showNotice(error?.status === 400 ? '选项无效，请重新选择' : '确认失败，请再点一次');
            void load();
          }
        },
        /**
         * 没有流程时点按钮：只把阶段一状态建出来，不发消息。
         * @param {boolean} [fresh] - 已有流程时也把状态清回阶段一（点「计划」重开用）。
         */
        async open(fresh = false) {
          issued += 1;
          try {
            const body = await request('/vibe-phase/open', { session: sessionId, fresh });
            publish({
              loaded: true,
              state: body?.state ?? null,
              error: false,
              hidden: false,
              notice: null,
            });
          } catch (error) {
            console.warn('[vibe-phase] 开条失败', error);
            publish({ error: true });
            showNotice('开不出阶段条，请刷新页面再试');
          }
        },
        /**
         * 收起或展开条。
         * @param {boolean} value - 是否隐藏。
         */
        setHidden(value) {
          publish({ hidden: value });
        },
        /**
         * 记住这次选的验证方式，下次弹框拿它当默认值。
         * @param {string[]} list - 已按弹框顺序排好的 id。
         */
        rememberVerify(list) {
          publish({ lastVerify: [...list] });
        },
        async reset() {
          issued += 1;
          try {
            await request('/vibe-phase/reset', { session: sessionId });
            publish({
              state: null,
              error: false,
              hidden: false,
              notice: null,
              lastVerify: [...DEFAULT_VERIFY],
            });
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
     * 把验证方式 id 列成中文。
     * @param {string[]} ids - 验证方式 id。
     * @returns {string} 顿号连接的显示名。
     */
    function verifySummary(ids) {
      return ids
        .map((id) => VERIFY_CHOICES.find((item) => item.id === id)?.label ?? id)
        .join('、');
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
      if (phase === 1) return `阶段 1（计划）· 点击把 ${SKILL_COMMAND.trim()} 填进输入框`;
      if (phase === 2 && state.devMode === 'split' && state.devStep === 'a') {
        return '阶段 2a（开发·前端与设计），点击进入 2b';
      }
      if (phase === 2 && state.devMode === 'split' && state.devStep === 'b') {
        return '阶段 2b（开发·完整实现）';
      }
      if (phase === 4 && Array.isArray(state.verify) && state.verify.length > 0) {
        return `阶段 4（验证）· 已选 ${verifySummary(state.verify)}`;
      }
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
     * 唯一在本地判断的是「2a 再点开发」：它不是重复点击，而是同阶段内的推进。
     * @param {object} store - 状态源。
     * @param {object} state - 当前状态。
     * @param {number} target - 目标阶段。
     * @param {object} [options] - 弹框里选好的选项。
     */
    function onChipClick(store, state, target, options) {
      const advancingDev = target === 2 && state.devMode === 'split' && state.devStep === 'a';
      if (target === state.phase && !advancingDev && (target !== 5 || state.authorized)) return;
      void store.click(target, options);
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
/* 与输入框卡片同盒：卡片在 .uV2eYG_root（padding:0 side-clearance）里居中且
   max-width:card-max-width，所以 100% 要扣掉两侧 side-clearance、限宽用同一变量、margin auto 居中，
   左右边沿才与输入框严丝合缝（wide 与 narrow 两种断点都成立）。 */
[data-vibe-phase]{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:calc(100% - var(--dsh-composer-side-clearance,16px) * 2);max-width:var(--dsh-composer-card-max-width);margin:0 auto;min-width:0;padding:2px 0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary,#14181f)}
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
[data-vibe-phase] .vpb-notice{flex:0 0 auto;max-width:36%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
[data-vibe-phase] .vpb-close{flex:0 0 auto;border:0;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1;padding:2px 6px;border-radius:6px;cursor:pointer;opacity:.45}
[data-vibe-phase] .vpb-close:hover{opacity:1;background:color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 8%,transparent)}
[data-vibe-phase] .vpb-close[data-confirming]{opacity:1;font-size:12px;padding:3px 9px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 10%,transparent)}
@keyframes vpb-blink{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion: reduce){
[data-vibe-phase] .vpb-chip[data-state="pending"]{animation:none;font-weight:600}
[data-vibe-phase] .vpb-chip[data-state="pending"]::before{content:"";display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:currentColor;vertical-align:middle}
}
/* 加号右侧的显隐按钮：不加任何底色，只靠字色区分开合——条在不在本身就是信号，
   再给一块圆底反而像另一个按钮抢注意力。
   尺寸仍是 28×28，与加号同高地占位，鼠标好点。 */
[data-vibe-toggle]{position:relative;box-sizing:border-box;display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#adb2b8);font:inherit;font-size:10px;font-weight:600;letter-spacing:-.2px;line-height:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;opacity:1}
[data-vibe-toggle]:hover,[data-vibe-toggle][data-open]{color:var(--dsw-alias-label-primary,#f9fafb)}
[data-vibe-toggle][data-waiting]::after{content:"";position:absolute;top:0;right:0;width:7px;height:7px;box-sizing:border-box;border-radius:50%;background:var(--dsw-alias-state-business-primary,#7aaaff);animation:vpb-blink 1.2s ease-in-out infinite}
[data-vibe-phase] .vpb-step{align-self:flex-start;margin-left:2px;font-size:10px;line-height:1.2;opacity:.7}
.vpb-layer{position:fixed;inset:0;z-index:60}
.vpb-scrim{position:absolute;inset:0;background:transparent}
.vpb-panel{position:absolute;box-sizing:border-box;width:min(92vw,320px);max-height:calc(100vh - 24px);overflow-y:auto;padding:10px;border-radius:10px;background:var(--dsw-specific-input-major,#2c2c2e);color:var(--dsw-alias-label-primary,#f9fafb);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);box-shadow:0 8px 28px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:4px}
.vpb-panel-title{margin:0 0 2px;font-size:12px;font-weight:600}
.vpb-opt{display:flex;gap:8px;align-items:flex-start;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer}
.vpb-opt:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}
.vpb-opt[data-checked]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#7aaaff) 14%,transparent)}
.vpb-opt-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.vpb-opt-label{font-size:12px;line-height:1.35}
.vpb-opt-note{font-size:11px;line-height:1.35;opacity:.62}
.vpb-check{flex:0 0 auto;width:14px;height:14px;margin-top:1px;box-sizing:border-box;border-radius:4px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#14181f) 38%,transparent);position:relative}
.vpb-check[data-round]{border-radius:50%}
.vpb-check[data-on]{background:var(--dsw-alias-state-business-primary,#7aaaff);border-color:transparent}
.vpb-check[data-on]:not([data-round])::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.vpb-check[data-on][data-round]::after{content:"";position:absolute;left:3px;top:3px;width:6px;height:6px;border-radius:50%;background:#fff}
.vpb-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:4px}
/* 默认的蓝色聚焦环套在这块浅蓝底色上太重，换成同尺寸的中性描边，键盘用户照样看得见。 */
.vpb-opt:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 38%,transparent);outline-offset:-2px}
.vpb-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 38%,transparent);outline-offset:1px}
.vpb-btn{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;opacity:.78}
.vpb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}
.vpb-btn[data-primary]{background:var(--dsw-alias-state-business-primary,#7aaaff);color:#fff;opacity:1}
.vpb-btn[data-primary]:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#7aaaff) 88%,#000)}
.vpb-btn:disabled{opacity:.4;cursor:not-allowed}
.vpb-hint{margin:0;font-size:11px;line-height:1.35;opacity:.6}
`;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * 加号右侧的按钮：只做显示或隐藏，一条消息都不发。
     *
     * 没有流程时点它是「开始」——把阶段一状态建出来；有流程时点它是收起/展开条。
     * 收起之后若还有阶段在等人确认，用一个圆点提醒，但不自动展开：那样「隐藏」
     * 就成了半残的隐藏，也违反「条只由按钮和技能两种方式决定」。
     * @param {object} props - 插槽标准属性。
     * @returns {object | null} 按钮。
     */
    function BarToggle({ sessionId }) {
      const { store, snapshot } = usePhaseStore(sessionId);
      // 首次拉取还没回来先不画：否则有流程的会话会闪一下「开始」再变成「收起」。
      if (!snapshot.loaded) return null;

      const state = snapshot.state;
      const open = state !== null && !snapshot.hidden;
      const waiting = state !== null && snapshot.hidden && state.pending !== null;
      const label =
        state === null
          ? '开始 vibe coding 流程'
          : waiting
            ? '显示阶段条（有阶段在等你确认）'
            : open
              ? '隐藏阶段条'
              : '显示阶段条';

      const toggle = () => {
        if (state === null) {
          void store.open();
          return;
        }
        store.setHidden(!snapshot.hidden);
      };

      return h(
        'button',
        {
          type: 'button',
          'data-vibe-toggle': '',
          'data-open': open ? '' : undefined,
          'data-waiting': waiting ? '' : undefined,
          'aria-expanded': open,
          title: label,
          'aria-label': label,
          onClick: toggle,
        },
        h('span', { 'aria-hidden': 'true' }, '</>'),
      );
    }

    /**
     * 输入框上方的五阶段条，以及点「开发」「验证」时弹出的选项面板。
     *
     * 阶段一不是确认动作：点它只把 `/vibe-coding ` 填进输入框，并把宿主状态清回阶段一，
     * 始终不发消息。流程真正的起点是用户补完构想把这条命令发出去，模型随后调 `enter 1`。
     * @param {object} props - 插槽标准属性（会话 id 与公开的输入动作面）。
     * @returns {object | null} 阶段条。
     */
    function PhaseBar({ sessionId, inputActions, useInput }) {
      const { store, snapshot } = usePhaseStore(sessionId);
      // 订阅草稿：点「计划」时要把已有内容挪到命令后面当构想，所以这里不能只在点击时读。
      // useInput 是会话级槽位的必备属性；万一宿主没给就记成 null，点「计划」时什么都不做——
      // 把它当成空草稿，会把用户已经写好、只是没读到的内容整段覆盖掉。
      const draft =
        typeof useInput === 'function'
          ? useInput((value) => (value == null ? '' : value.draft))
          : null;
      const [confirming, setConfirming] = React.useState(false);
      // 面板是纯本地状态：开着不代表宿主变了，取消就等于什么都没发生。
      const [dialog, setDialog] = React.useState(null);
      const [devSplit, setDevSplit] = React.useState(false);
      const [verifyChoice, setVerifyChoice] = React.useState(() => [...snapshot.lastVerify]);
      const [anchor, setAnchor] = React.useState(null);
      const barRef = React.useRef(null);
      const panelRef = React.useRef(null);
      // 关掉面板之后焦点要回到刚点的那个 chip，否则焦点会掉到 body 上。
      const chipRef = React.useRef(null);
      const focusedRef = React.useRef(false);

      React.useEffect(() => {
        if (!confirming) return undefined;
        // 二次确认只等一次点击；四秒没动就收回，免得下一眼还停在「关闭？」上。
        const timer = window.setTimeout(() => setConfirming(false), 4000);
        return () => window.clearTimeout(timer);
      }, [confirming]);

      const closeDialog = () => {
        setDialog(null);
        const chip = chipRef.current;
        if (chip !== null) chip.focus({ preventScroll: true });
      };

      // 面板贴着条的上沿：位置取自条的实际矩形，窗口缩放或条换行都不会跑偏。
      React.useLayoutEffect(() => {
        if (dialog === null) return undefined;
        const measure = () => {
          const bar = barRef.current;
          if (bar === null) return;
          const rect = bar.getBoundingClientRect();
          const panel = panelRef.current;
          const height = panel === null ? 0 : panel.offsetHeight;
          const bottom = window.innerHeight - rect.top + 8;
          // 条上方的空间比面板还矮时（横屏手机、很矮的窗口）往上顶，别让标题跑到视口外。
          const maxBottom = Math.max(8, window.innerHeight - height - 8);
          setAnchor({ left: rect.left, bottom: Math.min(bottom, maxBottom) });
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, [dialog]);

      React.useEffect(() => {
        if (dialog === null) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          closeDialog();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [dialog]);

      // 面板首次可见时把焦点送进去。锚点没算出来之前面板是 visibility:hidden，
      // 那时 focus() 不会生效，所以要等 anchor 落地——但只送一次，别在缩放时抢焦点。
      React.useLayoutEffect(() => {
        if (dialog === null) {
          focusedRef.current = false;
          return;
        }
        if (anchor === null || focusedRef.current) return;
        focusedRef.current = true;
        const panel = panelRef.current;
        const first = panel === null ? null : panel.querySelector('[data-vpb-option]');
        if (first !== null) first.focus({ preventScroll: true });
      }, [dialog, anchor]);

      // 条被收起时把面板一并关掉——否则再展开时上一次的选项面板会自己回来。
      React.useEffect(() => {
        if (snapshot.hidden && dialog !== null) setDialog(null);
      }, [snapshot.hidden, dialog]);

      const state = snapshot.state;
      if (!snapshot.loaded || state === null || snapshot.hidden) return null;

      const close = () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        void store.reset();
      };

      const toggleVerify = (id) => {
        setVerifyChoice((current) =>
          VERIFY_CHOICES.filter((item) =>
            item.id === id ? !current.includes(id) : current.includes(item.id),
          ).map((item) => item.id),
        );
      };

      /**
       * 把 `/vibe-coding ` 填进输入框，一条消息都不发、也不碰阶段状态。
       *
       * 草稿为空时只放这条命令；已有文字时把命令放到最前面，原内容顺延成「初步构想」。
       * 已经以这条命令开头就不动，免得连点两次叠出两行。
       * 读不到草稿时（宿主没给 useInput）宁可什么都不做：当成空草稿会覆盖用户已写的内容。
       */
      const seedSkillCommand = () => {
        if (inputActions === undefined || draft === null) return;
        const text = draft;
        if (text.trimStart().startsWith(SKILL_COMMAND.trimEnd())) return;
        inputActions.setDraft(text.trim() === '' ? SKILL_COMMAND : `${SKILL_COMMAND}${text}`);
      };

      const submitDev = () => {
        closeDialog();
        onChipClick(store, state, 2, { devSplit });
      };

      const submitVerify = () => {
        if (verifyChoice.length === 0) return;
        store.rememberVerify(verifyChoice);
        closeDialog();
        onChipClick(store, state, 4, { verify: verifyChoice });
      };

      const onChip = (event, item) => {
        chipRef.current = event.currentTarget;
        if (dialog !== null) return;
        // 阶段一只负责把技能命令填进输入框：发不发消息由用户按发送键决定。
        // 同时把宿主状态清回阶段一（fresh，同样不发消息）——否则上一轮的验证方式会挂在
        // 阶段四的悬停说明上，模型挂起的 pending 也会一直闪。重置失败不影响填命令。
        if (item.n === 1) {
          void store.open(true);
          seedSkillCommand();
          return;
        }
        // 只有「答案不止一个」的两处拦下来问，其余点击照旧直接确认。
        if (item.n === 2 && state.phase < 2) {
          setDevSplit(false);
          setDialog('dev');
          return;
        }
        if (item.n === 4 && state.phase < 4) {
          setVerifyChoice(
            snapshot.lastVerify.length > 0 ? [...snapshot.lastVerify] : [...DEFAULT_VERIFY],
          );
          setDialog('verify');
          return;
        }
        onChipClick(store, state, item.n);
      };

      const chips = PHASES.map((item) => {
        const step = item.n === 2 && state.devMode === 'split' ? state.devStep : null;
        return h(
          'button',
          {
            key: item.n,
            type: 'button',
            className: 'vpb-chip',
            'data-state': chipState(item.n, state),
            'data-substate': item.n === 5 ? commitSubstate(state) : undefined,
            // 这几格是「点了就确认这一阶段」的动作按钮，不是 tab 页签：
            // 用 aria-current 标当前阶段即可，套 tab 语义反而要求方向键与 tabpanel。
            'aria-current': item.n === state.phase ? 'step' : undefined,
            'aria-label':
              item.n === 1
                ? `${item.n} ${item.label}（点击把 ${SKILL_COMMAND.trim()} 填入输入框）`
                : step === null
                  ? `${item.n} ${item.label}`
                  : `${item.n} ${item.label} 2${step}`,
            title: chipTitle(item.n, state),
            onClick: (event) => onChip(event, item),
          },
          item.label,
          step === null ? null : h('span', { className: 'vpb-step', 'aria-hidden': 'true' }, `2${step}`),
        );
      });

      const dialogTitle = dialog === 'dev' ? '阶段 2 怎么开发' : '阶段 4 跑哪些验证';
      const devOptions = [
        { split: false, label: '一次性完成', note: '按确认后的计划一口气做完，中间不停' },
        { split: true, label: '分两步', note: '先 2a 只做界面与演示数据，看完设计再进 2b 完整实现' },
      ];

      const option = (key, checked, onClick, label, note, round) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'vpb-opt',
            'data-vpb-option': '',
            'data-checked': checked ? '' : undefined,
            role: round ? 'radio' : 'checkbox',
            'aria-checked': checked,
            onClick,
          },
          h('span', {
            className: 'vpb-check',
            'data-round': round ? '' : undefined,
            'data-on': checked ? '' : undefined,
          }),
          h(
            'span',
            { className: 'vpb-opt-body' },
            h('span', { className: 'vpb-opt-label' }, label),
            note === '' ? null : h('span', { className: 'vpb-opt-note' }, note),
          ),
        );

      const panel =
        dialog === 'dev'
          ? [
              h('p', { key: 'title', className: 'vpb-panel-title' }, dialogTitle),
              ...devOptions.map((item) =>
                option(
                  String(item.split),
                  devSplit === item.split,
                  () => setDevSplit(item.split),
                  item.label,
                  item.note,
                  true,
                ),
              ),
              h(
                'div',
                { key: 'actions', className: 'vpb-actions' },
                h('button', { type: 'button', className: 'vpb-btn', onClick: closeDialog }, '取消'),
                h(
                  'button',
                  { type: 'button', className: 'vpb-btn', 'data-primary': '', onClick: submitDev },
                  '进入',
                ),
              ),
            ]
          : [
              h('p', { key: 'title', className: 'vpb-panel-title' }, dialogTitle),
              ...VERIFY_CHOICES.map((item) =>
                option(
                  item.id,
                  verifyChoice.includes(item.id),
                  () => toggleVerify(item.id),
                  item.label,
                  item.note,
                  false,
                ),
              ),
              h('p', { key: 'hint', className: 'vpb-hint' }, verifyChoice.length === 0 ? '至少选一种验证方式' : ''),
              h(
                'div',
                { key: 'actions', className: 'vpb-actions' },
                h('button', { type: 'button', className: 'vpb-btn', onClick: closeDialog }, '取消'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'vpb-btn',
                    'data-primary': '',
                    disabled: verifyChoice.length === 0,
                    onClick: submitVerify,
                  },
                  '进入',
                ),
              ),
            ];

      return h(
        'div',
        {
          ref: barRef,
          'data-vibe-phase': '',
          role: 'group',
          'aria-label': 'vibe coding 阶段',
        },
        h('div', { className: 'vpb-track' }, chips),
        // 容器常驻、只换文字：live region 必须先在 DOM 里，后填入内容才会被播报。
        h(
          'span',
          { className: 'vpb-sr', role: 'status' },
          state.pending !== null
            ? `等待确认进入阶段 ${state.pending}（${PHASES[state.pending - 1].label}）`
            : '',
        ),
        snapshot.error ? h('span', { className: 'vpb-error', role: 'status' }, '状态未同步') : null,
        snapshot.notice === null
          ? null
          : h('span', { className: 'vpb-notice', role: 'status' }, snapshot.notice),
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
        dialog === null
          ? null
          : h(
              'div',
              { className: 'vpb-layer' },
              h('div', { className: 'vpb-scrim', onClick: closeDialog }),
              h(
                'div',
                {
                  ref: panelRef,
                  className: 'vpb-panel',
                  role: 'dialog',
                  'aria-label': dialogTitle,
                  style:
                    anchor === null
                      ? { visibility: 'hidden' }
                      : {
                          left: `${Math.max(8, Math.min(anchor.left, window.innerWidth - 328))}px`,
                          bottom: `${anchor.bottom}px`,
                        },
                },
                panel,
              ),
            ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ensureStyle(), 'vibe-phase-bar: styles');
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'vibe-phase-toggle', order: 60 },
            BarToggle,
          ),
        );
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'vibe-phase', order: 40 }, PhaseBar),
        );
      },
    };
  },
});
