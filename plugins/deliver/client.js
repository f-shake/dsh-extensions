window.__ModuleLoader__.load({
  id: '@local/deliver',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 工具名。工具视图按这个名字派发，写错就永远不渲染。 */
    const TOOL_NAME = 'deliver';
    /** 侧栏标签页的类型标识；同时也是正文注册用的 key。 */
    const PLUGIN_ID = '@local/deliver';
    const KIND = 'deliver-box';
    const LIST_URL = '/deliver/list';
    const STYLE_ID = 'deliver-plugin';

    /**
     * 剩余有效期。宿主那边的时间与浏览器可能差几秒，这里只做粗粒度展示，
     * 真值以服务端响应为准（点下载会先 HEAD 一次）。
     * @param {number} expiresAt - 到期时间戳。
     * @param {number} now - 当前时间戳。
     * @returns {string} 展示文案。
     */
    function remainingText(expiresAt, now) {
      const remain = Number(expiresAt) - Number(now);
      if (!Number.isFinite(remain) || remain <= 0) return '已失效';
      const minutes = Math.floor(remain / 60_000);
      if (minutes < 60) return `还有 ${Math.max(1, minutes)} 分钟`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `还有 ${hours} 小时`;
      return `还有 ${Math.floor(hours / 24)} 天`;
    }

    /**
     * 工具失败时把结果正文压成一行，给工具行当错误说明。
     * @param {object} block - 工具结果节点。
     * @returns {string} 说明文字。
     */
    function errorText(block) {
      const content = block !== null && typeof block === 'object' && Array.isArray(block.content)
        ? block.content
        : [];
      const text = content
        .map((item) => (item !== null && typeof item === 'object' && item.type === 'text' ? item.text : ''))
        .filter((item) => typeof item === 'string' && item !== '')
        .join('\n')
        .trim();
      return text === '' ? '投递失败' : text.slice(0, 300);
    }

    /**
     * 从工具结果的 meta 里读出投递信息。格式不对就返回 null，让工具行什么都不画，
     * 不要因为一条老记录把视图弄崩。
     * @param {object} block - 工具结果节点。
     * @returns {{ deliveryId: string, sessionId: string, expiresAt: number, files: object[] } | null} 投递信息。
     */
    function readMeta(block) {
      const meta = block !== null && typeof block === 'object' ? block.meta : undefined;
      if (meta === null || typeof meta !== 'object') return null;
      if (typeof meta.deliveryId !== 'string' || meta.deliveryId === '') return null;
      if (!Array.isArray(meta.files) || meta.files.length === 0) return null;
      const files = [];
      for (const item of meta.files) {
        if (item === null || typeof item !== 'object') return null;
        if (typeof item.name !== 'string' || typeof item.url !== 'string') return null;
        files.push({
          index: typeof item.index === 'number' ? item.index : files.length,
          name: item.name,
          sizeText: typeof item.sizeText === 'string' ? item.sizeText : '',
          url: item.url,
          // 老记录没有绝对路径：预览按钮据此不发明地址，下载不受影响。
          absPath: typeof item.absPath === 'string' ? item.absPath : '',
        });
      }
      return {
        deliveryId: meta.deliveryId,
        sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
        expiresAt: typeof meta.expiresAt === 'number' ? meta.expiresAt : 0,
        files,
      };
    }

    /** 活着投递 id 的短缓存：历史回合的工具行会同时挂载，逐个去问就是几十个请求。 */
    let liveIds = { at: 0, promise: null };
    /** 正在飞的请求：同一批挂载共用一次，强制重拉也不例外。 */
    let liveIdsInflight = null;

    /**
     * 宿主内存里还活着哪些投递。
     *
     * 连宿主的 `now` 一起带回来：判断「缺这条」是不是权威的，要靠它和工具结果的
     * 时间比一比，而不是靠节流拍脑袋。
     * @param {boolean} [force] - 忽略几秒内的缓存重拉一次。
     * @returns {Promise<{ ids: Set<string>, now: number } | null>} 投递 id 集合与宿主时间；拉不到给 null。
     */
    function liveDeliveryIds(force = false) {
      if (liveIdsInflight !== null) return liveIdsInflight;
      const now = Date.now();
      if (!force && liveIds.promise !== null && now - liveIds.at < 5_000) return liveIds.promise;

      const request = fetch(LIST_URL, { credentials: 'same-origin' })
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          return response.json();
        })
        .then((payload) => {
          const items =
            payload !== null && typeof payload === 'object' && Array.isArray(payload.deliveries)
              ? payload.deliveries
              : [];
          const served = payload !== null && typeof payload === 'object' ? Number(payload.now) : Number.NaN;
          return { ids: new Set(items.map((item) => item.id)), now: served };
        })
        .catch(() => null);
      liveIds = { at: now, promise: request };
      liveIdsInflight = request;
      request.then(() => {
        if (liveIdsInflight === request) liveIdsInflight = null;
      });
      return request;
    }

    /** 这一页里被撤销过的投递 id：在途的活性检查晚回来时，不能把撤销翻回去。 */
    const revokedIds = new Set();

    /**
     * 这条投递还在不在宿主内存里。
     *
     * 列表里没有它时分两种情况：列表是**这条结果之后**生成的（宿主时间 `now` 晚于
     * 结果的 `time`），缺就是真缺；否则缓存可能比这条投递还旧，必须强制重拉一次再判。
     * 用时间判而不是按秒数节流，是因为节流会把刚投的第二条也判成失效，和回合末尾
     * 那组条上下打架。
     * 每个 await 之后都要再看一眼撤销集合：撤销事件可能发生在请求还在飞的时候，
     * 那时旧请求的答案已经不作数了。
     * @param {string} deliveryId - 投递 id。
     * @param {number} [resultTime] - 工具结果的时间戳（宿主时钟）。
     * @returns {Promise<boolean>} 在（或无法判断）为 true。
     */
    async function deliveryIsLive(deliveryId, resultTime) {
      if (revokedIds.has(deliveryId)) return false;
      const cached = await liveDeliveryIds();
      if (revokedIds.has(deliveryId)) return false;
      if (cached === null) return true;
      if (cached.ids.has(deliveryId)) return true;
      if (Number.isFinite(resultTime) && Number.isFinite(cached.now) && cached.now >= resultTime) return false;
      const fresh = await liveDeliveryIds(true);
      if (revokedIds.has(deliveryId)) return false;
      return fresh === null ? true : fresh.ids.has(deliveryId);
    }

    /**
     * 工具行：活着的投递什么都不画，另外两种情况下它得出声。
     *
     * - 失败：一个文件都没投成，正文里没有条可看，错误得留在原处。
     * - 已失效：宿主重启、记录过期或被撤销后，投递表里已经没有这条，回合末尾那组条
     *   也就画不出来。这时退回工具结果里存着的 meta，画成同样的一行行、标「已失效」，
     *   免得历史回合里这一轮交付彻底消失（原来的整张卡片就是这么活下来的）。
     *
     * 组件本身由宿主按工具名派发；这里返回 null 也不会退回通用卡片。
     * @param {{ phase?: string, block?: object }} props - 工具视图属性。
     * @returns {object | null} 元素。
     */
    function ToolRow(props) {
      const block = props.phase === 'result' ? props.block : null;
      const meta = block === null ? null : readMeta(block);
      const deliveryId = meta === null ? '' : meta.deliveryId;
      const [live, setLive] = React.useState(true);

      React.useEffect(() => {
        if (deliveryId === '') return undefined;
        let alive = true;
        deliveryIsLive(deliveryId, block.time).then((value) => {
          if (alive) setLive(value);
        });
        return () => {
          alive = false;
        };
      }, [deliveryId]);

      // 同一页里撤销：事件比缓存快，直接把自己这条判死，别等下一次页面加载。
      React.useEffect(() => {
        if (deliveryId === '' || typeof window?.addEventListener !== 'function') return undefined;
        const onRevoked = (event) => {
          const revoked = event?.detail?.deliveryId;
          if (typeof revoked === 'string' && revoked !== deliveryId) return;
          setLive(false);
        };
        window.addEventListener(REVOKED_EVENT, onRevoked);
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener(REVOKED_EVENT, onRevoked);
        };
      }, [deliveryId]);

      if (block === null) return null;
      if (block.isError === true) {
        return h('div', { 'data-deliver': '', className: 'dlv-err' }, errorText(block));
      }
      if (meta === null || live) return null;

      return h(
        'div',
        { 'data-deliver': '', className: 'dlv-tail' },
        meta.files.map((file) =>
          h(
            'div',
            { className: 'dlv-bar', key: String(file.index) },
            h('span', { className: 'dlv-bar-name', title: file.name }, file.name),
            h('span', { className: 'dlv-bar-meta' }, file.sizeText),
            h('span', { className: 'dlv-bar-dead' }, '已失效'),
          ),
        ),
      );
    }

    /**
     * 一个回合里创建的那些投递。
     *
     * 回合末尾那组条只能拿到回合的开始 / 结束时间（`turn.start.time`、`turn.end.time`），
     * 投递记录里带的是 `createdAt`——两边对一下就能筛出「本回合投的」，不用让宿主
     * 额外记回合号。
     * @param {object[]} deliveries - `/deliver/list` 的条目。
     * @param {{ start?: unknown, end?: unknown } | null} [window] - 回合时间窗。
     * @returns {object[]} 落在窗内、且有文件的投递，保持宿主给的顺序。
     */
    function deliveriesInTurn(deliveries, window) {
      const start = Number(window?.start);
      if (!Number.isFinite(start)) return [];
      const rawEnd = Number(window?.end);
      const end = Number.isFinite(rawEnd) ? rawEnd : Number.POSITIVE_INFINITY;
      return (Array.isArray(deliveries) ? deliveries : []).filter((item) => {
        if (item === null || typeof item !== 'object') return false;
        const created = Number(item.createdAt);
        if (!Number.isFinite(created) || created < start || created > end) return false;
        return Array.isArray(item.files) && item.files.length > 0;
      });
    }

    /**
     * 侧栏撤销成功后广播的事件名：正文里的回合条据此重拉一次。
     *
     * 投递箱在右侧栏、回合条在正文，两边各拉各的列表却指向同一份数据；撤销后不通知，
     * 正文会继续显示「还有 X 小时」和一个点下去才报「已失效」的按钮。
     */
    const REVOKED_EVENT = 'deliver:revoked';

    /** 通知正文：某条投递刚被撤销。宿主环境里 window 一直在，测试替身可能没有事件接口。 */
    function notifyRevoked(deliveryId) {
      // 记下它：撤销前发出的活性检查可能还在飞，答案回来时不能把它判回「活着」。
      if (typeof deliveryId === 'string' && deliveryId !== '') revokedIds.add(deliveryId);
      // 缓存里还留着这条：清掉，重新挂载的工具行才会重新问一次。
      liveIds = { at: 0, promise: null };
      liveIdsInflight = null;
      if (typeof window?.dispatchEvent !== 'function') return;
      if (typeof window.CustomEvent !== 'function') return;
      window.dispatchEvent(new window.CustomEvent(REVOKED_EVENT, { detail: { deliveryId } }));
    }

    /**
     * 拉一次投递列表，筛出落在回合窗内的那些。
     * @param {{ start: number, end?: number, sessionId?: string }} window - 回合窗与会话。
     * @returns {Promise<object[]>} 投递条目；请求失败给空数组，正文里不留半截错误。
     */
    async function loadTurnDeliveries({ start, end, sessionId }) {
      const query =
        typeof sessionId === 'string' && sessionId !== '' ? `?session=${encodeURIComponent(sessionId)}` : '';
      try {
        const response = await fetch(`${LIST_URL}${query}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json();
        const items =
          payload !== null && typeof payload === 'object' && Array.isArray(payload.deliveries)
            ? payload.deliveries
            : [];
        return deliveriesInTurn(items, { start, end });
      } catch {
        return [];
      }
    }

    /**
     * 文件类型色块上的短标签。
     * @param {string} name - 文件名。
     * @returns {string} 最多四个字符的大写扩展名；没有扩展名时返回 FILE。
     */
    function fileExt(name) {
      const text = typeof name === 'string' ? name : '';
      const dot = text.lastIndexOf('.');
      if (dot <= 0 || dot === text.length - 1) return 'FILE';
      const ext = text.slice(dot + 1).toUpperCase();
      return ext.length > 4 ? ext.slice(0, 4) : ext;
    }

    /** 常见类型对应的色块底色；其余走中性灰。白字 10px，全部按 ≥4.5:1 挑过。 */
    const TILE_TONES = {
      md: '#3b6fd4',
      txt: '#4a4a52',
      log: '#4a4a52',
      pdf: '#c0392b',
      zip: '#6d3fd0',
      apk: '#1f7a52',
      png: '#1f7a52',
      jpg: '#1f7a52',
      jpeg: '#1f7a52',
      gif: '#1f7a52',
      webp: '#1f7a52',
      json: '#8a6508',
      js: '#8a6508',
      ts: '#3178c6',
      csv: '#26714b',
      xlsx: '#26714b',
      docx: '#2b579a',
      pptx: '#c05621',
      mp4: '#7b3fb5',
      mp3: '#7b3fb5',
      exe: '#5b6068',
      msi: '#5b6068',
    };

    /**
     * 色块底色。
     * @param {string} ext - `fileExt` 的结果。
     * @returns {string} 十六进制颜色。
     */
    function tileTone(ext) {
      return TILE_TONES[String(ext).toLowerCase()] ?? '#4a4a52';
    }

    /**
     * 地址里的一段：照常编码，但把盘符的冒号留着——内置预览靠 `C:` 认出绝对路径。
     * @param {string} text - 原始片段。
     * @returns {string} 编码结果。
     */
    function encodeSegment(text) {
      return encodeURIComponent(text).replace(/%3A/gi, ':');
    }

    /**
     * 内置预览认的文件地址：会话 + 宿主上的绝对路径。
     * @param {string} sessionId - 会话 id。
     * @param {string} absPath - 绝对路径（反斜杠会归一成 `/`）。
     * @returns {string} `dsh-resource://file/session/…` 地址。
     */
    function fileAddress(sessionId, absPath) {
      const path = String(absPath)
        .replace(/\\/g, '/')
        .split('/')
        .map(encodeSegment)
        .join('/');
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${path}`;
    }

    /** 注入一次样式。插件反复加载时不要重复插。 */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        // 投递箱里的文件行：左侧类型色块、名称加粗、说明灰字，右侧预览与下载。
        '.dlv-row{display:flex;align-items:center;gap:10px;min-width:0;padding:2px 0}',
        '.dlv-tile{width:34px;height:34px;border-radius:8px;flex:0 0 auto;display:grid;place-items:center;',
        'color:#fff;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px}',
        '.dlv-info{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
        '.dlv-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dlv-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '.dlv-get{display:inline-flex;align-items:center;flex:0 0 auto}',
        '.dlv-act{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto}',
        '.dlv-btn{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:8px;',
        'background:none;padding:3px 10px;cursor:pointer;font:inherit;font-size:12px;',
        'color:var(--dsw-alias-label-primary,#f9fafb)}',
        '.dlv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}',
        '.dlv-btn:disabled{cursor:default;opacity:.5}',
        '.dlv-flag{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-right:6px}',
        // 不能 display:none：读屏对「从隐藏变可见」的区域经常不播报，保留占位更稳。
        '.dlv-flag:empty{margin-right:0}',
        // 工具行的失败提示：没有投递成功时正文里没有条，这句是唯一的反馈。
        '.dlv-err{margin:0;white-space:pre-wrap;word-break:break-word;',
        'color:var(--dsw-alias-state-error-primary,#e05b5b);font-size:11px}',
        '.dlv-link{border:0;background:none;padding:0;cursor:pointer;font:inherit;font-size:11px;',
        'color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '.dlv-link:hover{text-decoration:underline;color:var(--dsw-alias-label-primary,#f9fafb)}',
        '.dlv-link[data-warn]{color:var(--dsw-alias-state-error-primary,#e05b5b)}',
        // 回合末尾那一组单行条：这是交付在正文里唯一的呈现，工具行不再画卡片。
        '.dlv-tail{display:flex;flex-direction:column;gap:6px;max-width:100%}',
        '.dlv-bar{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 10px;border-radius:9px;',
        'border:1px solid var(--dsw-alias-border-l2,#ffffff14);background:var(--dsw-specific-input-major,transparent)}',
        '.dlv-bar-name{flex:1 1 auto;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dlv-bar-meta{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        // 历史回合里那条投递已经不在宿主内存：条还在，只是没什么可点的。
        '.dlv-bar-dead{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '.dlv-box{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:10px;',
        'font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#f9fafb)}',
        '.dlv-box-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
        'color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}',
        '.dlv-group{display:flex;flex-direction:column;gap:2px}',
        '.dlv-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
        'color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}',
        '.dlv-empty{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;padding:8px 2px}',
      ].join('');
      document.head.appendChild(style);
    }

    /**
     * 组件工厂。组件本身只用传进来的 React，不直接碰 DOM。
     * @param {{ openPreview?: (sessionId: string, file: object) => void }} deps - 预览入口（由宿主侧注入，测试里可替换）。
     * @returns {{ DownloadBar: Function, BoxBody: Function, TurnTailCard: Function, FileRow: Function, FileTile: Function, DownloadButton: Function, PreviewButton: Function }} 组件。
     */
    function createComponents(deps = {}) {
      const openPreview = typeof deps.openPreview === 'function' ? deps.openPreview : null;

      /**
       * 预览入口：先确认这份投递还有效，再交给右侧栏内置预览。
       *
       * 内置预览直接读磁盘，绕开投递表；不先 HEAD 一次，撤销过的文件还会被打开，
       * 和下载按钮的「已失效」自相矛盾。
       * @param {{ file: object, sessionId: string }} props - 组件属性。
       * @returns {object} 元素。
       */
      function PreviewButton({ file, sessionId }) {
        const [state, setState] = React.useState('idle');
        const ref = React.useRef(null);

        // 和下载按钮同一条约束：检查期间按钮被禁用，焦点会被浏览器收走；失败后要还回来。
        React.useEffect(() => {
          if (state !== 'error' && state !== 'gone') return;
          if (ref.current === null || typeof ref.current.focus !== 'function') return;
          ref.current.focus();
        }, [state]);

        async function onPreview() {
          if (state === 'busy' || state === 'gone' || openPreview === null) return;
          if (typeof file.absPath !== 'string' || file.absPath === '') return;
          setState('busy');
          let next = 'idle';
          try {
            const response = await fetch(file.url, { method: 'HEAD', credentials: 'same-origin' });
            if (response.ok) {
              openPreview(sessionId, file);
              setState('idle');
              return;
            }
            next = response.status === 404 || response.status === 410 ? 'gone' : 'error';
          } catch {
            next = 'error';
          }
          setState(next);
        }

        const flag = state === 'gone' ? '已失效' : state === 'error' ? '打不开' : '';

        return h(
          'span',
          { className: 'dlv-get' },
          h('span', { className: 'dlv-flag', role: 'status', 'aria-live': 'polite' }, flag),
          h(
            'button',
            {
              type: 'button',
              className: 'dlv-btn',
              ref,
              title: state === 'gone' ? '链接已失效（过期、撤销，或 dsh 重启过）' : '在右侧栏预览',
              'aria-busy': state === 'busy' ? 'true' : undefined,
              // 与下载按钮一致：只在检查期间禁用；失效态用 aria-disabled 保留可聚焦。
              'aria-disabled': state === 'gone' ? 'true' : undefined,
              disabled: state === 'busy',
              onClick: onPreview,
            },
            '预览',
          ),
        );
      }

      /**
       * 下载入口：先 HEAD 一次确认还能下，再整页导航。
       *
       * 为什么不用 window.open：WebView 里新窗口会被拦；整页导航会命中
       * content-disposition，桌面浏览器停在原页面，Android 会转给下载管理器。
       *
       * 按钮文字始终是「下载」，点击不换字（用户明确要求）；失败信息放在按钮旁边的
       * 小字里，既不打断节奏，也不会让按钮变样。
       * @param {{ url: string }} props - 组件属性。
       * @returns {object} 元素。
       */
      function DownloadButton({ url }) {
        const [state, setState] = React.useState('idle');
        const ref = React.useRef(null);

        // 聚焦必须等这一轮渲染落地：setState 是异步的，紧跟着同步调 focus() 时按钮
        // 还是 disabled，浏览器会直接忽略这次聚焦。失效态也要收焦点——检查期间焦点
        // 已经被禁用收走了，不还回来就只能重新 Tab 找按钮。
        React.useEffect(() => {
          if (state !== 'error' && state !== 'gone') return;
          if (ref.current === null || typeof ref.current.focus !== 'function') return;
          ref.current.focus();
        }, [state]);

        async function onDownload() {
          if (state === 'busy' || state === 'gone') return;
          setState('busy');
          let next = 'idle';
          try {
            const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
            if (response.ok) {
              window.location.assign(url);
              setState('idle');
              return;
            }
            next = response.status === 404 || response.status === 410 ? 'gone' : 'error';
          } catch {
            next = 'error';
          }
          setState(next);
        }

        const flag = state === 'gone' ? '已失效' : state === 'error' ? '打不开' : '';

        return h(
          'span',
          { className: 'dlv-get' },
          // 常驻的 live region：内容从空变成文字时才会被读屏播报，按钮文字保持不变。
          h('span', { className: 'dlv-flag', role: 'status', 'aria-live': 'polite' }, flag),
          h(
            'button',
            {
              type: 'button',
              className: 'dlv-btn',
              ref,
              title: state === 'gone' ? '链接已失效（过期、撤销，或 dsh 重启过）' : '下载到本机',
              'aria-busy': state === 'busy' ? 'true' : undefined,
              // 只在检查期间禁用。失效态用 aria-disabled：既保留可聚焦（焦点要还回来），
              // 又让读屏知道这个按钮按了也没用。
              'aria-disabled': state === 'gone' ? 'true' : undefined,
              disabled: state === 'busy',
              onClick: onDownload,
            },
            '下载',
          ),
        );
      }

      /**
       * 文件类型色块：扩展名首字母写在带色的圆角方块里，和内置交付卡片的观感一致。
       * @param {{ ext: string }} props - 扩展名标签。
       * @returns {object} 元素。
       */
      function FileTile({ ext }) {
        return h(
          'div',
          { className: 'dlv-tile', style: { background: tileTone(ext) } },
          ext,
        );
      }

      /**
       * 一行文件：色块、名称、灰色说明、右侧预览与下载。
       * @param {{ file: object, extra?: string, disabled?: boolean, sessionId?: string }} props - 文件与附加说明。
       * @returns {object} 元素。
       */
      function FileRow({ file, extra, disabled, sessionId }) {
        const ext = fileExt(file.name);
        return h(
          'div',
          { className: 'dlv-row' },
          h(FileTile, { ext }),
          h(
            'div',
            { className: 'dlv-info' },
            h('div', { className: 'dlv-name', title: file.name }, file.name),
            h(
              'div',
              { className: 'dlv-meta' },
              extra === undefined || extra === '' ? file.sizeText : `${file.sizeText} · ${extra}`,
            ),
          ),
          disabled === true
            ? null
            : h(
                'span',
                { className: 'dlv-act' },
                // 老记录没有绝对路径、或拿不到会话时，预览按钮不出现——按了也没用。
                // 会话 id 是可选属性，判空必须按类型，`undefined !== ''` 会把它放行。
                typeof file.absPath === 'string' && file.absPath !== '' && typeof sessionId === 'string' && sessionId !== ''
                  ? h(PreviewButton, { file, sessionId })
                  : null,
                h(DownloadButton, { url: file.url }),
              ),
        );
      }

      /**
       * 回合末尾的单行条：这是交付在正文里唯一的呈现。
       *
       * 一行里给全「文件名 + 大小 + 剩余有效期 + 预览 + 下载」，不再画类型色块与卡片外框；
       * 投递箱里另有带色块的完整行。预览按钮只在拿到会话 id 与绝对路径时出现——老记录
       * 缺这两样，按了也打不开，索性不给。
       * @param {{ file: object, sessionId?: string, extra?: string }} props - 文件、所属会话与附加说明。
       * @returns {object} 元素。
       */
      function DownloadBar({ file, sessionId, extra }) {
        const canPreview =
          typeof file.absPath === 'string' &&
          file.absPath !== '' &&
          typeof sessionId === 'string' &&
          sessionId !== '';
        return h(
          'div',
          { className: 'dlv-bar' },
          h('span', { className: 'dlv-bar-name', title: file.name }, file.name),
          h(
            'span',
            { className: 'dlv-bar-meta' },
            extra === undefined || extra === '' ? file.sizeText : `${file.sizeText} · ${extra}`,
          ),
          h(
            'span',
            { className: 'dlv-act' },
            canPreview ? h(PreviewButton, { file, sessionId }) : null,
            h(DownloadButton, { url: file.url }),
          ),
        );
      }

      /**
       * 右侧栏的投递箱。
       * @returns {object} 元素。
       */
      function BoxBody() {
        const [tick, setTick] = React.useState(0);
        // offset 是「宿主时钟 − 浏览器时钟」：剩余有效期按宿主的判定显示，
        // 免得浏览器时间不准时，一边说「还有 3 小时」一边下载被 410 拒掉。
        const [state, setState] = React.useState({
          status: 'loading',
          items: [],
          error: null,
          offset: 0,
        });

        React.useEffect(() => {
          let alive = true;
          setState((prev) => ({ ...prev, status: 'loading', error: null }));
          fetch(LIST_URL, { credentials: 'same-origin' })
            .then((response) => {
              if (!response.ok) throw new Error(String(response.status));
              return response.json();
            })
            .then((payload) => {
              if (!alive) return;
              const items = payload !== null && typeof payload === 'object' && Array.isArray(payload.deliveries)
                ? payload.deliveries
                : [];
              const served = payload !== null && typeof payload === 'object' ? Number(payload.now) : Number.NaN;
              const offset = Number.isFinite(served) ? served - Date.now() : 0;
              setState({ status: 'ready', items, error: null, offset });
            })
            .catch(() => {
              if (alive) setState((prev) => ({ ...prev, status: 'error', items: [], error: '列表加载失败' }));
            });
          return () => {
            alive = false;
          };
        }, [tick]);

        const [revoking, setRevoking] = React.useState(null);

        async function onRevoke(id) {
          if (revoking === id) return;
          setRevoking(id);
          try {
            const response = await fetch(`/deliver/${encodeURIComponent(id)}`, {
              method: 'DELETE',
              credentials: 'same-origin',
            });
            if (response.ok) notifyRevoked(id);
          } catch {
            // 失败也要刷新：列表会如实显示它还在。
          }
          setRevoking(null);
          setTick((value) => value + 1);
        }

        const now = Date.now() + state.offset;
        const rows = [];

        for (const delivery of state.items) {
          const files = Array.isArray(delivery.files) ? delivery.files : [];
          if (files.length === 0) continue;
          rows.push(
            h(
              'div',
              { className: 'dlv-group', key: delivery.id },
              h(
                'div',
                { className: 'dlv-group-head' },
                h(
                  'span',
                  null,
                  `${files.length} 个文件 · ${remainingText(delivery.expiresAt, now)}`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dlv-link',
                    'data-warn': '',
                    disabled: revoking === delivery.id,
                    onClick: () => onRevoke(delivery.id),
                  },
                  revoking === delivery.id ? '撤销中' : '撤销',
                ),
              ),
              files.map((file) =>
                h(FileRow, { key: `${delivery.id}-${file.index}`, file, sessionId: delivery.sessionId }),
              ),
            ),
          );
        }

        let body;
        if (state.status === 'error') {
          body = h('div', { className: 'dlv-empty' }, state.error ?? '列表加载失败');
        } else if (rows.length === 0) {
          body = h(
            'div',
            { className: 'dlv-empty' },
            state.status === 'loading' ? '正在加载…' : '还没有投递。文件生成后让它交付一次，就会出现在这里。',
          );
        } else {
          body = rows;
        }

        return h(
          'div',
          { 'data-deliver': '', className: 'dlv-box' },
          h(
            'div',
            { className: 'dlv-box-head' },
            h('span', null, state.status === 'loading' ? '正在加载…' : `最近投递 · ${rows.length} 条`),
            h(
              'button',
              { type: 'button', className: 'dlv-link', onClick: () => setTick((value) => value + 1) },
              '刷新',
            ),
          ),
          body,
        );
      }

      /**
       * 回合末尾那一组投递条：交付在正文里唯一的呈现。
       *
       * 这个槽位只对**已结束**的回合存在（`turn-tail` 节点由 `turn/end` 建出来），
       * 所以这里拉的必然是一次定稿，没有「回合进行中先画一版」这种可能。
       * 侧栏撤销后重拉一次，免得正文比投递箱晚一步。
       * 列表按会话过滤，两个会话的回合时间重叠时不会互相串。
       * @param {{ turn?: { start?: { time?: number }, end?: { time?: number } }, sessionId?: string }} props - 回合末尾槽位的属性。
       * @returns {object | null} 元素。
       */
      function TurnTailCard(props) {
        const start = Number(props.turn?.start?.time);
        const end = Number(props.turn?.end?.time);
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        const [deliveries, setDeliveries] = React.useState([]);
        const [tick, setTick] = React.useState(0);

        React.useEffect(() => {
          if (!Number.isFinite(start)) return undefined;
          let alive = true;
          loadTurnDeliveries({ start, end, sessionId }).then((items) => {
            if (alive) setDeliveries(items);
          });
          return () => {
            alive = false;
          };
        }, [start, end, sessionId, tick]);

        // 撤销发生在右侧栏，正文收不到任何数据变化；靠这条事件把自己拉回一致。
        React.useEffect(() => {
          if (typeof window?.addEventListener !== 'function') return undefined;
          const onRevoked = () => setTick((value) => value + 1);
          window.addEventListener(REVOKED_EVENT, onRevoked);
          return () => {
            if (typeof window.removeEventListener === 'function') window.removeEventListener(REVOKED_EVENT, onRevoked);
          };
        }, []);

        if (deliveries.length === 0) return null;

        const rows = [];
        const now = Date.now();
        for (const delivery of deliveries) {
          const files = Array.isArray(delivery.files) ? delivery.files : [];
          for (const file of files) {
            rows.push(
              h(DownloadBar, {
                key: `${delivery.id}-${file.index}`,
                file,
                sessionId: delivery.sessionId,
                extra: remainingText(delivery.expiresAt, now),
              }),
            );
          }
        }

        return h(
          'div',
          { 'data-deliver': '', className: 'dlv-tail' },
          rows,
        );
      }

      return { DownloadBar, BoxBody, TurnTailCard, FileRow, FileTile, DownloadButton, PreviewButton };
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ensureStyle(), 'deliver: styles');

        const components = createComponents({
          /**
           * 把文件交给右侧栏的内置预览：地址带上会话与绝对路径。
           * @param {string} sessionId - 会话 id。
           * @param {{ absPath?: string }} file - 投递的文件。
           */
          openPreview(sessionId, file) {
            if (typeof file?.absPath !== 'string' || file.absPath === '') return;
            // 会话 id 只能是字符串：拼进地址前再挡一次，别把 undefined 编码成字面量。
            if (typeof sessionId !== 'string' || sessionId === '') return;
            ctx.sidebarRight.openResource(fileAddress(sessionId, file.absPath));
          },
        });

        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: TOOL_NAME },
            ToolRow,
          ),
        );

        // 回合末尾那一组：与内置「交付」卡片同一个槽位，是活着的投递在正文里的呈现。
        // 记录已经不在宿主内存时（重启、过期、撤销），工具行会退回 meta 自己画一组「已失效」。
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: `${PLUGIN_ID}/tail`,
              order: 40,
            },
            components.TurnTailCard,
          ),
        );

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: PLUGIN_ID,
              kind: KIND,
              priority: 'extension',
              title: () => '投递',
              guide: [
                {
                  id: 'deliver-box',
                  order: 60,
                  title: () => '投递',
                  description: () => '最近交付的文件，点一下就能下载',
                },
              ],
            }),
          'deliver: tab type',
        );

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: PLUGIN_ID },
            components.BoxBody,
          ),
        );
      },
      /** 只给单测用：纯函数与组件工厂。 */
      __test: {
        remainingText,
        errorText,
        readMeta,
        deliveryIsLive,
        ToolRow,
        notifyRevoked,
        deliveriesInTurn,
        loadTurnDeliveries,
        fileExt,
        tileTone,
        encodeSegment,
        fileAddress,
        createComponents,
      },
      /** 替身 React 引用：用例要切 `useState` 初值去渲染 busy / gone / error 三态。 */
      __react: React,
    };
  },
});
