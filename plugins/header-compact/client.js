window.__ModuleLoader__.load({
  id: '@local/header-compact',
  factory() {
    /**
     * 窄屏阈值。只覆盖手机竖屏：再宽一档（平板、桌面窄窗）标题行本身还有余量，
     * 动文案反而丢信息。文案收紧与按钮隐藏共用这一个数，免得两处各写一份。
     */
    const COMPACT_MAX_PX = 767.98;
    const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_PX}px)`;
    /** 会话标题行右端工具位的标记；用它反查整行，比记宿主的哈希类名稳。 */
    const CORNER = '[data-conversation-header-corner]';
    /** 一个页面只留一份样式表，靠这个标记去重。 */
    const STYLE_ID = 'header-compact';

    /** 中文计数文案：数量 + 「个」 + 名词 + 可选状态后缀。 */
    const ZH_COUNT = /^(\d+)\s*个\s*(子智能体|后台任务)([，,]?\s*(?:正在运行|运行中))?\s*$/u;
    /** 英文子智能体计数文案（单复数都认）。 */
    const EN_SUBAGENT = /^(\d+)\s+subagent(s?)(\s+running)?\s*$/i;
    /** 英文后台任务计数文案。 */
    const EN_JOB = /^(\d+)\s+background\s+job(s?)(\s+running)?\s*$/i;
    /** 中文名词的短写法。 */
    const SHORT_NAME = { 子智能体: '智能体', 后台任务: '后台' };

    /**
     * 手机端没有可打开的桌面文件管理器：整组按钮连同它的下拉一起不占标题行的宽度。
     * 作用域锁在会话标题行里，右侧文件面板里的同款按钮照常保留。
     */
    const css = `
@media (max-width: ${COMPACT_MAX_PX}px) {
  div:has(> [data-conversation-header-corner]) [data-open-target="directory"],
  div:has(> [data-conversation-header-corner]) :is(div, span):has(> [data-open-target="directory"]) {
    display: none !important;
  }
}
`;

    /**
     * 把一条计数文案收紧成手机端的短写法。
     *
     * 只认「数量 + 个 + 子智能体/后台任务」这种形状：上游一旦换了措辞或语言，
     * 这里返回 null 让调用方原样不动——宁可少改，也不能把不相干的文字改坏。
     * @param {string} text - 原文案。
     * @param {boolean} withSuffix - 是否保留状态后缀（aria-label 要留，可见文案不留）。
     * @returns {string|null} 短文案；不匹配时返回 null。
     */
    function shortenCountLabel(text, withSuffix) {
      if (typeof text !== 'string') return null;
      const zh = ZH_COUNT.exec(text);
      if (zh !== null) {
        const suffix = zh[3] === undefined ? '' : zh[3].replace(/^[，,]\s*/, '').trim();
        let tail = '';
        if (withSuffix && suffix === '正在运行') tail = '，正在运行';
        else if (withSuffix && suffix === '运行中') tail = ' 运行中';
        return `${SHORT_NAME[zh[2]]} ${zh[1]}${tail}`;
      }
      const subagent = EN_SUBAGENT.exec(text);
      if (subagent !== null) {
        const suffix = withSuffix && subagent[3] !== undefined ? ' running' : '';
        return `${subagent[1]} agent${subagent[2]}${suffix}`;
      }
      const job = EN_JOB.exec(text);
      if (job !== null) {
        const suffix = withSuffix && job[3] !== undefined ? ' running' : '';
        return `${job[1]} job${job[2]}${suffix}`;
      }
      return null;
    }

    /**
     * 收集子树里的文本节点。计数文字直接挂在 span 上，逐层走 childNodes
     * 既能拿到它，也不会误碰图标（图标是 svg，没有文本节点）。
     * @param {Node} node - 起点。
     * @param {Node[]} [out] - 结果累加器。
     * @returns {Node[]} 文本节点列表。
     */
    function textNodes(node, out = []) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out.push(child);
        else if (child.nodeType === 1) textNodes(child, out);
      }
      return out;
    }

    /**
     * 把标题行里认识的那几处文案收紧一遍。
     *
     * 写的是文本节点的 nodeValue，不替换节点：React 之后重渲染时手里握的还是
     * 同一个节点，计数照样更新得动。登记改写前的原值，离开窄屏时逐字还原。
     * @param {Element} row - 会话标题行。
     * @param {{ texts: Map, labels: Map }} originals - 还原用的登记簿。
     */
    function patchHeader(row, originals) {
      for (const button of row.querySelectorAll('button[aria-label]')) {
        const label = button.getAttribute('aria-label');
        if (label !== null) {
          const short = shortenCountLabel(label, true);
          if (short !== null) {
            originals.labels.set(button, label);
            button.setAttribute('aria-label', short);
          }
        }
        for (const node of textNodes(button)) {
          const short = shortenCountLabel(node.nodeValue, false);
          if (short === null) continue;
          originals.texts.set(node, node.nodeValue);
          node.nodeValue = short;
        }
      }
    }

    /**
     * 把登记过的文案逐字写回去。节点已经被 React 换掉的直接跳过——写回一个
     * 脱离文档的节点没有任何意义。
     * @param {{ texts: Map, labels: Map }} originals - 还原用的登记簿。
     */
    function restoreHeader(originals) {
      for (const [node, value] of originals.texts) {
        if (node.isConnected === true) node.nodeValue = value;
      }
      originals.texts.clear();
      for (const [button, value] of originals.labels) {
        if (button.isConnected === true) button.setAttribute('aria-label', value);
      }
      originals.labels.clear();
    }

    /**
     * 丢掉登记簿里已经脱离文档的节点。切换会话时旧标题行会卸载，那些节点再也
     * 用不上；不清的话长会话里登记簿会越攒越多。
     * @param {{ texts: Map, labels: Map }} originals - 还原用的登记簿。
     */
    function pruneHeader(originals) {
      for (const node of originals.texts.keys()) {
        if (node.isConnected !== true) originals.texts.delete(node);
      }
      for (const button of originals.labels.keys()) {
        if (button.isConnected !== true) originals.labels.delete(button);
      }
    }

    /**
     * 视口跨过阈值时收紧或还原标题行文案。
     *
     * 标题行由宿主渲染，计数还会变（子智能体增减、后台任务起止），所以不能只在
     * 挂载时改一次：观察器盯住 DOM，每帧最多扫一遍。自己写回去的长文案会被再
     * 收紧，循环在「这一遍没有改动」时自然停下。
     * @returns {() => void} disposer。
     */
    function installHeaderCompact() {
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return () => {};
      if (window === null || window === undefined) return () => {};
      if (typeof window.matchMedia !== 'function' || typeof window.requestAnimationFrame !== 'function') return () => {};
      const query = window.matchMedia(COMPACT_QUERY);
      const body = document.body;
      if (query === null || body === null) return () => {};
      const originals = { texts: new Map(), labels: new Map() };
      /** 上一遍扫到的标题行，只用来判断一次 DOM 变化与标题行有没有关系。 */
      let rows = [];
      let frame = 0;

      const collect = () => {
        const found = [];
        for (const corner of document.querySelectorAll(CORNER)) {
          const row = corner.parentElement;
          if (row !== null) found.push(row);
        }
        return found;
      };

      const apply = () => {
        frame = 0;
        rows = collect();
        if (query.matches !== true) {
          if (originals.texts.size > 0 || originals.labels.size > 0) restoreHeader(originals);
          return;
        }
        pruneHeader(originals);
        for (const row of rows) patchHeader(row, originals);
      };
      const schedule = () => {
        if (frame !== 0) return;
        frame = window.requestAnimationFrame(apply);
      };

      /** 新增/移除的子树里带标题行标记，说明标题行换了位置或被换掉。 */
      const carriesCorner = (node) => {
        if (node.nodeType === 1) return node.matches(CORNER) || node.querySelector(CORNER) !== null;
        if (node.nodeType === 3) return rows.some((row) => row.contains(node));
        return false;
      };

      /**
       * 这次变化与标题行有关吗。
       *
       * 模型流式输出、输入框打字每帧都会产生大量文本变化；全当有关就等于每帧
       * 把整个文档扫一遍。只有标题行内部、它的祖先容器、以及新增/移除的子树里
       * 带标题行标记时才算有关。
       * @param {MutationRecord} record - 一条 DOM 变化记录。
       * @returns {boolean} 是否需要重扫。
       */
      const related = (record) => {
        if (record.target === body) return true;
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (node !== null) {
          if (rows.some((row) => row.contains(node))) return true;
          if (rows.some((row) => node.contains(row))) return true;
        }
        for (const child of record.addedNodes) if (carriesCorner(child)) return true;
        for (const child of record.removedNodes) if (carriesCorner(child)) return true;
        return false;
      };

      const onMutations = (records) => {
        if (query.matches !== true) return;
        if (rows.length === 0) {
          schedule();
          return;
        }
        for (const record of records) {
          if (related(record)) {
            schedule();
            return;
          }
        }
      };

      apply();
      const observer = new MutationObserver(onMutations);
      observer.observe(body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-label'],
      });
      const onChange = () => {
        apply();
      };
      if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
      else if (typeof query.addListener === 'function') query.addListener(onChange);

      return () => {
        observer.disconnect();
        if (frame !== 0) window.cancelAnimationFrame(frame);
        if (typeof query.removeEventListener === 'function') query.removeEventListener('change', onChange);
        else if (typeof query.removeListener === 'function') query.removeListener(onChange);
        restoreHeader(originals);
      };
    }

    /** 挂一份窄屏样式表；热重载时先前的副本还在就不重复挂。 */
    function ensureStyle() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/header-compact';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    return {
      /** 供单测直接调用的内部件；宿主与槽位都不读它。 */
      internals: { COMPACT_MAX_PX, COMPACT_QUERY, shortenCountLabel, patchHeader, restoreHeader, pruneHeader, installHeaderCompact, css },
      apply(ctx) {
        ctx.effect(() => ensureStyle(), 'header-compact: 窄屏样式表');
        ctx.effect(() => installHeaderCompact(), 'header-compact: 标题行收紧');
      },
    };
  },
});
