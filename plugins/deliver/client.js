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
     * 从工具结果的 meta 里读出投递信息。格式不对就返回 null，让卡片退回纯文本，
     * 不要因为一条老记录把整个视图弄崩。
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
          // 老记录没有绝对路径：预览按钮据此自己禁用，下载不受影响。
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

    /**
     * 工具失败时把结果正文压成一行，给卡片当错误说明。
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
     * 一个回合里创建的那些投递。
     *
     * 回合末尾的卡片只能拿到回合的开始 / 结束时间（`turn.start.time`、`turn.end.time`），
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
        // 版式对齐内置「交付」卡片：圆角、细描边、左侧类型色块、名称加粗、说明灰字。
        '.dlv-card{box-sizing:border-box;display:flex;flex-direction:column;gap:5px;max-width:100%;',
        'padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#ffffff14);border-radius:12px;',
        'background:var(--dsw-specific-input-major,transparent);font-size:13px;line-height:1.5;',
        'color:var(--dsw-alias-label-primary,#f9fafb)}',
        '.dlv-card[data-deliver-state="revoked"]{opacity:.55}',
        '.dlv-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
        '.dlv-title{font-weight:600;font-size:13px}',
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
        '.dlv-foot{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding-top:2px;',
        'color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}',
        '.dlv-note{flex:1 1 auto;min-width:0;text-align:left}',
        '.dlv-link{border:0;background:none;padding:0;cursor:pointer;font:inherit;font-size:11px;',
        'color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '.dlv-link:hover{text-decoration:underline;color:var(--dsw-alias-label-primary,#f9fafb)}',
        '.dlv-link[data-warn]{color:var(--dsw-alias-state-error-primary,#e05b5b)}',
        '.dlv-err{margin:0;white-space:pre-wrap;word-break:break-word;',
        'color:var(--dsw-alias-state-error-primary,#e05b5b);font-size:11px}',
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
     * @returns {{ DeliverRow: Function, BoxBody: Function, TurnTailCard: Function, FileRow: Function, FileTile: Function, DownloadButton: Function }} 组件。
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
          if (state === 'busy' || openPreview === null) return;
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
       * 对话里的投递卡片。
       * @param {object} props - 工具视图属性。
       * @returns {object | null} 元素。
       */
      function DeliverRow(props) {
        const block = props.phase === 'result' ? props.block : null;
        const [confirming, setConfirming] = React.useState(false);
        const [revokeState, setRevokeState] = React.useState('idle');
        const meta = block === null ? null : readMeta(block);

        async function onRevoke() {
          if (meta === null || revokeState === 'busy') return;
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          setRevokeState('busy');
          try {
            const response = await fetch(`/deliver/${encodeURIComponent(meta.deliveryId)}`, {
              method: 'DELETE',
              credentials: 'same-origin',
            });
            setRevokeState(response.ok ? 'done' : 'error');
          } catch {
            setRevokeState('error');
          }
        }

        if (props.phase !== 'result') {
          return h(
            'div',
            { 'data-deliver': '', className: 'dlv-card' },
            h('div', { className: 'dlv-head' }, h('span', { className: 'dlv-title' }, '正在投递…')),
          );
        }

        if (block.isError || meta === null) {
          return h(
            'div',
            { 'data-deliver': '', className: 'dlv-card' },
            h('div', { className: 'dlv-head' }, h('span', { className: 'dlv-title' }, '投递失败')),
            h('pre', { className: 'dlv-err' }, errorText(block)),
          );
        }

        const revoked = revokeState === 'done';
        const remain = remainingText(meta.expiresAt, Date.now());
        // 剩余时间每行已经写了，底部只在异常态出字，免得同一句话出现两遍。
        // 撤销态也一样：行内的 extra 已经是「已撤销」。
        const note = revoked ? '' : revokeState === 'error' ? '撤销失败，再试一次' : '';

        return h(
          'div',
          {
            'data-deliver': '',
            className: 'dlv-card',
            'data-deliver-state': revoked ? 'revoked' : 'ok',
          },
          meta.files.map((file) =>
            h(FileRow, {
              key: String(file.index),
              file,
              sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
              disabled: revoked,
              extra: revoked ? '已撤销' : remain,
            }),
          ),
          h(
            'div',
            { className: 'dlv-foot' },
            h('span', { className: 'dlv-note' }, note),
            revoked
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dlv-link',
                    'data-warn': '',
                    disabled: revokeState === 'busy',
                    onClick: onRevoke,
                  },
                  confirming ? '确认撤销？' : '撤销',
                ),
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
            await fetch(`/deliver/${encodeURIComponent(id)}`, {
              method: 'DELETE',
              credentials: 'same-origin',
            });
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
       * 回合末尾的投递卡片。
       *
       * 正文里看不到工具行的用户（尤其是手机上）应该在这里一眼看到「这一轮交付了什么」。
       * 这个槽位在 `turn/start` 就挂载，所以必须等回合结束（`turn.end` 存在）才去拉列表——
       * 否则拉回来的是「本回合还没有投递」的那份，短回合就永远不显示卡片。
       * 列表按会话过滤，两个会话的回合时间重叠时不会互相串。
       * @param {{ turn?: { start?: { time?: number }, end?: { time?: number } }, sessionId?: string }} props - 回合末尾槽位的属性。
       * @returns {object | null} 元素。
       */
      function TurnTailCard(props) {
        const start = Number(props.turn?.start?.time);
        const end = Number(props.turn?.end?.time);
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        const [state, setState] = React.useState({ status: 'idle', deliveries: [] });

        React.useEffect(() => {
          if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
          let alive = true;
          const query = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`;
          fetch(`${LIST_URL}${query}`, { credentials: 'same-origin' })
            .then((response) => {
              if (!response.ok) throw new Error(String(response.status));
              return response.json();
            })
            .then((payload) => {
              if (!alive) return;
              const items =
                payload !== null && typeof payload === 'object' && Array.isArray(payload.deliveries)
                  ? payload.deliveries
                  : [];
              setState({ status: 'ready', deliveries: deliveriesInTurn(items, { start, end }) });
            })
            .catch(() => {
              if (alive) setState({ status: 'error', deliveries: [] });
            });
          return () => {
            alive = false;
          };
        }, [start, end, sessionId]);

        if (state.deliveries.length === 0) return null;

        const rows = [];
        const now = Date.now();
        for (const delivery of state.deliveries) {
          const files = Array.isArray(delivery.files) ? delivery.files : [];
          for (const file of files) {
            rows.push(
              h(FileRow, {
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
          { 'data-deliver': '', className: 'dlv-card' },
          rows,
        );
      }

      return { DeliverRow, BoxBody, TurnTailCard, FileRow, FileTile, DownloadButton, PreviewButton };
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
            components.DeliverRow,
          ),
        );

        // 回合末尾的卡片：与内置「交付」卡片同一个槽位，正文下方就能看到。
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
        readMeta,
        errorText,
        deliveriesInTurn,
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
