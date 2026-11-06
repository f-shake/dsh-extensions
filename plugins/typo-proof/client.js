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
     * 宿主说了「这是演示模式」，面板就该换成内置演示源。
     *
     * 客户端插件拿不到 Loader 行的 config（`apply(ctx)` 只有一个参数），所以
     * 「演示模式」这件事只能由宿主在 status 里告诉它。少了这一步，就会出现
     * 「badge 写着演示数据、内容却是 0 段 0 字」的自相矛盾。
     * @param {object} next - 宿主返回的状态。
     * @param {string} kind - 当前数据源类型。
     * @returns {boolean} 是否切换到演示源。
     */
    function shouldUseDemo(next, kind) {
      if (kind === 'demo') return false;
      return next !== null && typeof next === 'object' && next.demo === true;
    }

    /**
     * 面板正文该显示哪一种视图。
     *
     * 抽成纯函数是为了能被单测覆盖：之前这段分支藏在组件里，任务失败后面板空白
     * 这件事没有任何用例看得见。
     * @param {{ status: string }} state - 规整后的状态。
     * @param {object | null} failure - 拉状态时的异常。
     * @returns {'failure' | 'loading' | 'error' | 'idle' | 'active'} 视图种类。
     */
    function viewOf(state, failure) {
      if (failure !== null && failure !== undefined) return 'failure';
      const status = state !== null && typeof state === 'object' ? state.status : undefined;
      if (status === 'loading' || status === undefined) return 'loading';
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
        demo: source.demo === true,
        file: typeof source.file === 'string' ? source.file : '',
        dir: typeof source.dir === 'string' ? source.dir : '',
        segments: Number(source.segments) || 0,
        hanzi: Number(source.hanzi) || 0,
        localModel: typeof source.localModel === 'string' ? source.localModel : '',
        reviewModel: typeof source.reviewModel === 'string' ? source.reviewModel : '',
        minHanzi: Number(source.minHanzi) || 0,
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

    /** 演示用的候选。真实数据由 2b 的后端给，这里只负责让流程看得见。 */
    const DEMO_ITEMS = [
      {
        seg: 12,
        prev: '那年冬天特别冷，我住在城西一间没有暖气的出租屋里。',
        original: '那时候我每天都要花四个小时在论坛上回复贴子。',
        corrected: '那时候我每天都要花四个小时在论坛上回复帖子。',
        next: '回完之后手指都僵了，但心里是热的。',
        hits: 3,
        state: 'confirmed',
        samples: [
          '那时候我每天都要花四个小时在论坛上回复帖子。',
          '那时候我每天都要花四个小时在论坛上回复帖子。',
          '那时候我每天都要花四个小时在论坛上回复帖子。',
        ],
        note: '三次采样都改成了“帖子”。',
      },
      {
        seg: 35,
        prev: '我妈在电话里说了很久，最后叹了口气。',
        original: '我妈说我这样下去不是办法，迟早要担误了自己。',
        corrected: '我妈说我这样下去不是办法，迟早要耽误了自己。',
        next: '我嘴上应着，心里并不服气。',
        hits: 3,
        state: 'confirmed',
        samples: [
          '我妈说我这样下去不是办法，迟早要耽误了自己。',
          '我妈说我这样下去不是办法，迟早要耽误了自己。',
          '我妈说我这样下去不是办法，迟早要耽误了自己。',
        ],
        note: '三次采样都改成了“耽误”。',
      },
      {
        seg: 74,
        prev: '第一个月结账的时候，我盯着后台看了很久。',
        original: '第一个月的收入是三百二十块，我还记得那个数子。',
        corrected: '第一个月的收入是三百二十块，我还记得那个数字。',
        next: '三百二十块，连房租都不够。',
        hits: 2,
        state: 'disputed',
        samples: [
          '第一个月的收入是三百二十块，我还记得那个数字。',
          '第一个月的收入是三百二十块，我还记得那个数字。',
          '第一个月的收入是三百二十块，我还记得那个数目。',
        ],
        note: '两次判为“数字”，一次判为“数目”，需要人定夺。',
      },
      {
        seg: 118,
        prev: '那天下午我一直在等他的电话。',
        original: '他给我发了一条消息，说这批货以经发出去了。',
        corrected: '他给我发了一条消息，说这批货已经发出去了。',
        next: '我松了一口气，又有点慌。',
        hits: 3,
        state: 'confirmed',
        samples: [
          '他给我发了一条消息，说这批货已经发出去了。',
          '他给我发了一条消息，说这批货已经发出去了。',
          '他给我发了一条消息，说这批货已经发出去了。',
        ],
        note: '三次采样都改成了“已经”。',
      },
      {
        seg: 152,
        prev: '她说话的时候一直看着别处。',
        original: '那种感觉很奇妙，像是一下子被人看透了心是。',
        corrected: '那种感觉很奇妙，像是一下子被人看透了心事。',
        next: '我赶紧把话题岔开了。',
        hits: 2,
        state: 'disputed',
        samples: [
          '那种感觉很奇妙，像是一下子被人看透了心事。',
          '那种感觉很奇妙，像是一下子被人看透了心事。',
          '那种感觉很奇妙，像是一下子被人看透了心思。',
        ],
        note: '两次判为“心事”，一次判为“心思”，需要人定夺。',
      },
      {
        seg: 187,
        prev: '价格来来回回谈了好几轮。',
        original: '我在旺旺上跟他聊了两个小时，最后还是没谈陇。',
        corrected: '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
        next: '第二天他却在别家下了单。',
        hits: 3,
        state: 'confirmed',
        samples: [
          '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
          '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
          '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
        ],
        note: '三次采样都改成了“谈拢”。',
      },
      {
        seg: 205,
        prev: '毕业之后我先去了一家广告公司。',
        original: '我在那家公司做了三个月就辞职了。',
        corrected: '我在那家公司作了三个月就辞职了。',
        next: '现在想起来，那三个月也不是全无用处。',
        hits: 3,
        state: 'rejected',
        samples: [
          '我在那家公司作了三个月就辞职了。',
          '我在那家公司作了三个月就辞职了。',
          '我在那家公司作了三个月就辞职了。',
        ],
        note: '云端认为“做了三个月”用法正确，建议保留原文。',
      },
      {
        seg: 229,
        prev: '那段时间我几乎每天都在群里说话。',
        original: '9月中旬，我的群人数终于达到了1000人满人，需要清除一些人。',
        corrected: '9月中旬，我的群人数终于达到了1000人满员，需要清除一些人。',
        next: '踢人的时候我还犹豫了很久。',
        hits: 2,
        state: 'confirmed',
        samples: [
          '9月中旬，我的群人数终于达到了1000人满员，需要清除一些人。',
          '9月中旬，我的群人数终于达到了1000人满员，需要清除一些人。',
          '9月中旬，我的群人数终于达到了1000人满，需要清除一些人。',
        ],
        note: '两次改“满人”为“满员”；第三次只删了“人”，按同一处改动计。',
      },
      {
        seg: 231,
        prev: '那天下午我跑了三趟快递点。',
        original: '那天晚上我睡的特别早，第二天起来天还没亮。',
        corrected: '那天晚上我睡得特别早，第二天起来天还没亮。',
        next: '窗外的雨下了一整夜。',
        hits: 3,
        state: 'confirmed',
        samples: [
          '那天晚上我睡得特别早，第二天起来天还没亮。',
          '那天晚上我睡得特别早，第二天起来天还没亮。',
          '那天晚上我睡得特别早，第二天起来天还没亮。',
        ],
        note: '三次采样都改成了“睡得”。',
      },
    ];

    /** 演示文件的元信息：直接用那本日记里的真实尺寸，进度条看起来才像真的。 */
    const DEMO_META = {
      demo: true,
      file: '2011~2014.docx',
      dir: 'C:\\Users\\autod\\OneDrive\\旧事重提\\日记',
      segments: 234,
      hanzi: 16_916,
      localModel: 'lmstudio / qwen3-4b',
      reviewModel: 'deepseek-official / deepseek-flash',
      minHanzi: 8,
    };

    /**
     * 构造一份演示状态。
     *
     * 三种起点：idle 等用户点开始；running 停在 62% 且不再走动（截图与设计评审用，
     * 时钟一跑就截不到同一帧）；done 直接给完整结果。
     * @param {'idle' | 'running' | 'done'} stage - 起点。
     * @returns {object} 规整后的状态。
     */
    function demoState(stage) {
      const base = { ...DEMO_META, status: IDLE, items: [], progress: {} };
      if (stage === 'done') {
        return normalizeState({
          ...base,
          status: DONE,
          items: DEMO_ITEMS,
          progress: { localDone: DEMO_META.segments, localTotal: DEMO_META.segments, reviewDone: DEMO_ITEMS.length, reviewTotal: DEMO_ITEMS.length },
        });
      }
      if (stage === 'running') {
        const half = DEMO_ITEMS.slice(0, 4);
        return normalizeState({
          ...base,
          status: RUNNING,
          items: half,
          progress: { localDone: 145, localTotal: DEMO_META.segments, reviewDone: 2, reviewTotal: half.length },
        });
      }
      return normalizeState(base);
    }

    /**
     * 演示数据源：把一次检查按 60ms 一帧走完，让界面上的每个状态都真的出现过。
     *
     * 2b 的 source 形状与这里一致（read/subscribe/start/pause/resume/stop），
     * 换掉实现就能接后端，面板代码不用动。
     * @param {{ preload?: 'idle' | 'running' | 'done' }} [options] - 起点。
     * @returns {object} 数据源。
     */
    function createDemoSource(options = {}) {
      const preload = options.preload === 'running' || options.preload === 'done' ? options.preload : 'idle';
      let state = demoState(preload);
      let timer = null;
      let paused = false;
      const listeners = new Set();

      function emit() {
        for (const listener of listeners) listener(state);
      }

      function stopTimer() {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }

      /** 走一帧：先把本地采样推满，再逐句复核。 */
      function tick() {
        const items = state.items.slice();
        const localDone = Math.min(state.segments, state.progress.localDone + 6);
        for (const item of DEMO_ITEMS) {
          if (item.seg <= localDone && !items.some((seen) => seen.seg === item.seg)) items.push(item);
        }
        items.sort((a, b) => a.seg - b.seg);
        const reviewTotal = items.length;
        const reviewDone = Math.min(reviewTotal, state.progress.reviewDone + (localDone >= state.segments ? 1 : 0));
        const finished = localDone >= state.segments && reviewDone >= reviewTotal;
        state = normalizeState({
          ...state,
          status: finished ? DONE : RUNNING,
          items,
          progress: {
            localDone,
            localTotal: state.segments,
            reviewDone: finished ? reviewTotal : reviewDone,
            reviewTotal,
          },
        });
        emit();
        if (finished) stopTimer();
      }

      function ensureTimer() {
        if (timer !== null) return;
        timer = setInterval(tick, 60);
      }

      return {
        kind: 'demo',
        /**
         * 拉起当前状态。演示源永远立即有值。
         * @returns {Promise<object>} 状态。
         */
        read() {
          return Promise.resolve(state);
        },
        /**
         * 订阅推送。
         * @param {(next: object) => void} listener - 回调。
         * @returns {() => void} 退订。
         */
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        start() {
          if (state.status === RUNNING) return;
          state = normalizeState({ ...state, status: RUNNING, note: '', items: [], progress: { localDone: 0, localTotal: state.segments, reviewDone: 0, reviewTotal: 0 } });
          paused = false;
          emit();
          ensureTimer();
        },
        pause() {
          if (state.status !== RUNNING) return;
          paused = true;
          stopTimer();
          state = normalizeState({ ...state, status: RUNNING, note: '已暂停' });
          emit();
        },
        resume() {
          if (!paused) return;
          paused = false;
          state = normalizeState({ ...state, note: '' });
          emit();
          ensureTimer();
        },
        stop() {
          paused = false;
          stopTimer();
          state = normalizeState({ ...state, status: IDLE, items: [], progress: {} });
          emit();
        },
      };
    }

    /**
     * 2b 的后端数据源。接口地址先定下来，面板不用等后端就能写完。
     * @param {object} options - `{ statusUrl, actionUrl }`。
     * @returns {object} 数据源。
     */
    function createHttpSource(options) {
      const statusUrl = typeof options?.statusUrl === 'string' ? options.statusUrl : '/typo-proof/status';
      const actionUrl = typeof options?.actionUrl === 'string' ? options.actionUrl : '/typo-proof/action';

      /** @param {string} action - start / pause / resume / stop。 */
      function send(action) {
        return fetch(actionUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
          credentials: 'same-origin',
        }).catch(() => undefined);
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
        start: () => send('start'),
        pause: () => send('pause'),
        resume: () => send('resume'),
        stop: () => send('stop'),
      };
    }

    /** 注入一次样式。插件反复加载时不要重复插。 */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
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
        // 候选行
        '.tp-list{display:flex;flex-direction:column;gap:6px}',
        '.tp-issue{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;overflow:hidden}',
        '.tp-issue-head{display:flex;flex-direction:column;gap:4px;width:100%;padding:8px 10px;border:0;background:none;font:inherit;',
        'color:inherit;cursor:pointer;text-align:left}',
        '.tp-issue-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
        '.tp-issue-meta{display:flex;align-items:center;gap:8px;min-width:0}',
        '.tp-seg{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',
        '.tp-hits{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',
        '.tp-pill{flex:0 0 auto;margin-left:auto;font-size:10px;padding:0 7px;border-radius:999px;line-height:16px;border:1px solid}',
        '.tp-pill[data-state="confirmed"]{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 10%,transparent)}',
        '.tp-pill[data-state="disputed"]{color:var(--dsw-alias-state-warn-primary,#b26a00);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 10%,transparent)}',
        '.tp-pill[data-state="rejected"]{color:var(--dsw-alias-label-tertiary,#8a8f98);border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.3))}',
        '.tp-issue-body{padding:0 10px 8px}',
        // 折叠时两行封顶；展开后正文挪到 .tp-full，这里直接收起来，避免同一句话出现两遍。
        '.tp-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:1.65;word-break:break-word}',
        '.tp-issue[data-expanded="true"] .tp-text{display:none}',
        '.tp-full{margin:0 0 6px;font-size:13px;line-height:1.7;word-break:break-word;color:var(--dsw-alias-label-primary,#14181f)}',
        '.tp-del{color:var(--dsw-alias-state-error-primary,#d33);text-decoration:line-through;background:var(--dsw-alias-code-diff-deleted,rgba(211,47,47,.13));border-radius:3px;padding:0 1px}',
        '.tp-ins{color:var(--dsw-alias-state-success-primary,#2e7d32);font-weight:600;background:var(--dsw-alias-code-diff-added,rgba(46,125,50,.14));border-radius:3px;padding:0 1px}',
        // 否决项：被模型点名的字加虚线下划线，既不划掉也不变绿——原文一个字都不改。
        '.tp-hint{border-bottom:1px dashed var(--dsw-alias-state-warn-primary,#b26a00);padding-bottom:1px}',
        '.tp-note{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.55}',
        '.tp-context{margin:8px 0 0;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));',
        'font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
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
      document.head.appendChild(style);
    }

    /**
     * 把一次采样的文本压成一行：太长就截断，但保留改动点附近的内容。
     * 面板宽 380px 左右，一行放得下二十来个汉字。
     * @param {string} text - 采样输出。
     * @returns {string} 展示文案。
     */
    function sampleLine(text) {
      const value = typeof text === 'string' ? text : '';
      return value.length > 40 ? `${value.slice(0, 40)}…` : value;
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
     * 候选行。
     *
     * 折叠时就要看得见句子——只有段号和“3/3”的列表没法扫，等于让人逐条点开。
     * 展开后补前后句与三次采样：人工最终靠这些判断，而不是靠模型的说法。
     * @param {{ item: object, expanded: boolean, onToggle: () => void }} props - 候选与展开状态。
     * @returns {object} 元素。
     */
    function IssueRow({ item, expanded, onToggle }) {
      const bodyId = `tp-detail-${itemKey(item).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      const full = diffChars(item.original, item.corrected);
      // 否决项：“模型动过这个字”而不是“这个字要删掉”。
      const display = item.state === 'rejected' ? markProposal(full) : full;
      const parts = excerptParts(display);
      return h(
        'div',
        { className: 'tp-issue', 'data-state': item.state, 'data-expanded': expanded ? 'true' : 'false' },
        h(
          'button',
          {
            type: 'button',
            className: 'tp-issue-head',
            'aria-expanded': expanded ? 'true' : 'false',
            'aria-controls': bodyId,
            onClick: onToggle,
          },
          h(
            'span',
            { className: 'tp-issue-meta' },
            h('span', { className: 'tp-seg' }, `第 ${item.seg} 段`),
            h('span', { className: 'tp-hits' }, `${item.hits}/3`),
            h('span', { className: 'tp-pill', 'data-state': item.state }, stateLabel(item.state)),
          ),
          h('span', { className: 'tp-text' }, renderParts(parts)),
        ),
        expanded
          ? h(
              'div',
              { className: 'tp-issue-body', id: bodyId },
              h('p', { className: 'tp-full' }, renderParts(display)),
              item.note === '' ? null : h('p', { className: 'tp-note' }, item.note),
              h(
                'p',
                { className: 'tp-context' },
                h('span', null, `前：${sampleLine(item.prev)}`),
                h('br'),
                h('span', null, `后：${sampleLine(item.next)}`),
              ),
              h(
                'div',
                { className: 'tp-samples' },
                item.samples.map((sample, index) =>
                  h(
                    'div',
                    { className: 'tp-sample', key: index },
                    h('span', { className: 'tp-sample-tag' }, `第${index + 1}次`),
                    // 三次采样往往只差一个字，整句重贴三遍没法对比；只把改动点附近切出来。
                    h(
                      'span',
                      null,
                      sample === item.original
                        ? '与原文一致'
                        : renderParts(excerptParts(diffChars(item.original, sample), 32)),
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    /**
     * 空态：还没开始跑时给文件信息、参数与主按钮。
     * @param {{ state: object, onStart: () => void }} props - 状态与开始回调。
     * @returns {object} 元素。
     */
    function EmptyState({ state, onStart }) {
      return h(
        'div',
        { className: 'tp-empty' },
        h(
          'div',
          { className: 'tp-empty-icon', 'aria-hidden': 'true' },
          h(
            'svg',
            { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 },
            h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }),
            h('path', { d: 'M15.5 15.5 21 21', strokeLinecap: 'round' }),
          ),
        ),
        h(
          'p',
          null,
          '逐句交给本地模型检查三次，其中两次改动了这句时，把这些改动（含只出现一次的地方）交给云端复核；确认的改动写进文档副本的修订模式，原文件不动。',
        ),
        h(
          'dl',
          { className: 'tp-params' },
          h('dt', null, '文件'),
          h('dd', { title: state.file }, state.file === '' ? '未选择' : state.file),
          h('dt', null, '规模'),
          h('dd', null, `${state.segments} 段 · ${formatCount(state.hanzi)} 字`),
          h('dt', null, '本地'),
          h('dd', { title: state.localModel }, state.localModel === '' ? '未配置' : state.localModel),
          h('dt', null, '复核'),
          h('dd', { title: state.reviewModel }, state.reviewModel === '' ? '未配置' : state.reviewModel),
          h('dt', null, '规则'),
          h('dd', null, `每句 ≥${state.minHanzi} 字 · 采样 3 次`),
        ),
        h(
          'button',
          { type: 'button', className: 'tp-btn', 'data-variant': 'primary', onClick: onStart },
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
          h('span', null, `已检查 ${localDone} / ${localTotal} 段`),
          h('b', null, `${pct}%`),
        ),
        h('div', { className: 'tp-stage' }, `本地采样 ${localDone * 3} 次 · 云端复核 ${reviewDone} / ${reviewTotal} 句`),
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
     * @param {{ state: object, filter: string, onFilter: (next: string) => void, expanded: string | null, onToggle: (seg: string) => void }} props - 状态与交互。
     * @returns {object} 元素。
     */
    function ResultBlock({ state, filter, onFilter, expanded, onToggle }) {
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
                item,
                expanded: expanded === itemKey(item),
                onToggle: () => onToggle(itemKey(item)),
              }),
            ),
      );
    }

    /**
     * 侧栏正文。
     *
     * 数据源由 apply 注入：`demo: true` 用演示源，否则走 2b 的 /typo-proof。
     * 后端还没接上时给一个明确的错误态，并留一个改用演示数据的入口，
     * 免得面板在 2a 阶段只能看见一片空白。
     * @param {{ source?: object, sessionId?: string }} props - 数据源。
     * @returns {object} 元素。
     */
    function PanelBody(props) {
      const initial = props.source !== undefined && props.source !== null ? props.source : createHttpSource();
      const [source, setSource] = useState(initial);
      const [state, setState] = useState({ status: 'loading' });
      const [filter, setFilter] = useState(FILTER_ALL);
      // 预览页会指定默认展开的段号；真实宿主不传，就是全部收起。
      const [expanded, setExpanded] = useState(typeof props.initialExpanded === 'string' ? props.initialExpanded : null);
      const [failure, setFailure] = useState(null);

      useEffect(() => {
        let alive = true;
        setFailure(null);
        const off = typeof source.subscribe === 'function' ? source.subscribe((next) => alive && setState(next)) : () => {};
        Promise.resolve()
          .then(() => source.read())
          .then((next) => {
            if (!alive) return;
            // 宿主开着演示模式时，面板要换成内置演示源：宿主那边的状态里只有配置，
            // 没有演示数据。不换的话就会「badge 写着演示数据、界面却是 0 段 0 字」——
            // 客户端插件拿不到 Loader 行的 config，只能靠这一趟 status 判断。
            if (shouldUseDemo(next, source.kind)) {
              setSource(createDemoSource());
              return;
            }
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
            .then((next) => setState(normalizeState(next)))
            .catch(() => {});
        }, 1200);
        return () => clearInterval(timer);
      }, [source, state.status]);

      function refresh() {
        Promise.resolve()
          .then(() => source.read())
          .then((next) => setState(normalizeState(next)))
          .catch((error) => {
            setFailure({ message: String(error?.message ?? error), code: error?.code ?? 'unknown' });
          });
      }

      function onStart() {
        if (typeof source.start !== 'function') return;
        Promise.resolve(source.start())
          .then(refresh)
          .catch((error) => setFailure({ message: String(error?.message ?? error), code: error?.code ?? 'unknown' }));
      }

      function onStop() {
        if (typeof source.stop === 'function') Promise.resolve(source.stop()).then(refresh).catch(() => {});
      }

      function onToggle(seg) {
        setExpanded((current) => (current === seg ? null : seg));
      }

      const head = h(
        'div',
        { className: 'tp-head' },
        h(
          'div',
          { className: 'tp-head-row' },
          h('span', { className: 'tp-title' }, '错别字检查'),
          state.demo === true ? h('span', { className: 'tp-badge' }, '演示数据') : null,
        ),
        h(
          'div',
          { className: 'tp-sub', title: state.file },
          state.file === '' ? '未选择文件' : `${state.file} · ${state.segments} 段 · ${formatCount(state.hanzi)} 字`,
        ),
      );

      let body;
      const view = viewOf(state, failure);
      if (view === 'failure') {
        body = h(
          'div',
          { className: 'tp-body' },
          h('div', { className: 'tp-error' }, failure.code === 'not-implemented' ? '后端还没接上（2b 接入）。现在可以先用演示数据看界面。' : failure.message),
          failure.code === 'not-implemented'
            ? h('button', { type: 'button', className: 'tp-btn', onClick: () => setSource(createDemoSource()) }, '用演示数据看界面')
            : null,
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
        body = h('div', { className: 'tp-body' }, h(EmptyState, { state, onStart }));
      } else {
        body = h(
          'div',
          { className: 'tp-body' },
          busy ? h(ProgressBlock, { state, onPause: () => source.pause?.(), onResume: () => source.resume?.(), onStop }) : null,
          state.status === DONE ? h(ResultBlock, { state, filter, onFilter: setFilter, expanded, onToggle }) : null,
          busy && state.counts.candidates > 0
            ? h(ResultBlock, { state, filter, onFilter: setFilter, expanded, onToggle })
            : null,
        );
      }

      const done = state.status === DONE;
      const downloadUrl = typeof state.downloadUrl === 'string' ? state.downloadUrl : '';
      const csvUrl = typeof state.csvUrl === 'string' ? state.csvUrl : '';
      const foot = h(
        'div',
        { className: 'tp-foot' },
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
          meta.demo === true ? h('span', { className: 'tp-card-tag' }, '演示数据') : null,
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
       * @param {object} [config] - 插件配置：`{ demo?: boolean, demoPreload?: string }`。
       */
      apply(ctx, config) {
        ctx.effect(() => ensureStyle(), 'typo-proof: styles');

        const demo = config !== null && typeof config === 'object' && config.demo === true;
        const source = demo
          ? createDemoSource({ preload: config?.demoPreload })
          : createHttpSource(config ?? {});

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
        shouldUseDemo,
        createDemoSource,
        createHttpSource,
        makeDemoState: demoState,
        DEMO_ITEMS,
        DEMO_META,
      },
      /** 预览页用的工厂：直接拿到组件，不必走一遍 apply。 */
      __components: { PanelBody, ToolCard, IssueRow, EmptyState, ProgressBlock, ResultBlock },
    };
  },
});
