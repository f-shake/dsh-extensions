window.__ModuleLoader__.load({
  id: '@local/typo-proof',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** 工具名。工具视图按这个名字派发，写错就永远不渲染。 */
    const TOOL_NAME = 'typo_check';
    /** 侧栏标签页的类型标识；同时也是正文注册用的 key。 */
    const PLUGIN_ID = '@local/typo-proof';
    const KIND = 'typo-proof';
    const STYLE_ID = 'typo-proof';

    /** 面板阶段。与 2b 的 /typo-proof/status 共用同一套取值。 */
    const IDLE = 'idle';
    const RUNNING = 'running';
    const DONE = 'done';
    const ERROR = 'error';

    /** 三个筛选页签的标识；`all` 不筛。 */
    const FILTER_ALL = 'all';
    const FILTER_CONFIRMED = 'confirmed';
    const FILTER_DISPUTED = 'disputed';
    const FILTER_REJECTED = 'rejected';

    /**
     * 千位以上换成“万”，面板宽度只够放四五个字。
     * @param {number} value - 原始数字。
     * @returns {string} 展示文案。
     */
    function formatCount(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '0';
      if (number < 10_000) return String(Math.round(number));
      return `${(number / 10_000).toFixed(1)} 万`;
    }

    /**
     * 百分比，取整；分母为零时按 0 处理。
     * @param {number} done - 已完成。
     * @param {number} total - 总数。
     * @returns {number} 0 到 100 的整数。
     */
    function percent(done, total) {
      const d = Number(done);
      const t = Number(total);
      if (!Number.isFinite(d) || !Number.isFinite(t) || t <= 0) return 0;
      return Math.max(0, Math.min(100, Math.round((d / t) * 100)));
    }

    /**
     * 字符级差异，只给“原句 → 修正”这种一两处改动的场景用。
     *
     * 用最长公共子序列而不是逐字对比：少一个字会让后面整段错位，
     * 逐字对比会把一整句都标成改动，读起来像重写。
     * 超过 400 字就不做 LCS（O(n²) 太贵），退化成“公共前后缀”。
     * @param {string} before - 原文。
     * @param {string} after - 修正后的文本。
     * @returns {Array<{ kind: 'same' | 'del' | 'ins', text: string }>} 分段结果。
     */
    function diffChars(before, after) {
      const a = typeof before === 'string' ? before : '';
      const b = typeof after === 'string' ? after : '';
      if (a === b) return a === '' ? [] : [{ kind: 'same', text: a }];

      const parts = [];
      const push = (kind, text) => {
        if (text === '') return;
        const last = parts.at(-1);
        if (last !== undefined && last.kind === kind) last.text += text;
        else parts.push({ kind, text });
      };

      if (a.length > 400 || b.length > 400) {
        let head = 0;
        while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
        let tail = 0;
        while (
          tail < a.length - head &&
          tail < b.length - head &&
          a[a.length - 1 - tail] === b[b.length - 1 - tail]
        ) {
          tail += 1;
        }
        push('same', a.slice(0, head));
        push('del', a.slice(head, a.length - tail));
        push('ins', b.slice(head, b.length - tail));
        push('same', a.slice(a.length - tail));
        return parts;
      }

      const rows = a.length;
      const cols = b.length;
      const lcs = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
      for (let i = rows - 1; i >= 0; i -= 1) {
        for (let j = cols - 1; j >= 0; j -= 1) {
          lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
      }

      let i = 0;
      let j = 0;
      while (i < rows && j < cols) {
        if (a[i] === b[j]) {
          push('same', a[i]);
          i += 1;
          j += 1;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
          push('del', a[i]);
          i += 1;
        } else {
          push('ins', b[j]);
          j += 1;
        }
      }
      if (i < rows) push('del', a.slice(i));
      if (j < cols) push('ins', b.slice(j));
      return parts;
    }

    /**
     * 状态到中文。
     * @param {string} state - confirmed / disputed / rejected。
     * @returns {string} 文案。
     */
    function stateLabel(state) {
      if (state === 'confirmed') return '已确认';
      if (state === 'disputed') return '有分歧';
      if (state === 'rejected') return '已否决';
      return '待复核';
    }

    /**
     * 候选的稳定标识。
     *
     * 同一段里可能有两处改动（甚至同一句两处），只用段号当 key 会让 React 撞车、
     * 展开其中一条时同段的全部跟着展开。
     * @param {object} item - 候选条目。
     * @returns {string} 唯一键；后端给了 id 就用 id。
     */
    function itemKey(item) {
      if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '') return item.id;
      const seg = item !== null && typeof item === 'object' ? item.seg : 0;
      return `${seg}-${item?.pos ?? 0}`;
    }

    /**
     * 从「文件路径」取出它所在的目录。
     *
     * 只有文件框需要它；目录里再进目录要走 loadDir，否则「上一级」会被多切一层
     * （C:\\Running\\dsh 会跳到 C:\\）。
     * @param {string} filePath - 文件路径。
     * @returns {string} 所在目录；没有分隔符时为空串。
     */
    function dirOf(filePath) {
      const text = String(filePath ?? '');
      const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
      if (cut > 0) {
        const head = text.slice(0, cut);
        // Windows 上 "C:" 不是盘符根，是「C 盘当前目录」——补回分隔符才不会跳到无关位置。
        return /^[a-zA-Z]:$/.test(head) ? `${head}\\` : head;
      }
      return '';
    }

    /**
     * 面板正文该显示哪一种视图。
     *
     * 抽成纯函数是为了能被单测覆盖：之前这段分支藏在组件里，任务失败后面板空白
     * 这件事没有任何用例看得见。
     * @param {{ status: string }} state - 规整后的状态。
     * @param {object | null} failure - 拉状态时的异常。
     * @param {boolean} [forceEmpty] - 用户点了「换文件」：把已完成的结果收起来。
     * @returns {'failure' | 'loading' | 'error' | 'idle' | 'active'} 视图种类。
     */
    function viewOf(state, failure, forceEmpty = false) {
      if (failure !== null && failure !== undefined) return 'failure';
      const status = state !== null && typeof state === 'object' ? state.status : undefined;
      if (status === 'loading' || status === undefined) return 'loading';
      // 只收起「已完成」，运行中的任务不能靠点按钮躲掉。
      if (forceEmpty === true && status === DONE) return 'idle';
      if (status === ERROR) return 'error';
      if (status === IDLE) return 'idle';
      return 'active';
    }

    /**
     * 按页签筛候选。未知页签按“全部”处理，避免点了旧链接出现空列表。
     * @param {object[]} items - 候选列表。
     * @param {string} filter - 页签标识。
     * @returns {object[]} 筛后的列表。
     */
    function filterItems(items, filter) {
      const list = Array.isArray(items) ? items : [];
      if (filter === FILTER_CONFIRMED || filter === FILTER_DISPUTED || filter === FILTER_REJECTED) {
        return list.filter((item) => item !== null && typeof item === 'object' && item.state === filter);
      }
      return list;
    }

    /**
     * 从候选里数出四个统计口径。
     * @param {object[]} items - 候选列表。
     * @returns {{ candidates: number, confirmed: number, disputed: number, rejected: number }} 计数。
     */
    function countStates(items) {
      const list = Array.isArray(items) ? items : [];
      const counts = { candidates: list.length, confirmed: 0, disputed: 0, rejected: 0 };
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        if (item.state === 'confirmed') counts.confirmed += 1;
        else if (item.state === 'disputed') counts.disputed += 1;
        else if (item.state === 'rejected') counts.rejected += 1;
      }
      return counts;
    }

    /**
     * 把一份原始状态规整成面板能直接用的形状。
     *
     * 2b 的 /typo-proof/status 和演示数据都经过这里，字段缺了退回默认值，
     * 免得后端少一个字段就把整个面板渲染成 undefined。
     * @param {object} raw - 原始状态。
     * @returns {object} 规整后的状态。
     */
    function normalizeState(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {};
      const items = Array.isArray(source.items) ? source.items.filter((item) => item !== null && typeof item === 'object') : [];
      const counts = countStates(items);
      const progress = source.progress !== null && typeof source.progress === 'object' ? source.progress : {};
      return {
        status: [IDLE, RUNNING, DONE, ERROR].includes(source.status) ? source.status : IDLE,
        file: typeof source.file === 'string' ? source.file : '',
        filePath: typeof source.filePath === 'string' ? source.filePath : '',
        dir: typeof source.dir === 'string' ? source.dir : '',
        segments: Number(source.segments) || 0,
        hanzi: Number(source.hanzi) || 0,
        localModel: typeof source.localModel === 'string' ? source.localModel : '',
        reviewModel: typeof source.reviewModel === 'string' ? source.reviewModel : '',
        minHanzi: Number(source.minHanzi) || 0,
        samples: Number(source.samples) || 3,
        progress: {
          localDone: Number(progress.localDone) || 0,
          localTotal: Number(progress.localTotal) || Number(source.segments) || 0,
          reviewDone: Number(progress.reviewDone) || 0,
          reviewTotal: Number(progress.reviewTotal) || 0,
        },
        items,
        counts,
        error: typeof source.error === 'string' ? source.error : '',
        note: typeof source.note === 'string' ? source.note : '',
        // 这两个必须原样带过来：底部两个按钮的可用状态全靠它们，
        // 漏掉的话按钮永远是灰的（下载不到东西）。
        downloadUrl: typeof source.downloadUrl === 'string' ? source.downloadUrl : '',
        csvUrl: typeof source.csvUrl === 'string' ? source.csvUrl : '',
      };
    }

    /**
     * 取一段 JSON。非 2xx 或响应不是 JSON 都抛错，带服务端给的错误文案。
     * @param {string} url - 地址。
     * @param {object} [init] - fetch 参数。
     * @returns {Promise<object>} 响应体。
     */
    async function requestJson(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
      const body = await response.json().catch(() => null);
      if (!response.ok || body === null) {
        throw new Error(body !== null && typeof body.error === 'string' ? body.error : `请求失败（HTTP ${response.status}）`);
      }
      return body;
    }

    /**
     * 2b 的后端数据源。接口地址先定下来，面板不用等后端就能写完。
     * @param {object} options - `{ statusUrl, actionUrl }`。
     * @returns {object} 数据源。
     */
    function createHttpSource(options) {
      const statusUrl = typeof options?.statusUrl === 'string' ? options.statusUrl : '/typo-proof/status';
      const actionUrl = typeof options?.actionUrl === 'string' ? options.actionUrl : '/typo-proof/action';

      /**
       * 发动作。
       * @param {string} action - start / pause / resume / stop。
       * @param {object} [extra] - 额外字段（start 要带 file）。
       * @returns {Promise<object | undefined>} 服务端响应。
       */
      function send(action, extra) {
        return fetch(actionUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...extra }),
          credentials: 'same-origin',
        })
          .then((response) => response.json().catch(() => ({})))
          .then((body) => {
            if (body !== null && typeof body === 'object' && body.ok === false) {
              throw Object.assign(new Error(String(body.error ?? '请求失败')), { code: 'http-error' });
            }
            return body;
          });
      }

      return {
        kind: 'http',
        read() {
          return fetch(statusUrl, { credentials: 'same-origin', cache: 'no-store' }).then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
              if (response.status === 404) {
                throw Object.assign(new Error('后端还没接上'), { code: 'not-implemented' });
              }
              const message = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
              throw Object.assign(new Error(message), { code: 'http-error' });
            }
            return normalizeState(body);
          });
        },
        subscribe() {
          return () => {};
        },
        /** @param {{ file?: string }} [payload] - 要检查的文件。 */
        start: (payload) => send('start', { file: typeof payload?.file === 'string' ? payload.file : '' }),
        pause: () => send('pause'),
        resume: () => send('resume'),
        stop: () => send('stop'),
      };
    }

    /**
     * 面板样式表。
     *
     * 抽成常量是为了热重载：插件重载时 `<style>` 还挂在老页面上，
     * 只「插一次」的话新增的类名永远拿不到样式——复制按钮会长成浏览器默认按钮、
     * 内部折叠会露出原生三角。所以每次 ensureStyle 都要把内容对齐。
     */
    const STYLE_TEXT = [
      // 全部选择器都挂在 data-typo-proof 下：宿主「交付」卡片与「Git」面板都用了自己的前缀，
      // 不隔离的话同名类（.tp-title、.tp-row）会互相踩。
      '[data-typo-proof], [data-typo-proof] *{box-sizing:border-box}',
      '[data-typo-proof]{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#14181f)}',
      '[data-typo-proof] p{margin:0}',
      // 面板：头部 / 可滚正文 / 固定底部三层。正文必须 min-height:0，
      // 否则 flex 子项按内容撑开，底部的下载按钮会被顶出可视区。
      '.tp-panel{display:flex;flex-direction:column;height:100%;min-height:0}',
      '.tp-head{display:flex;flex-direction:column;gap:3px;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
      '.tp-head-row{display:flex;align-items:center;gap:8px;min-width:0}',
      '.tp-title{font-size:13px;font-weight:600;flex:0 0 auto}',
      '.tp-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tp-badge{flex:0 0 auto;margin-left:auto;font-size:10px;padding:0 6px;border-radius:999px;line-height:16px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      // 头部右上角一组：演示标记 + 设置入口，整组靠右。
      '.tp-head-tools{margin-left:auto;flex:0 0 auto;display:flex;align-items:center;gap:10px;min-width:0}',
      '.tp-head-tools .tp-badge{margin-left:0}',
      '.tp-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:10px 12px}',
      '.tp-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
      '.tp-foot-note{flex:1 1 auto;min-width:0;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 按钮：主按钮只有「开始检查」「下载副本」，其余一律描边。
      '.tp-btn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));',
      'border-radius:8px;background:none;padding:4px 12px;cursor:pointer;font:inherit;font-size:12px;line-height:20px;',
      'color:var(--dsw-alias-label-primary,#14181f)}',
      '.tp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.tp-btn:disabled{opacity:.45;cursor:default}',
      // 主按钮用绝对色：--dsw-alias-brand-primary 在深色主题里是近白（它表示“高对比前景色”），
      // 当底色再配白字就成了白底白字。--dsw-static-deepseek-500 在深浅两套里都是同一个蓝。
      '.tp-btn[data-variant="primary"]{border-color:transparent;background:var(--dsw-static-deepseek-500,#4176e6);color:#fff}',
      '.tp-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-static-deepseek-500,#4176e6);filter:brightness(1.08)}',
      '.tp-btn[data-size="sm"]{padding:2px 10px;font-size:11px;line-height:18px}',
      '.tp-link{flex:0 0 auto;border:0;background:none;padding:0;font:inherit;font-size:10px;line-height:1.4;',
      'color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
      '.tp-link:hover{color:var(--dsw-alias-label-primary,#14181f)}',
      // 进度
      '.tp-prog{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px}',
      '.tp-bar{height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2));overflow:hidden}',
      '.tp-bar > i{display:block;height:100%;border-radius:999px;background:var(--dsw-static-deepseek-500,#4176e6);transition:width .25s ease}',
      '.tp-prog-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-prog-row b{font-weight:500;color:var(--dsw-alias-label-secondary,#4b5563);font-variant-numeric:tabular-nums}',
      '.tp-stage{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',
      '.tp-actions{display:flex;gap:6px}',
      // 统计格
      '.tp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}',
      '.tp-stat{padding:6px 2px;text-align:center;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px}',
      '.tp-stat b{display:block;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.tp-stat span{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-stat[data-tone="ok"] b{color:var(--dsw-alias-state-success-primary,#2e7d32)}',
      '.tp-stat[data-tone="warn"] b{color:var(--dsw-alias-state-warn-primary,#b26a00)}',
      '.tp-stat[data-tone="mute"] b{color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      // 筛选页签
      '.tp-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.tp-chip{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));border-radius:999px;background:none;',
      'padding:2px 10px;font:inherit;font-size:11px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.tp-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
      '.tp-chip[aria-pressed="true"]{border-color:var(--dsw-static-deepseek-500,#4176e6);color:var(--dsw-static-deepseek-500,#4176e6);',
      'background:color-mix(in srgb,var(--dsw-static-deepseek-500,#4176e6) 12%,transparent)}',
      // 候选行：卡片本身就展开，不再一条条点开；前/后与三次采样收在卡片内部的 .tp-detail 里。
      '.tp-list{display:flex;flex-direction:column;gap:6px}',
      '.tp-issue{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;overflow:hidden}',
      '.tp-issue-head{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 10px 0}',
      '.tp-issue-meta{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}',
      '.tp-seg{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',
      '.tp-hits{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',
      '.tp-pill{flex:0 0 auto;margin-left:auto;font-size:10px;padding:0 7px;border-radius:999px;line-height:16px;border:1px solid}',
      '.tp-pill[data-state="confirmed"]{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 10%,transparent)}',
      '.tp-pill[data-state="disputed"]{color:var(--dsw-alias-state-warn-primary,#b26a00);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 10%,transparent)}',
      '.tp-pill[data-state="rejected"]{color:var(--dsw-alias-label-tertiary,#8a8f98);border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.3))}',
      '.tp-issue-body{padding:2px 10px 8px}',
      '.tp-full{margin:2px 0 6px;font-size:13px;line-height:1.7;word-break:break-word;color:var(--dsw-alias-label-primary,#14181f)}',
      '.tp-del{color:var(--dsw-alias-state-error-primary,#d33);text-decoration:line-through;background:var(--dsw-alias-code-diff-deleted,rgba(211,47,47,.13));border-radius:3px;padding:0 1px}',
      '.tp-ins{color:var(--dsw-alias-state-success-primary,#2e7d32);font-weight:600;background:var(--dsw-alias-code-diff-added,rgba(46,125,50,.14));border-radius:3px;padding:0 1px}',
      // 否决项：被模型点名的字加虚线下划线，既不划掉也不变绿——原文一个字都不改。
      '.tp-hint{border-bottom:1px dashed var(--dsw-alias-state-warn-primary,#b26a00);padding-bottom:1px}',
      '.tp-note{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.55}',
      // 四个复制按钮：每张卡片都能把四处文字单独拿走。
      '.tp-copy{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:2px 0 6px}',
      '.tp-copy-btn{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.26));border-radius:6px;background:none;',
      'padding:0 6px;font:inherit;font-size:10px;line-height:16px;cursor:pointer;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.tp-copy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,#14181f)}',
      '.tp-copy-btn:disabled{opacity:.4;cursor:default}',
      '.tp-copy-ok{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-state-success-primary,#2e7d32)}',
      // 卡片内部的折叠：前/后与三次采样。原生 details 自带键盘操作，不用自己写开关状态。
      '.tp-detail{margin:0;padding-top:4px;border-top:.5px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.26))}',
      '.tp-detail > summary{display:flex;align-items:center;gap:5px;cursor:pointer;list-style:none;',
      'font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-detail > summary::-webkit-details-marker{display:none}',
      '.tp-detail > summary::before{content:"▸";font-size:9px;line-height:1}',
      '.tp-detail[open] > summary::before{content:"▾"}',
      '.tp-detail > summary:hover{color:var(--dsw-alias-label-primary,#14181f)}',
      '.tp-context{margin:6px 0 0;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));',
      'font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:pre-wrap;word-break:break-word}',
      '.tp-samples{display:flex;flex-direction:column;gap:2px;margin-top:8px;font-size:11px;line-height:1.5}',
      '.tp-sample{display:flex;gap:6px;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.tp-sample-tag{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',
      // 空态与错误态
      '.tp-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 6px;text-align:center}',
      '.tp-empty-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;',
      'background:color-mix(in srgb,var(--dsw-static-deepseek-500,#4176e6) 12%,transparent);color:var(--dsw-static-deepseek-500,#4176e6)}',
      '.tp-empty p{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.65;max-width:260px}',
      '.tp-params{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;width:100%;margin-top:2px;text-align:left;',
      'padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;font-size:11px}',
      '.tp-params dt{color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-params dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#4b5563);font-variant-numeric:tabular-nums}',
      '.tp-error{padding:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 40%,transparent);',
      'border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 8%,transparent);',
      'font-size:12px;color:var(--dsw-alias-state-error-primary,#d33);line-height:1.6}',
      // 设置表单：字段竖排，两个数字并排，其余整行。
      '.tp-input-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.tp-input-row .tp-input{flex:1 1 auto;min-width:0}',
      '.tp-picker{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1 1 auto}',
      '.tp-picker-bar{display:flex;align-items:center;gap:8px;min-width:0}',
      '.tp-picker-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-picker-list{flex:1 1 auto;min-height:120px;overflow:auto;display:flex;flex-direction:column;gap:1px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;padding:4px}',
      '.tp-picker-row{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:0;border-radius:7px;',
      'background:none;font:inherit;font-size:12px;color:inherit;cursor:pointer;text-align:left}',
      '.tp-picker-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
      '.tp-picker-row[data-selected="true"]{background:color-mix(in srgb,var(--dsw-static-deepseek-500,#4176e6) 14%,transparent);',
      'color:var(--dsw-static-deepseek-500,#4176e6)}',
      '.tp-picker-icon{flex:0 0 auto;font-size:9px;line-height:16px;padding:0 5px;border-radius:5px;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-picker-icon[data-kind="docx"]{background:color-mix(in srgb,var(--dsw-static-deepseek-500,#4176e6) 18%,transparent);',
      'color:var(--dsw-static-deepseek-500,#4176e6)}',
      '.tp-picker-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tp-form{display:flex;flex-direction:column;gap:10px}',
      // 空态里那块表单要占满宽度：父级 align-items:center 会把输入框压成内容宽度。
      '.tp-empty .tp-form{width:100%;text-align:left}',
      '.tp-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.tp-field > label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-base,#fff);',
      'color:var(--dsw-alias-label-primary,#14181f);font:inherit;font-size:12px;outline:none}',
      '.tp-input:focus{border-color:var(--dsw-static-deepseek-500,#4176e6)}',
      '.tp-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.tp-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.tp-check input{width:14px;height:14px;margin:0}',
      '.tp-help{margin:0;font-size:10px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-form-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}',
      // 对话里的工具卡片
      '.tp-card{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;max-width:100%;padding:10px 12px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:12px;',
      'background:var(--dsw-specific-input-major,transparent);font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#14181f)}',
      '.tp-card-head{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.tp-card-title{font-weight:600;font-size:13px;flex:0 0 auto}',
      '.tp-card-file{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tp-card-tag{flex:0 0 auto;font-size:10px;padding:0 6px;border-radius:999px;line-height:16px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.tp-card-line{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.tp-card-line b{font-weight:600;font-variant-numeric:tabular-nums}',
      '.tp-card-foot{display:flex;align-items:center;gap:8px}',
      '.tp-card-err{margin:0;white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--dsw-alias-state-error-primary,#d33)}',
    ].join('');

    /**
     * 注入样式。已经插过就换内容，不重复插。
     */
    function ensureStyle() {
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null) {
        if (existing.textContent !== STYLE_TEXT) existing.textContent = STYLE_TEXT;
        return;
      }
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
    }

    /**
     * 一条候选能单独拿走哪四段文字。
     *
     * 四段都从同一次 `diffChars` 里切：原文、改完的整句、被划掉的字（错字）、
     * 补上去的字（正字）。整句给别人看、单字自己核对，是两种用法，
     * 所以不把「错字」做成「原文里划掉的部分」这种推导，直接读 diff 的 del / ins。
     * @param {object} item - 候选条目。
     * @param {Array<{ kind: string, text: string }>} [parts] - 已经算好的 `diffChars` 结果；不传就现算。
     * @returns {{ original: string, corrected: string, wrong: string, right: string }} 四段文本。
     */
    function copyPayload(item, parts) {
      const original = typeof item?.original === 'string' ? item.original : '';
      const corrected = typeof item?.corrected === 'string' ? item.corrected : '';
      // 缺一边就不做 diff：老缓存里的条目没有 corrected，硬 diff 会把整句当成「被删掉的字」，
      // 「复制错字」就会塞进去一整句话。宁可两个按钮变灰。
      if (original === '' || corrected === '') return { original, corrected, wrong: '', right: '' };
      // 卡片正文已经算过一遍同一对字符串；一百多条候选时再跑一次 LCS 是白烧的。
      const diff = Array.isArray(parts) ? parts : diffChars(original, corrected);
      const join = (kind) =>
        diff
          .filter((part) => part.kind === kind)
          .map((part) => part.text)
          .join('');
      return { original, corrected, wrong: join('del'), right: join('ins') };
    }

    /**
     * 写进剪贴板。
     *
     * 宿主的 Web 入口常常是 http://局域网 IP，浏览器只把 localhost / https 当安全上下文，
     * 这种页面上 `navigator.clipboard` 是 undefined。所以先走标准 API，
     * 不可用时退回 textarea + execCommand——这是能在这类页面上真的复制成功的唯一办法。
     * @param {string} text - 要复制的文本。
     * @returns {Promise<boolean>} 是否成功。
     */
    async function copyText(text) {
      const value = typeof text === 'string' ? text : '';
      if (value === '') return false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {
        // 权限被拒或非安全上下文：落到下面的兜底。
      }
      let area = null;
      try {
        area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, value.length);
        return typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false;
      } catch {
        return false;
      } finally {
        // 中途抛错也要摘掉：不摘的话每点一次就在 body 尾巴上留一个看不见的 textarea。
        if (area !== null) {
          try {
            document.body.removeChild(area);
          } catch {
            // 已经不在文档里了。
          }
        }
      }
    }

    /**
     * 只保留改动点附近的文字。
     *
     * 折叠行最多两行（约 40 字），长句的改动落在句末就会被裁掉，
     * 而裁掉的恰好是唯一要看的东西。所以按改动点开窗：
     * 改动前留 12 字、改动后留到预算用完，两头加省略号。
     * @param {Array<{ kind: string, text: string }>} parts - `diffChars` 的结果。
     * @param {number} [budget] - 可见字数上限。
     * @returns {Array<{ kind: string, text: string }>} 开窗后的分段。
     */
    function excerptParts(parts, budget = 40) {
      const total = parts.reduce((sum, part) => sum + part.text.length, 0);
      if (total <= budget) return parts;
      const firstChange = parts.findIndex((part) => part.kind !== 'same');
      if (firstChange === -1) return parts;

      const out = [];
      let used = 0;
      let skippedHead = 0;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        let text = part.text;
        if (index < firstChange) {
          const keep = Math.min(text.length, 12);
          skippedHead += text.length - keep;
          text = text.slice(text.length - keep);
        }
        if (used + text.length > budget && index > firstChange) {
          out.push({ kind: part.kind, text: text.slice(0, Math.max(0, budget - used)) });
          out.push({ kind: 'same', text: '…' });
          return skippedHead > 0 ? [{ kind: 'same', text: '…' }, ...out] : out;
        }
        out.push({ kind: part.kind, text });
        used += text.length;
      }
      if (skippedHead > 0) out.unshift({ kind: 'same', text: '…' });
      return out;
    }

    /**
     * 把差异分段渲染成行内节点：删的划掉、加的高亮。
     * @param {Array<{ kind: string, text: string }>} parts - 分段。
     * @returns {object[]} 子节点。
     */
    function renderParts(parts) {
      return parts.map((part, index) => {
        if (part.kind === 'del') return h('del', { key: index, className: 'tp-del' }, part.text);
        if (part.kind === 'ins') return h('ins', { key: index, className: 'tp-ins' }, part.text);
        if (part.kind === 'hint') return h('span', { key: index, className: 'tp-hint' }, part.text);
        return part.text;
      });
    }

    /**
     * 否决项的显示方式：只标出模型动过哪个字，不把它当成“要删的字”。
     *
     * 直接用删除线会读成“这个词要删掉”，而否决的意思正好相反——原文不动。
     * 所以去掉新增字，把被点名的字改成虚线下划线。
     * @param {Array<{ kind: string, text: string }>} parts - `diffChars` 的结果。
     * @returns {Array<{ kind: string, text: string }>} 改写后的分段。
     */
    function markProposal(parts) {
      const out = [];
      for (const part of parts) {
        if (part.kind === 'ins') continue;
        out.push(part.kind === 'del' ? { kind: 'hint', text: part.text } : part);
      }
      return out;
    }

    /**
     * 候选卡片。
     *
     * 卡片本身就是展开的：段号、票数、结论、差异句、四个复制按钮一直看得见——
     * 之前要一条条点开才看得到句子，扫一百多条等于点一百多次。
     * 前一句 / 后一句 / 三次采样收进卡片内部的折叠：判断要看它们，
     * 但每条都摊开会把面板拉成一堵墙，所以留给人按需打开。
     * @param {{ item: object, samples: number }} props - 候选与每句采样次数。
     * @returns {object} 元素。
     */
    function IssueRow({ item, samples }) {
      const full = diffChars(item.original, item.corrected);
      // 否决项：“模型动过这个字”而不是“这个字要删掉”。
      const rejected = item.state === 'rejected';
      const display = rejected ? markProposal(full) : full;
      const payload = copyPayload(item, full);
      const total = Number(samples) || 3;
      const changed = Number(item.changed) || Number(item.hits) || 0;
      const before = typeof item.prev === 'string' ? item.prev : '';
      const after = typeof item.next === 'string' ? item.next : '';
      const list = Array.isArray(item.samples) ? item.samples : [];
      const [copied, setCopied] = useState('');
      const timer = useRef(null);

      // 切筛选页签会一次卸掉整列卡片；不清定时器就会在卸载之后 setState。
      useEffect(
        () => () => {
          if (timer.current !== null) clearTimeout(timer.current);
        },
        [],
      );

      /**
       * 复制一段，成功时亮一下「已复制」。
       * @param {string} key - 哪一段（四个按钮各自一个）。
       * @param {string} text - 要复制的文本。
       */
      function copy(key, text) {
        if (text === '') return;
        if (timer.current !== null) clearTimeout(timer.current);
        void copyText(text).then((ok) => {
          // 失败也要把提示清掉：否则上一次的「已复制」会一直挂在卡片上，
          // 而剪贴板里其实还是上一次的内容。
          setCopied(ok ? key : '');
          timer.current = ok
            ? setTimeout(() => {
                setCopied('');
                timer.current = null;
              }, 1400)
            : null;
        });
      }

      const buttons = [
        { key: 'original', label: '复制原文', text: payload.original },
        { key: 'corrected', label: '复制修改后', text: payload.corrected },
        { key: 'wrong', label: '复制错字', text: payload.wrong },
        { key: 'right', label: '复制正字', text: payload.right },
      ];

      /**
       * 按钮不可用的原因；可用时返回空串。
       * @param {object} button - 按钮描述。
       * @returns {string} 说明或空串。
       */
      function blockedReason(button) {
        // 否决项的 diff 是「模型建议」而不是「要改的字」：错字其实是原文里那个正确的字，
        // 正字反而是被复核否掉的字。这两个口子留着只会把人带偏，干脆关掉。
        if (rejected && (button.key === 'wrong' || button.key === 'right')) return '否决项没有可改正的字，原文不动';
        if (button.text === '') return `${button.label}：这段是空的`;
        return '';
      }

      return h(
        'div',
        { className: 'tp-issue', 'data-state': item.state },
        h(
          'div',
          { className: 'tp-issue-head' },
          h(
            'span',
            { className: 'tp-issue-meta' },
            h('span', { className: 'tp-seg' }, `第 ${item.seg} 段`),
            h(
              'span',
              { className: 'tp-hits', title: changed > Number(item.hits) ? `支持这个改法 ${item.hits}/${total} 次；该处共 ${changed} 次采样改动过` : `支持这个改法 ${item.hits}/${total} 次` },
              `${item.hits}/${total}`,
            ),
            h('span', { className: 'tp-pill', 'data-state': item.state }, stateLabel(item.state)),
          ),
        ),
        h(
          'div',
          { className: 'tp-issue-body' },
          h('p', { className: 'tp-full' }, renderParts(display)),
          item.note === '' ? null : h('p', { className: 'tp-note' }, item.note),
          h(
            'div',
            { className: 'tp-copy' },
            buttons.map((button) => {
              const blocked = blockedReason(button);
              return h(
                'button',
                {
                  key: button.key,
                  type: 'button',
                  className: 'tp-copy-btn',
                  disabled: blocked !== '',
                  title: blocked !== '' ? blocked : `${button.label}：${button.text}`,
                  onClick: () => copy(button.key, button.text),
                },
                button.label,
              );
            }),
            copied === '' ? null : h('span', { className: 'tp-copy-ok' }, '已复制'),
          ),
          h(
            'details',
            { className: 'tp-detail' },
            h('summary', null, `前/后与 ${total} 次采样`),
            h(
              'p',
              { className: 'tp-context' },
              h('span', null, `前：${before === '' ? '（无）' : before}`),
              h('br'),
              h('span', null, `后：${after === '' ? '（无）' : after}`),
            ),
            h(
              'div',
              { className: 'tp-samples' },
              list.map((sample, index) =>
                h(
                  'div',
                  { className: 'tp-sample', key: index },
                  h('span', { className: 'tp-sample-tag' }, `第${index + 1}次`),
                  // 三次采样往往只差一个字，整句重贴三遍没法对比；只把改动点附近切出来。
                  h(
                    'span',
                    null,
                    sample === item.original ? '与原文一致' : renderParts(excerptParts(diffChars(item.original, sample), 32)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * 空态：选文件、看参数、点开始。
     *
     * 文件放在这里而不是设置里：它是一次运行的输入，不是一份长期配置。
     * 设置里只留模型和数字这类「配一次管很久」的东西。
     * 路径是受控的：选完文件只填进输入框，**开始要用户自己点**——文件选择框
     * 顺手把任务跑起来，是最容易被吓一跳的交互。
     * @param {{ state: object, filePath: string, onChangeFile: (path: string) => void, onStart: () => void, onBrowse: () => void }} props - 属性。
     * @returns {object} 元素。
     */
    function EmptyState({ state, filePath, onChangeFile, onStart, onBrowse }) {
      const full = String(filePath ?? '');

      return h(
        'div',
        { className: 'tp-empty' },
        h(
          'div',
          { className: 'tp-form' },
          h(
            'div',
            { className: 'tp-field' },
            h('label', null, '要检查的 docx'),
            h(
              'div',
              { className: 'tp-input-row' },
              h('input', {
                className: 'tp-input',
                value: full,
                placeholder: 'C:\\…\\2011~2014.docx',
                onChange: (event) => onChangeFile(event.target.value),
              }),
              h('button', { type: 'button', className: 'tp-btn', 'data-size': 'sm', onClick: onBrowse }, '浏览…'),
            ),
          ),
        ),
        h(
          'dl',
          { className: 'tp-params' },
          h('dt', null, '规模'),
          h('dd', null, state.segments === 0 ? '还没读过这份文件' : `${state.segments} 段 · ${formatCount(state.hanzi)} 字`),
          h('dt', null, '采样'),
          h('dd', { title: state.localModel }, state.localModel === '' ? '未配置（去设置里选）' : state.localModel),
          h('dt', null, '复核'),
          h('dd', { title: state.reviewModel }, state.reviewModel === '' ? '跟随本地模型' : state.reviewModel),
          h('dt', null, '规则'),
          h('dd', null, `每句 ≥${state.minHanzi} 字 · 采样 ${state.samples} 次`),
        ),
        h(
          'button',
          { type: 'button', className: 'tp-btn', 'data-variant': 'primary', disabled: full === '', onClick: onStart },
          '开始检查',
        ),
      );
    }

    /**
     * 运行态：进度条 + 两段计数 + 暂停 / 停止。
     * @param {{ state: object, onPause: () => void, onResume: () => void, onStop: () => void }} props - 状态与操作。
     * @returns {object} 元素。
     */
    function ProgressBlock({ state, onPause, onResume, onStop }) {
      const { localDone, localTotal, reviewDone, reviewTotal } = state.progress;
      const pct = percent(localDone, localTotal);
      const paused = state.note === '已暂停';
      return h(
        'div',
        { className: 'tp-prog' },
        h('div', { className: 'tp-bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${pct}%` } })),
        h(
          'div',
          { className: 'tp-prog-row' },
          h('span', null, `已检查 ${localDone} / ${localTotal} 句`),
          h('b', null, `${pct}%`),
        ),
        h('div', { className: 'tp-stage' }, `本地采样 ${localDone * state.samples} 次 · 云端复核 ${reviewDone} / ${reviewTotal} 条`),
        h(
          'div',
          { className: 'tp-actions' },
          paused
            ? h('button', { type: 'button', className: 'tp-btn', 'data-size': 'sm', onClick: onResume }, '继续')
            : h('button', { type: 'button', className: 'tp-btn', 'data-size': 'sm', onClick: onPause }, '暂停'),
          h('button', { type: 'button', className: 'tp-btn', 'data-size': 'sm', onClick: onStop }, '停止'),
        ),
      );
    }

    /**
     * 结果态：四个统计格 + 筛选页签 + 候选列表。
     * @param {{ state: object, filter: string, onFilter: (next: string) => void }} props - 状态与交互。
     * @returns {object} 元素。
     */
    function ResultBlock({ state, filter, onFilter }) {
      const counts = state.counts;
      const rows = filterItems(state.items, filter);
      const chips = [
        { id: FILTER_ALL, label: '全部', count: counts.candidates },
        { id: FILTER_CONFIRMED, label: '已确认', count: counts.confirmed },
        { id: FILTER_DISPUTED, label: '有分歧', count: counts.disputed },
        { id: FILTER_REJECTED, label: '已否决', count: counts.rejected },
      ];
      return h(
        'div',
        { className: 'tp-list' },
        h(
          'div',
          { className: 'tp-stats' },
          h('div', { className: 'tp-stat' }, h('b', null, String(counts.candidates)), h('span', null, '可疑句')),
          h('div', { className: 'tp-stat', 'data-tone': 'ok' }, h('b', null, String(counts.confirmed)), h('span', null, '已确认')),
          h('div', { className: 'tp-stat', 'data-tone': 'warn' }, h('b', null, String(counts.disputed)), h('span', null, '有分歧')),
          h('div', { className: 'tp-stat', 'data-tone': 'mute' }, h('b', null, String(counts.rejected)), h('span', null, '已否决')),
        ),
        h(
          'div',
          { className: 'tp-chips', role: 'group', 'aria-label': '筛选' },
          chips.map((chip) =>
            h(
              'button',
              {
                key: chip.id,
                type: 'button',
                className: 'tp-chip',
                'aria-pressed': filter === chip.id ? 'true' : 'false',
                onClick: () => onFilter(chip.id),
              },
              `${chip.label} ${chip.count}`,
            ),
          ),
        ),
        rows.length === 0
          ? h('p', { className: 'tp-note' }, '这一类暂时没有条目。')
          : rows.map((item) =>
              h(IssueRow, {
                // 同一段里可能有好几处改动，key 只能用候选自己的 id。
                key: itemKey(item),
                samples: state.samples ?? 3,
                item,
              }),
            ),
      );
    }

    /**
     * 面板里的设置表单。
     *
     * 只放「跑一次要用到的值」：文件、两个模型、三个数字、演示开关。
     * 存到宿主上的 settings.json；保存后立刻生效，因为服务端每次请求都会重读一遍。
     * @param {{ config: object, providers: object[], error: string, saving: boolean, onSave: (patch: object) => void, onCancel: () => void }} props - 属性。
     * @returns {object} 元素。
     */
    function SettingsForm({ config, providers, error, saving, onSave, onCancel }) {
      const [draft, setDraft] = useState({
        localProvider: String(config.localProvider ?? ''),
        localModel: String(config.localModel ?? ''),
        reviewProvider: String(config.reviewProvider ?? ''),
        reviewModel: String(config.reviewModel ?? ''),
        minHanzi: String(config.minHanzi ?? 8),
        samples: String(config.samples ?? 3),
        concurrency: String(config.concurrency ?? 3),
      });

      const providerIds = providers.map((provider) => provider.id).filter((id) => typeof id === 'string' && id !== '');
      const modelsFor = (providerId) => {
        const found = providers.find((provider) => provider.id === providerId);
        return found !== undefined && Array.isArray(found.models) ? found.models : [];
      };

      const text = (key) => ({
        className: 'tp-input',
        value: draft[key],
        onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
      });

      /**
       * provider / 模型的选择框。
       *
       * 有清单就用下拉（值来自模型栏，不会拼错）；清单为空——模型服务还没就绪、
       * 或者这是个自定义名字——退回输入框，不能把人卡死在一个空下拉里。
       * @param {string} key - 字段名。
       * @param {string[]} options - 可选项。
       * @param {string} placeholder - 输入框占位文案。
       * @param {boolean} [allowEmpty] - 是否给一个“留空”选项。
       * @returns {object} 元素。
       */
      function picker(key, options, placeholder, allowEmpty = false) {
        const values = options.includes(draft[key]) || draft[key] === '' ? options : [draft[key], ...options];
        if (values.length === 0) return h('input', { ...text(key), placeholder });
        return h(
          'select',
          { className: 'tp-input', value: draft[key], onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) },
          allowEmpty ? h('option', { value: '' }, '跟随本地模型') : null,
          values.map((value) => h('option', { key: value, value }, value)),
        );
      }

      /**
       * provider 选择框。换 provider 时把模型重置成它的第一个：留着旧 provider 的模型名，
       * 保存下去就是一个不存在的组合。
       * @param {string} providerKey - provider 字段名。
       * @param {string} modelKey - 模型字段名。
       * @param {boolean} allowEmpty - 是否给“跟随本地模型”这一项。
       * @returns {object} 元素。
       */
      function providerPicker(providerKey, modelKey, allowEmpty) {
        if (providerIds.length === 0) return h('input', { ...text(providerKey), placeholder: 'lmstudio' });
        return h(
          'select',
          {
            className: 'tp-input',
            value: draft[providerKey],
            onChange: (event) => {
              const next = event.target.value;
              const models = modelsFor(next);
              setDraft({ ...draft, [providerKey]: next, [modelKey]: models.length > 0 ? models[0] : '' });
            },
          },
          allowEmpty ? h('option', { value: '' }, '跟随本地模型') : null,
          providerIds.map((value) => h('option', { key: value, value }, value)),
        );
      }

      function submit() {
        onSave({
          localProvider: draft.localProvider.trim(),
          localModel: draft.localModel.trim(),
          reviewProvider: draft.reviewProvider.trim(),
          reviewModel: draft.reviewModel.trim(),
          minHanzi: Number(draft.minHanzi),
          samples: Number(draft.samples),
          concurrency: Number(draft.concurrency),
        });
      }

      const localModels = modelsFor(draft.localProvider);
      const reviewModels = modelsFor(draft.reviewProvider);
      const empty = providerIds.length === 0;

      return h(
        'div',
        { className: 'tp-body' },
        h(
          'div',
          { className: 'tp-form' },
          h(
            'div',
            { className: 'tp-row' },
            h('div', { className: 'tp-field' }, h('label', null, '采样 provider'), providerPicker('localProvider', 'localModel', false)),
            h('div', { className: 'tp-field' }, h('label', null, '采样模型'), picker('localModel', localModels, 'qwen3-4b')),
          ),
          h('p', { className: 'tp-help' }, empty
            ? '模型栏里还没有可用的 provider：先去「设置 → 模型」添加一个（比如 LM Studio 的 http://127.0.0.1:1234/v1），回来这里就会有下拉。'
            : '下面这两行直接取自模型栏，选就行，不用手打。'),
          h(
            'div',
            { className: 'tp-row' },
            h('div', { className: 'tp-field' }, h('label', null, '复核 provider'), providerPicker('reviewProvider', 'reviewModel', true)),
            h('div', { className: 'tp-field' }, h('label', null, '复核模型'), picker('reviewModel', reviewModels, 'deepseek-flash', true)),
          ),
          h('p', { className: 'tp-help' }, '复核留空时用采样那套模型自审，报告里会记下来；想让云端独立复核，这里选一个不同家的模型。'),
          h(
            'div',
            { className: 'tp-row' },
            h('div', { className: 'tp-field' }, h('label', null, '最小汉字数'), h('input', { ...text('minHanzi'), type: 'number', min: 1, max: 100 })),
            h('div', { className: 'tp-field' }, h('label', null, '每句采样次数'), h('input', { ...text('samples'), type: 'number', min: 1, max: 10 })),
          ),
          h('div', { className: 'tp-field' }, h('label', null, '本地并发'), h('input', { ...text('concurrency'), type: 'number', min: 1, max: 16 })),
          error === '' ? null : h('div', { className: 'tp-error' }, error),
          h(
            'div',
            { className: 'tp-form-actions' },
            h('button', { type: 'button', className: 'tp-btn', 'data-size': 'sm', onClick: onCancel, disabled: saving }, '取消'),
            h('button', { type: 'button', className: 'tp-btn', 'data-variant': 'primary', 'data-size': 'sm', onClick: submit, disabled: saving }, saving ? '保存中…' : '保存'),
          ),
        ),
      );
    }

    /**
     * 文件选择框。
     *
     * 为什么自己做一个：宿主的「选择工作区目录」对话框绑死在「设置工作目录」上，
     * 而且它只列目录、不列文件（宿主后端明确把非目录条目跳过）。挑一个要校对的
     * docx 和「换工作目录」是两件事，混在一起只会让人误会。
     * 这里只做三件事：列目录、进目录、选中 .docx。
     * @param {{ view: object, onOpen: (dir: string) => void, onPick: (path: string) => void, onCancel: () => void }} props - 视图与回调。
     * @returns {object} 元素。
     */
    function FilePicker({ view, onOpen, onPick, onCancel }) {
      const [selected, setSelected] = useState('');

      // 换目录就把选中清掉：同一个组件实例，不重置的话「用这个文件」还指着上一层那个文件。
      useEffect(() => setSelected(''), [view.dir]);
      const dirs = Array.isArray(view.dirs) ? view.dirs : [];
      const files = Array.isArray(view.files) ? view.files : [];

      return h(
        'div',
        { className: 'tp-body' },
        h(
          'div',
          { className: 'tp-picker' },
          h(
            'div',
            { className: 'tp-picker-bar' },
            h(
              'button',
              { type: 'button', className: 'tp-btn', 'data-size': 'sm', onClick: () => onOpen(view.parent) },
              '上一级',
            ),
            h('span', { className: 'tp-picker-path', title: view.dir }, view.dir),
          ),
          view.error === '' ? null : h('div', { className: 'tp-error' }, view.error),
          h(
            'div',
            { className: 'tp-picker-list', role: 'listbox', 'aria-label': '目录与文件' },
            dirs.map((entry) =>
              h(
                'button',
                { key: `d-${entry.path}`, type: 'button', className: 'tp-picker-row', onClick: () => onOpen(entry.path) },
                h('span', { className: 'tp-picker-icon' }, '目录'),
                h('span', { className: 'tp-picker-name' }, entry.name),
              ),
            ),
            files.map((entry) =>
              h(
                'button',
                {
                  key: `f-${entry.path}`,
                  type: 'button',
                  className: 'tp-picker-row',
                  'data-selected': selected === entry.path ? 'true' : 'false',
                  onClick: () => setSelected(entry.path),
                },
                h('span', { className: 'tp-picker-icon', 'data-kind': 'docx' }, 'DOC'),
                h('span', { className: 'tp-picker-name' }, entry.name),
              ),
            ),
            dirs.length === 0 && files.length === 0
              ? h('p', { className: 'tp-note' }, '这一层没有子目录，也没有 .docx。')
              : null,
          ),
          h(
            'div',
            { className: 'tp-form-actions' },
            h('button', { type: 'button', className: 'tp-btn', 'data-size': 'sm', onClick: onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'tp-btn',
                'data-variant': 'primary',
                'data-size': 'sm',
                disabled: selected === '',
                onClick: () => onPick(selected),
              },
              '用这个文件',
            ),
          ),
        ),
      );
    }

    /**
     * 侧栏正文。
     *
     * 数据源由 apply 注入，固定是 /typo-proof 那一套（面板不再有演示模式）。
     * @param {{ source?: object, sessionId?: string }} props - 数据源。
     * @returns {object} 元素。
     */
    function PanelBody(props) {
      const initial = props.source !== undefined && props.source !== null ? props.source : createHttpSource();
      const [source, setSource] = useState(initial);
      const [state, setState] = useState({ status: 'loading' });
      const [filter, setFilter] = useState(FILTER_ALL);
      const [failure, setFailure] = useState(null);
      const [picker, setPicker] = useState(null);
      // 跑完之后点「换文件」：把结果收起来，回到空态等下一次输入。
      const [forceEmpty, setForceEmpty] = useState(false);
      // 要检查的文件：选一次、改一次，属于这次运行，不属于长期配置。
      const [filePath, setFilePath] = useState('');

      // 只在第一次拿到配置时填一次；之后用户清空输入框也不许再填回来。
      const seeded = useRef(false);
      useEffect(() => {
        if (seeded.current) return;
        if (typeof state.filePath === 'string' && state.filePath !== '') {
          seeded.current = true;
          setFilePath(state.filePath);
        }
      }, [state.filePath]);

      /**
       * 打开某个目录。传空串时由后端决定起点（配置里的文件所在目录，或用户主目录）。
       * @param {string} dir - 目录绝对路径。
       */
      async function loadDir(dir) {
        setPicker({ dir, parent: dir, dirs: [], files: [], error: '', loading: true });
        try {
          const payload = await requestJson(`/typo-proof/files?dir=${encodeURIComponent(dir)}`);
          setPicker({ dir: payload.dir, parent: payload.parent, dirs: payload.dirs, files: payload.files, error: '', loading: false });
        } catch (error) {
          // parent 保留上一个目录：进到没权限的地方时，至少还能退回去。
          setPicker((current) => ({
            dir,
            parent: current !== null && typeof current.parent === 'string' && current.parent !== '' ? current.parent : dir,
            dirs: [],
            files: [],
            error: String(error?.message ?? error),
            loading: false,
          }));
        }
      }

      /**
       * 从当前输入框里的文件路径打开选择框。
       * @param {string} current - 文件完整路径。
       */
      async function openPicker(current) {
        await loadDir(dirOf(current));
      }
      // 设置区：面板里唯一能改配置的地方。打开时才去拉配置与模型清单。
      // config 为 null = 「还没读到」，此时不要渲染表单：表单的初值只在挂载时算一次，
      // 拿空默认值挂上去再换 props，用户点保存就会把真实配置整份冲掉。
      const [settings, setSettings] = useState({ open: false, config: null, providers: [], saving: false, error: '' });

      useEffect(() => {
        let alive = true;
        setFailure(null);
        const off = typeof source.subscribe === 'function' ? source.subscribe((next) => alive && setState(next)) : () => {};
        Promise.resolve()
          .then(() => source.read())
          .then((next) => {
            if (!alive) return;
            setState(normalizeState(next));
          })
          .catch((error) => {
            if (!alive) return;
            setFailure({ message: String(error?.message ?? error), code: error?.code ?? 'unknown' });
            setState(normalizeState({ status: ERROR, items: [] }));
          });
        return () => {
          alive = false;
          off();
        };
      }, [source]);

      const busy = state.status === RUNNING;

      // 后端是轮询式的：任务在宿主里跑，浏览器这边只负责隔一会儿问一次。
      // 只在跑的时候轮询，空闲时一秒一次的空请求没有意义。
      useEffect(() => {
        if (source.kind !== 'http' || state.status !== RUNNING) return undefined;
        const timer = setInterval(() => {
          Promise.resolve()
            .then(() => source.read())
            .then((next) => {
              setFailure(null);
              setState(normalizeState(next));
            })
            .catch(() => {});
        }, 1200);
        return () => clearInterval(timer);
      }, [source, state.status]);

      function refresh() {
        Promise.resolve()
          .then(() => source.read())
          .then((next) => {
            // 拉成功就把失败态清掉：否则一次网络抖动之后，面板永远停在错误页，
            // 「重试」会真的重新请求、却什么也不变。
            setFailure(null);
            setState(normalizeState(next));
          })
          .catch((error) => {
            setFailure({ message: String(error?.message ?? error), code: error?.code ?? 'unknown' });
          });
      }

      /**
       * 开始一次检查。文件用输入框里那个；重试时也用它。
       */
      function onStart() {
        setForceEmpty(false);
        if (typeof source.start !== 'function') return;
        const file = filePath.trim();
        Promise.resolve(source.start(file === '' ? undefined : { file }))
          .then(refresh)
          .catch((error) => setFailure({ message: String(error?.message ?? error), code: error?.code ?? 'unknown' }));
      }

      function onStop() {
        if (typeof source.stop === 'function') Promise.resolve(source.stop()).then(refresh).catch(() => {});
      }

      /** 打开设置：配置与模型清单一起拉，省得用户在一个空白表单里手打模型名。 */
      async function openSettings() {
        setSettings((current) => ({ ...current, open: true, config: null, error: '' }));
        try {
          const [config, providers] = await Promise.all([
            requestJson('/typo-proof/config'),
            requestJson('/typo-proof/providers').catch(() => ({ providers: [] })),
          ]);
          setSettings({
            open: true,
            config: config.config !== null && typeof config.config === 'object' ? config.config : {},
            providers: Array.isArray(providers.providers) ? providers.providers : [],
            saving: false,
            error: '',
          });
        } catch (error) {
          // 拉配置失败也要把表单渲染出来：config 留在 null 的话，面板永远停在
          // “正在读取配置…”，连错误都看不到，更没有重试的入口。
          setSettings((current) => ({ ...current, config: {}, providers: [], saving: false, error: String(error?.message ?? error) }));
        }
      }

      /**
       * 保存设置。
       *
       * 保存完立刻重读一次状态：服务端每次请求都会重读配置文件，所以新值马上生效。
       * @param {object} patch - 要保存的字段。
       */
      async function saveSettings(patch) {
        setSettings((current) => ({ ...current, saving: true, error: '' }));
        try {
          const response = await requestJson('/typo-proof/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const next = response.config !== null && typeof response.config === 'object' ? response.config : {};
          setSettings({ open: false, config: next, providers: [], saving: false, error: '' });
          refresh();
        } catch (error) {
          setSettings((current) => ({ ...current, saving: false, error: String(error?.message ?? error) }));
        }
      }

      const head = h(
        'div',
        { className: 'tp-head' },
        h(
          'div',
          { className: 'tp-head-row' },
          h('span', { className: 'tp-title' }, '错别字检查'),
          h(
            'div',
            { className: 'tp-head-tools' },
            settings.open
              ? h('button', { type: 'button', className: 'tp-link', onClick: () => setSettings((current) => ({ ...current, open: false })) }, '返回')
              : h('button', { type: 'button', className: 'tp-link', onClick: openSettings }, '设置'),
          ),
        ),
        h(
          'div',
          { className: 'tp-sub', title: state.file },
          state.file === '' ? '未选择文件' : `${state.file} · ${state.segments} 段 · ${formatCount(state.hanzi)} 字`,
        ),
      );

      let body;
      const view = viewOf(state, failure, forceEmpty);
      if (picker !== null) {
        body = h(FilePicker, {
          view: picker,
          onOpen: (dir) => loadDir(dir),
          onPick: (path) => {
            setPicker(null);
            if (path !== '') setFilePath(path);
          },
          onCancel: () => setPicker(null),
        });
      } else if (settings.open && settings.config === null) {
        body = h('div', { className: 'tp-body' }, h('p', { className: 'tp-note' }, '正在读取配置…'));
      } else if (settings.open) {
        body = h(SettingsForm, {
          config: settings.config,
          providers: settings.providers,
          error: settings.error,
          saving: settings.saving,
          onSave: saveSettings,
          onCancel: () => setSettings((current) => ({ ...current, open: false })),
        });
      } else if (view === 'failure') {
        body = h(
          'div',
          { className: 'tp-body' },
          h('div', { className: 'tp-error' }, failure.message),
          h('button', { type: 'button', className: 'tp-btn', onClick: refresh }, '重试'),
        );
      } else if (view === 'loading') {
        body = h('div', { className: 'tp-body' }, h('p', { className: 'tp-note' }, '正在读取状态…'));
      } else if (view === 'error') {
        // 任务在 start 之后失败（模型连不上、文件读不到、写副本失败）时走到这里。
        // 不渲染这一段的话，面板就是一片空白，用户只能猜。
        body = h(
          'div',
          { className: 'tp-body' },
          h('div', { className: 'tp-error' }, state.error === '' ? '这次检查没有完成' : state.error),
          h(
            'div',
            { className: 'tp-actions' },
            h('button', { type: 'button', className: 'tp-btn', onClick: onStart }, '再试一次'),
            h('button', { type: 'button', className: 'tp-btn', onClick: refresh }, '刷新状态'),
          ),
        );
      } else if (view === 'idle') {
        body = h(
          'div',
          { className: 'tp-body' },
          h(EmptyState, {
            // 换文件时不要把上一次运行的段数/字数带过来。
            state: forceEmpty ? { ...state, segments: 0, hanzi: 0 } : state,
            filePath,
            onChangeFile: setFilePath,
            onStart,
            onBrowse: () => openPicker(filePath),
          }),
        );
      } else {
        body = h(
          'div',
          { className: 'tp-body' },
          busy ? h(ProgressBlock, { state, onPause: () => source.pause?.(), onResume: () => source.resume?.(), onStop }) : null,
          state.status === DONE ? h(ResultBlock, { state, filter, onFilter: setFilter }) : null,
        );
      }

      const done = state.status === DONE;
      const downloadUrl = typeof state.downloadUrl === 'string' ? state.downloadUrl : '';
      const csvUrl = typeof state.csvUrl === 'string' ? state.csvUrl : '';
      const foot = h(
        'div',
        { className: 'tp-foot' },
        done
          ? h(
              'button',
              { type: 'button', className: 'tp-link', onClick: () => { setForceEmpty(true); setFilter(FILTER_ALL); } },
              '换文件',
            )
          : null,
        done ? h('button', { type: 'button', className: 'tp-link', onClick: onStart }, '重新检查') : null,
        h('span', { className: 'tp-foot-note' }, '修订只写进副本，原文件不改'),
        h(
          'button',
          {
            type: 'button',
            className: 'tp-btn',
            'data-size': 'sm',
            disabled: csvUrl === '',
            title: csvUrl === '' ? '检查结束后可用' : '导出候选清单',
            onClick: () => {
              if (csvUrl !== '') window.location.assign(csvUrl);
            },
          },
          '导出 CSV',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'tp-btn',
            'data-variant': 'primary',
            'data-size': 'sm',
            disabled: downloadUrl === '',
            title: downloadUrl === '' ? '还没有生成副本' : '下载带修订的副本',
            onClick: () => {
              if (downloadUrl !== '') window.location.assign(downloadUrl);
            },
          },
          '下载副本',
        ),
      );

      return h('div', { 'data-typo-proof': '', className: 'tp-panel' }, head, body, foot);
    }

    /**
     * 对话里的工具卡片。工具还没返回时显示进度占位，返回后显示汇总。
     *
     * 失败的结果**不带 meta**（宿主只在成功结果上挂 meta），所以必须先判 isError：
     * 先判 meta 为空的写法会让错误分支永远走不到，卡片一直停在“正在检查”。
     * @param {{ phase?: string, block?: object }} props - 工具视图属性。
     * @returns {object} 元素。
     */
    function ToolCard(props) {
      const block = props.phase === 'result' ? props.block : null;
      const meta = block !== null && typeof block === 'object' && block.meta !== null && typeof block.meta === 'object' ? block.meta : null;

      if (props.phase !== 'result') {
        return h('div', { 'data-typo-proof': '', className: 'tp-card' }, h('div', { className: 'tp-card-head' }, h('span', { className: 'tp-card-title' }, '正在检查错别字…')));
      }

      if (block !== null && block.isError === true) {
        const detail =
          typeof block.error === 'string' && block.error !== ''
            ? block.error
            : Array.isArray(block.content)
              ? block.content
                  .map((item) => (item !== null && typeof item === 'object' && item.type === 'text' ? item.text : ''))
                  .filter((text) => typeof text === 'string' && text !== '')
                  .join('\n')
                  .slice(0, 300)
              : '';
        return h(
          'div',
          { 'data-typo-proof': '', className: 'tp-card' },
          h('div', { className: 'tp-card-head' }, h('span', { className: 'tp-card-title' }, '错别字检查失败')),
          h('pre', { className: 'tp-card-err' }, detail === '' ? '见上方输出' : detail),
        );
      }

      if (meta === null) {
        return h('div', { 'data-typo-proof': '', className: 'tp-card' }, h('div', { className: 'tp-card-head' }, h('span', { className: 'tp-card-title' }, '没有结果')));
      }

      const confirmed = Number(meta.confirmed) || 0;
      const disputed = Number(meta.disputed) || 0;
      const rejected = Number(meta.rejected) || 0;
      const candidates = Number(meta.candidates) || confirmed + disputed + rejected;
      const downloadUrl = typeof meta.downloadUrl === 'string' ? meta.downloadUrl : '';
      return h(
        'div',
        { 'data-typo-proof': '', className: 'tp-card' },
        h(
          'div',
          { className: 'tp-card-head' },
          h('span', { className: 'tp-card-title' }, '错别字检查'),
          h('span', { className: 'tp-card-file', title: meta.file }, String(meta.file ?? '')),
        ),
        h(
          'div',
          { className: 'tp-card-line' },
          h('span', null, `${Number(meta.segments) || 0} 段`),
          h('span', null, '→'),
          h('span', null, h('b', null, String(candidates)), ' 条可疑'),
          h('span', null, '→'),
          h('span', null, '云端确认 ', h('b', null, String(confirmed)), ' 条'),
          disputed > 0 ? h('span', null, `有分歧 ${disputed}`) : null,
          rejected > 0 ? h('span', null, `否决 ${rejected}`) : null,
        ),
        h(
          'div',
          { className: 'tp-card-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn',
              'data-size': 'sm',
              'data-variant': 'primary',
              // 没有 downloadUrl 就是还没有副本可下（演示数据、或检查没跑完）。
              disabled: downloadUrl === '',
              title: downloadUrl === '' ? '还没有生成副本' : '下载带修订的副本',
              onClick: () => {
                if (downloadUrl !== '') window.location.assign(downloadUrl);
              },
            },
            '下载副本',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn',
              'data-size': 'sm',
              onClick: () => {
                if (typeof props.onOpenPanel === 'function') props.onOpenPanel();
              },
            },
            '在右侧栏查看',
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      /**
       * 注册面板与工具卡片。
       * @param {object} ctx - 宿主上下文。
       * @param {object} [config] - 插件配置（保留参数，数据源固定走 /typo-proof）。
       */
      apply(ctx, config) {
        ctx.effect(() => ensureStyle(), 'typo-proof: styles');

        const source = createHttpSource(config ?? {});

        ctx.slots.inject('tool.call.toolview', () => {
          // 卡片上的“在右侧栏查看”要真的能打开面板：宿主只给工具视图传工具属性，
          // 打开侧栏这件事只能从 apply 这里闭包进去。
          const Card = (props) =>
            h(ToolCard, {
              ...props,
              onOpenPanel: () => {
                if (typeof ctx.sidebarRight?.openTab === 'function') ctx.sidebarRight.openTab(KIND);
              },
            });
          return ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, Card);
        });

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: PLUGIN_ID,
              kind: KIND,
              priority: 'extension',
              title: () => '错别字',
              guide: [
                {
                  id: 'typo-proof-panel',
                  order: 70,
                  title: () => '错别字检查',
                  description: () => '逐句检查日记里的错别字，改动写进副本的修订模式',
                },
              ],
            }),
          'typo-proof: tab type',
        );

        // 宿主的正文席位只传会话信息，不认额外属性：数据源靠闭包交进去。
        // 组件身份保持稳定（apply 只跑一次），否则每次渲染都会重挂子树、丢展开状态。
        const Body = (props) => h(PanelBody, { ...props, source });
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PLUGIN_ID }, Body),
        );
      },
      /** 只给单测与预览页用。 */
      __test: {
        formatCount,
        percent,
        diffChars,
        stateLabel,
        filterItems,
        countStates,
        normalizeState,
        itemKey,
        viewOf,
        dirOf,
        createHttpSource,
        copyPayload,
        ensureStyle,
      },
      /** 预览页用的工厂：直接拿到组件，不必走一遍 apply。 */
      __components: { PanelBody, ToolCard, IssueRow, EmptyState, ProgressBlock, ResultBlock, SettingsForm, FilePicker },
    };
  },
});
