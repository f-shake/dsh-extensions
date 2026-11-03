window.__ModuleLoader__.load({
  id: '@local/git-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** Tab 类型身份：同时是正文席位与标题席位的 key。 */
    const ID = '@local/git-panel';
    /** 页面类型；`ctx.sidebarRight.openTab('git')` 用它打开。 */
    const KIND = 'git';
    const STYLE_ID = 'git-panel';
    /** 面板可见时的自动刷新间隔。 */
    const POLL_MS = 10_000;

    /** 稳定错误码到中文的映射；Host 的 detail 另行显示。 */
    const ERROR_TEXT = {
      'missing-session': '缺少会话信息',
      'session-unavailable': '会话未就绪，无法读取工作目录',
      'not-a-repository': '该目录不是 Git 仓库',
      'invalid-repo': '仓库路径无效',
      'invalid-path': '文件路径无效',
      'not-in-status': '该文件已不在当前改动列表，请刷新',
      'not-found': '文件不存在',
      'git-failed': 'git 执行失败',
      'git-timeout': 'git 执行超时',
      'internal-error': '内部错误',
    };
    /** 记住每个会话选中的子仓库；刷新后还是同一个。 */
    const REPO_KEY_PREFIX = 'dsh.git-panel.repo.';

    /**
     * 读取上次选中的子仓库。
     * @param {string} sessionId - 会话 id。
     * @returns {string | null} 仓库相对路径。
     */
    function readStoredRepo(sessionId) {
      try {
        const value = window.localStorage.getItem(`${REPO_KEY_PREFIX}${sessionId}`);
        return typeof value === 'string' && value !== '' ? value : null;
      } catch {
        return null;
      }
    }

    /**
     * 记住（或清除）选中的子仓库。
     * @param {string} sessionId - 会话 id。
     * @param {string | null} repo - 仓库相对路径。
     */
    function storeRepo(sessionId, repo) {
      try {
        if (repo === null) window.localStorage.removeItem(`${REPO_KEY_PREFIX}${sessionId}`);
        else window.localStorage.setItem(`${REPO_KEY_PREFIX}${sessionId}`, repo);
      } catch {
        // 隐私模式下存储不可用：本次会话内仍然记得，只是刷新后回到选择页。
      }
    }

    /**
     * 拼查询串，跳过空值。
     * @param {object} params - 键值对。
     * @returns {string} 查询串。
     */
    function query(params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        search.set(key, String(value));
      }
      return search.toString();
    }

    /**
     * 取 JSON，失败时抛带错误码的 Error。
     * @param {string} url - 请求地址。
     * @param {AbortSignal} signal - 取消信号。
     * @returns {Promise<object>} 响应体。
     */
    async function getJson(url, signal) {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code = typeof body?.error === 'string' ? body.error : 'http-error';
        const error = new Error(ERROR_TEXT[code] ?? `HTTP ${response.status}`);
        error.code = code;
        error.detail = typeof body?.detail === 'string' ? body.detail : '';
        error.status = response.status;
        throw error;
      }
      return body;
    }

    /**
     * 分支行的文案。空仓库没有提交，不能显示成 detached HEAD。
     * @param {object | null | undefined} branch - Host 的分支信息。
     * @returns {string} 展示文案。
     */
    function branchLabelOf(branch) {
      if (branch === null || branch === undefined) return '';
      if (branch.empty) return '空仓库（无提交）';
      if (branch.detached) return branch.sha === '' ? 'detached HEAD' : `detached@${branch.sha}`;
      return branch.name;
    }

    /**
     * 把错误翻成一句能放在面板里的话。
     * @param {Error | null} error - 错误。
     * @returns {string} 展示文案。
     */
    function errorText(error) {
      if (error === null || error === undefined) return '读取失败';
      const base = error.message !== '' ? error.message : '读取失败';
      return error.detail !== undefined && error.detail !== '' ? `${base}：${error.detail}` : base;
    }

    /**
     * 拆分路径，让目录以弱化颜色显示。
     * @param {string} value - 仓库相对路径。
     * @returns {{dir: string, base: string}} 目录前缀与文件名。
     */
    function splitPath(value) {
      const index = value.lastIndexOf('/');
      if (index < 0) return { dir: '', base: value };
      return { dir: value.slice(0, index + 1), base: value.slice(index + 1) };
    }

    /**
     * 文件在某一组里的状态字母。
     * @param {object} file - Host 的文件记录。
     * @param {'staged' | 'unstaged'} side - 哪一侧的差异。
     * @returns {string} 状态字母。
     */
    function letterOf(file, side) {
      if (file.conflict) return '!';
      if (file.untracked) return '?';
      const raw = side === 'staged' ? file.x : file.y;
      return raw === ' ' || raw === '.' ? '•' : raw;
    }

    /**
     * 状态字母对应的配色分组。
     * @param {object} file - Host 的文件记录。
     * @param {'staged' | 'unstaged'} side - 哪一侧的差异。
     * @returns {string} 配色名。
     */
    function kindOf(file, side) {
      if (file.conflict) return 'conflict';
      if (file.untracked) return 'untracked';
      const raw = side === 'staged' ? file.x : file.y;
      if (raw === 'A') return 'added';
      if (raw === 'D') return 'deleted';
      if (raw === 'R' || raw === 'C') return 'renamed';
      if (raw === 'U') return 'conflict';
      if (raw === 'M') return 'modified';
      return 'neutral';
    }

    /**
     * 某一侧的行数统计。
     * @param {object} file - Host 的文件记录。
     * @param {'staged' | 'unstaged'} side - 哪一侧。
     * @returns {object | null} 统计。
     */
    function statsOf(file, side) {
      return side === 'staged' ? file.staged : file.unstaged;
    }

    /**
     * 求一组文件某一侧的合计。
     * @param {object[]} files - 文件列表。
     * @param {'staged' | 'unstaged'} side - 哪一侧。
     * @returns {{additions: number, deletions: number, binary: boolean}} 合计。
     */
    function sumStats(files, side) {
      let additions = 0;
      let deletions = 0;
      let binary = false;
      for (const file of files) {
        const stats = statsOf(file, side);
        if (stats === null || stats === undefined) continue;
        additions += stats.additions;
        deletions += stats.deletions;
        if (stats.binary) binary = true;
      }
      return { additions, deletions, binary };
    }

    /**
     * 把文件按「冲突 / 已暂存 / 未暂存 / 未跟踪」分组。
     * @param {object | null} status - Host 的状态快照。
     * @returns {object[]} 分组列表。
     */
    function groupsOf(status) {
      const files = status?.files ?? [];
      const conflict = [];
      const staged = [];
      const unstaged = [];
      const untracked = [];
      for (const file of files) {
        if (file.conflict) {
          conflict.push(file);
          continue;
        }
        if (file.untracked) {
          untracked.push(file);
          continue;
        }
        if (file.staged !== null && file.staged !== undefined) staged.push(file);
        if (file.unstaged !== null && file.unstaged !== undefined) unstaged.push(file);
      }
      return [
        { id: 'conflict', title: '冲突', side: 'unstaged', items: conflict },
        { id: 'staged', title: '已暂存', side: 'staged', items: staged },
        { id: 'unstaged', title: '未暂存', side: 'unstaged', items: unstaged },
        { id: 'untracked', title: '未跟踪', side: 'unstaged', items: untracked },
      ].filter((group) => group.items.length > 0);
    }

    /** 刷新图标。 */
    function RefreshIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
        h('path', { d: 'M13.2 3.2v3.2H10' }),
      );
    }

    /** 返回图标。 */
    function BackIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M10 3 5 8l5 5' }),
      );
    }

    /** 引导页里的分支图形。 */
    function GitGuideIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          ...props,
        },
        h('circle', { cx: 4, cy: 3.5, r: 1.7 }),
        h('circle', { cx: 4, cy: 12.5, r: 1.7 }),
        h('circle', { cx: 12, cy: 6, r: 1.7 }),
        h('path', { d: 'M4 5.2v5.6' }),
        h('path', { d: 'M12 7.7c0 1.9-1.5 2.7-3.8 3.2' }),
      );
    }

    /** 切换仓库图标：文件夹加一支分叉，和引导页的分支图形区分开。 */
    function SwitchIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M1.8 4.2h4.1l1.3 1.5h7v6.6H1.8z' }),
        h('path', { d: 'M1.8 4.2V2.8h4l1.2 1.4' }),
      );
    }

    /** 仓库行里的小分支图标。 */
    function RepoIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 4, cy: 3.5, r: 1.5 }),
        h('circle', { cx: 4, cy: 12.5, r: 1.5 }),
        h('circle', { cx: 11.5, cy: 6, r: 1.5 }),
        h('path', { d: 'M4 5v6' }),
        h('path', { d: 'M11.5 7.5c0 1.7-1.4 2.4-3.6 2.9' }),
      );
    }

    /**
     * 子仓库选择页。
     *
     * 会话目录本身不是仓库时显示：扫描会话目录下两层的候选仓库，按输入过滤。
     * 选中一个后正文切到该仓库的状态；也可以先取消回到上一次的选择。
     * @param {object} props - 选择页属性。
     * @returns {object} 节点。
     */
    function RepoPicker({ cwd, state, filter, onFilter, onSelect, onRefresh, onCancel }) {
      const keyword = filter.trim().toLowerCase();
      const repos = (state.list ?? []).filter((repo) => {
        if (keyword === '') return true;
        return repo.path.toLowerCase().includes(keyword) || repo.name.toLowerCase().includes(keyword);
      });
      return h(
        'div',
        { className: 'gp-picker' },
        h(
          'div',
          { className: 'gp-picker-head' },
          h('span', { className: 'gp-picker-title' }, '选择 Git 仓库'),
          onCancel === null
            ? null
            : h('button', { type: 'button', className: 'gp-text-btn', onClick: onCancel }, '取消'),
        ),
        h('div', { className: 'gp-picker-cwd', title: cwd }, cwd),
        state.truncated
          ? h('div', { className: 'gp-picker-note' }, '扫描达到上限，列表可能不完整')
          : null,
        state.loading
          ? h('div', { className: 'gp-notice' }, '扫描仓库…')
          : state.error !== null
            ? h(
                'div',
                { className: 'gp-notice' },
                h('div', null, errorText(state.error)),
                h('button', { type: 'button', className: 'gp-text-btn', onClick: onRefresh }, '重试'),
              )
            : state.list.length === 0
              ? h(
                  'div',
                  { className: 'gp-empty gp-empty-grow' },
                  h('strong', null, '没有找到 Git 仓库'),
                  h('span', null, '只扫描会话目录下的两层；把会话建在仓库目录里也可以。'),
                )
              : h(
                  'div',
                  { className: 'gp-picker-body' },
                  h('input', {
                    className: 'gp-filter',
                    type: 'search',
                    value: filter,
                    placeholder: '筛选仓库…',
                    'aria-label': '筛选仓库',
                    onChange: (event) => onFilter(event.target.value),
                  }),
                  repos.length === 0
                    ? h('div', { className: 'gp-notice' }, '没有匹配的仓库')
                    : h(
                        'div',
                        { className: 'gp-repo-list' },
                        repos.map((repo) =>
                          h(
                            'button',
                            {
                              key: repo.path,
                              type: 'button',
                              className: 'gp-repo',
                              title: repo.path,
                              onClick: () => onSelect(repo.path),
                            },
                            h('span', { className: 'gp-repo-icon' }, h(RepoIcon)),
                            h(
                              'span',
                              { className: 'gp-repo-text' },
                              h('span', { className: 'gp-repo-name' }, repo.name),
                              repo.path === repo.name
                                ? null
                                : h('span', { className: 'gp-repo-path' }, repo.path),
                            ),
                          ),
                        ),
                      ),
                ),
      );
    }

    /**
     * 行数统计。
     * @param {{stats: object | null}} props - 统计。
     * @returns {object | null} 节点。
     */
    function Counts({ stats }) {
      if (stats === null || stats === undefined) return null;
      if (stats.binary) return h('span', { className: 'gp-binary' }, '二进制');
      if (stats.additions === 0 && stats.deletions === 0) return null;
      return h(
        'span',
        { className: 'gp-counts' },
        stats.additions > 0 ? h('span', { className: 'gp-add' }, `+${stats.additions}`) : null,
        stats.deletions > 0 ? h('span', { className: 'gp-del' }, `−${stats.deletions}`) : null,
      );
    }

    /**
     * 状态徽标。
     * @param {{file: object, side: string}} props - 文件与侧。
     * @returns {object} 节点。
     */
    function Badge({ file, side }) {
      return h(
        'span',
        {
          className: 'gp-badge',
          'data-kind': kindOf(file, side),
          title: `${file.untracked ? '未跟踪' : file.conflict ? '冲突' : 'Git 状态'} ${letterOf(file, side)}`,
        },
        letterOf(file, side),
      );
    }

    /**
     * 文件行。
     * @param {{file: object, side: 'staged' | 'unstaged', onOpen: Function, rowRef?: Function}} props - 行属性。
     * @returns {object} 节点。
     */
    function FileRow({ file, side, onOpen, rowRef }) {
      const { dir, base } = splitPath(file.path);
      const stats = statsOf(file, side);
      return h(
        'button',
        {
          type: 'button',
          ref: rowRef,
          className: 'gp-file',
          title: file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`,
          onClick: () =>
            onOpen({
              path: file.path,
              origPath: file.origPath,
              side,
              untracked: file.untracked === true,
            }),
        },
        h(Badge, { file, side }),
        h(
          'span',
          { className: 'gp-path' },
          dir === '' ? null : h('span', { className: 'gp-dir' }, dir),
          h('span', { className: 'gp-base' }, base),
        ),
        h(Counts, { stats }),
      );
    }

    /**
     * 一组文件。
     * @param {{group: object, onOpen: Function, registerRow: Function}} props - 分组、打开回调与行 ref 登记。
     * @returns {object} 节点。
     */
    function FileGroup({ group, onOpen, registerRow }) {
      const total = sumStats(group.items, group.side);
      return h(
        'section',
        { className: 'gp-group', 'aria-label': group.title },
        h(
          'div',
          { className: 'gp-group-head' },
          h('span', { className: 'gp-group-title' }, group.title),
          h('span', { className: 'gp-group-count' }, String(group.items.length)),
          total.binary || total.additions > 0 || total.deletions > 0
            ? h(
                'span',
                { className: 'gp-group-stats' },
                total.binary ? h('span', { className: 'gp-binary' }, '二进制') : null,
                total.additions > 0 ? h('span', { className: 'gp-add' }, `+${total.additions}`) : null,
                total.deletions > 0 ? h('span', { className: 'gp-del' }, `−${total.deletions}`) : null,
              )
            : null,
        ),
        group.items.map((file) =>
          h(FileRow, {
            key: `${group.id}:${file.path}`,
            file,
            side: group.side,
            onOpen: (item) => onOpen({ ...item, groupId: group.id }),
            rowRef: (node) => registerRow(group.id, file.path, node),
          }),
        ),
      );
    }

    /**
     * 差异正文。
     * @param {{state: {loading: boolean, error: Error | null, data: object | null}, onRetry: Function}} props - 状态。
     * @returns {object} 节点。
     */
    function DiffBody({ state, onRetry }) {
      if (state.loading) return h('div', { className: 'gp-notice' }, '读取差异…');
      if (state.error !== null) {
        return h(
          'div',
          { className: 'gp-notice' },
          h('div', { className: 'gp-notice-text' }, errorText(state.error)),
          h('button', { type: 'button', className: 'gp-text-btn', onClick: onRetry }, '重试'),
        );
      }
      const data = state.data;
      if (data === null || data === undefined) return h('div', { className: 'gp-notice' }, '没有差异');
      if (data.binary) return h('div', { className: 'gp-notice' }, '二进制文件，无法显示文本差异');
      if (data.oversized) return h('div', { className: 'gp-notice' }, '文件过大，未显示差异');
      if (data.multiFile) return h('div', { className: 'gp-notice' }, '该文件涉及多段差异，暂不支持显示');
      if (data.conflict) return h('div', { className: 'gp-notice' }, '合并冲突：该文件没有可显示的文本差异');
      if (!Array.isArray(data.hunks) || data.hunks.length === 0) {
        return h('div', { className: 'gp-notice' }, '没有文本差异（可能只是重命名或权限变化）');
      }
      return h(
        'div',
        { className: 'gp-diff' },
        data.truncated ? h('div', { className: 'gp-notice gp-notice-inline' }, '差异过长，已截断') : null,
        data.hunks.map((hunk, hunkIndex) =>
          h(
            'div',
            { className: 'gp-hunk', key: `hunk:${hunkIndex}` },
            h('div', { className: 'gp-hunk-head', title: hunk.header }, hunk.header),
            hunk.lines.map((line, lineIndex) =>
              h(
                'div',
                {
                  className:
                    line.type === '+'
                      ? 'gp-line gp-line-add'
                      : line.type === '-'
                        ? 'gp-line gp-line-del'
                        : 'gp-line',
                  key: `line:${lineIndex}`,
                },
                h('span', { className: 'gp-ln' }, line.oldNo === null ? '' : String(line.oldNo)),
                h('span', { className: 'gp-ln' }, line.newNo === null ? '' : String(line.newNo)),
                h(
                  'span',
                  { className: 'gp-code' },
                  `${line.type === '+' ? '+' : line.type === '-' ? '-' : ' '}${line.text}`,
                ),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * 单个文件的差异页。
     * @param {{selected: object, state: object, onBack: Function, onRetry: Function, backRef: object}} props - 属性。
     * @returns {object} 节点。
     */
    function DiffPage({ selected, state, onBack, onRetry, backRef }) {
      const { dir, base } = splitPath(selected.path);
      const data = state.data;
      const additions = data?.additions ?? 0;
      const deletions = data?.deletions ?? 0;
      // 打开差异页时焦点落在返回按钮上，键盘用户不必先摸到页面里找出口。
      useEffect(() => {
        backRef.current?.focus();
      }, [backRef]);
      return h(
        'div',
        { className: 'gp-detail' },
        h(
          'div',
          { className: 'gp-detail-head' },
          h(
            'button',
            {
              type: 'button',
              ref: backRef,
              className: 'gp-icon-btn',
              onClick: onBack,
              title: '返回文件列表',
              'aria-label': '返回文件列表',
            },
            h(BackIcon),
          ),
          h(
            'span',
            { className: 'gp-detail-path', title: selected.path },
            dir === '' ? null : h('span', { className: 'gp-dir' }, dir),
            h('span', { className: 'gp-base' }, base),
          ),
          h(
            'span',
            { className: 'gp-detail-side' },
            selected.untracked ? '未跟踪' : selected.side === 'staged' ? '已暂存' : '未暂存',
          ),
        ),
        h(
          'div',
          { className: 'gp-detail-meta' },
          data?.binary
            ? h('span', { className: 'gp-binary' }, '二进制')
            : h(
                'span',
                { className: 'gp-counts' },
                h('span', { className: 'gp-add' }, `+${additions}`),
                h('span', { className: 'gp-del' }, `−${deletions}`),
              ),
          selected.untracked ? h('span', { className: 'gp-detail-note' }, '新文件') : null,
          selected.origPath === undefined ? null : h('span', { className: 'gp-detail-note' }, `原路径 ${selected.origPath}`),
        ),
        h(DiffBody, { state, onRetry }),
      );
    }

    /**
     * Tab 正文。
     * @param {object} props - 席位注入的会话属性。
     * @returns {object} 节点。
     */
    function GitBody(props) {
      const { sessionId, useSessions, useTabInfo } = props;
      const { tab } = useTabInfo();
      const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
      const [tick, setTick] = useState(0);
      const [refresh, setRefresh] = useState(0);
      const [snapshot, setSnapshot] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(null);
      const [diff, setDiff] = useState({ loading: false, error: null, data: null });
      const [repo, setRepo] = useState(() => readStoredRepo(sessionId));
      const [picker, setPicker] = useState(false);
      const [filter, setFilter] = useState('');
      const [repos, setRepos] = useState({ loading: false, error: null, list: [], truncated: false });
      const [reposTick, setReposTick] = useState(0);
      const statusTicket = useRef(0);
      const diffTicket = useRef(0);
      const reposTicket = useRef(0);
      const rowRefs = useRef(new Map());
      const lastOpened = useRef(null);
      const backRef = useRef(null);
      const visible = tab.visible;

      /** 会话目录自身不是仓库、且还没选子仓库时，直接进入选择页。 */
      const pickerActive =
        picker || (repo === null && snapshot !== null && snapshot.ok === true && snapshot.isRepo === false);

      /**
       * 打开一个文件的差异页，并记住打开它的行。
       * @param {object} item - 文件信息。
       */
      const openFile = (item) => {
        lastOpened.current = item;
        setSelected(item);
      };

      /** 返回列表，并把焦点交还给刚才那一行。 */
      const closeFile = () => {
        const item = lastOpened.current;
        setSelected(null);
        window.requestAnimationFrame(() => {
          if (item === null) return;
          const node = rowRefs.current.get(`${item.groupId}:${item.path}`);
          if (typeof node?.focus === 'function') node.focus();
        });
      };

      /**
       * 登记文件行的 DOM 节点，供返回时恢复焦点。
       * @param {string} groupId - 分组 id。
       * @param {string} pathValue - 文件路径。
       * @param {object | null} node - 按钮节点。
       */
      const registerRow = (groupId, pathValue, node) => {
        const key = `${groupId}:${pathValue}`;
        if (node === null || node === undefined) rowRefs.current.delete(key);
        else rowRefs.current.set(key, node);
      };

      /**
       * 选中一个子仓库并记住它。
       * @param {string} value - 相对会话目录的路径。
       */
      const selectRepo = (value) => {
        const next = value.trim().replaceAll('\\', '/').replace(/^\.\/+/u, '');
        if (next === '') return;
        storeRepo(sessionId, next);
        setFilter('');
        setPicker(false);
        setSelected(null);
        setRepo(next);
        setRefresh((current) => current + 1);
      };

      // 刷新命令（侧栏的刷新快捷键/按钮）只推进 refresh，轮询 tick 不会带动差异请求。
      useEffect(() => tab.actions.bindCommands({ refresh: () => setRefresh((value) => value + 1) }), [tab.actions]);

      // 切会话：恢复该会话记住的仓库，清掉上一会话的选中文件。
      useEffect(() => {
        setRepo(readStoredRepo(sessionId));
        setPicker(false);
        setFilter('');
        setSelected(null);
        setDiff({ loading: false, error: null, data: null });
      }, [sessionId]);

      // 切仓库：上一份状态与差异都不再对应当前仓库。
      useEffect(() => {
        setSnapshot(null);
        setError(null);
        setLoading(true);
        setSelected(null);
        setDiff({ loading: false, error: null, data: null });
      }, [repo]);

      // 状态轮询：只在面板可见时跑；切回页面时补一次。
      useEffect(() => {
        if (visible === false) return undefined;
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') setTick((value) => value + 1);
        }, POLL_MS);
        const onVisibility = () => {
          if (document.visibilityState === 'visible') setTick((value) => value + 1);
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [visible]);

      useEffect(() => {
        if (visible === false) return undefined;
        const ticket = ++statusTicket.current;
        const controller = new AbortController();
        if (snapshot === null) setLoading(true);
        getJson(`/git-panel/status?${query({ session: sessionId, repo: repo ?? '' })}`, controller.signal)
          .then((data) => {
            if (statusTicket.current !== ticket || controller.signal.aborted) return;
            setSnapshot(data);
            setError(null);
            setLoading(false);
          })
          .catch((failure) => {
            if (failure.name === 'AbortError' || statusTicket.current !== ticket) return;
            // 记住的仓库已经不存在：清掉选择并回到仓库列表，比停在一个报错页有用。
            if (repo !== null && (failure.code === 'invalid-repo' || failure.code === 'not-a-repository')) {
              storeRepo(sessionId, null);
              setRepo(null);
              setPicker(true);
            }
            setError(failure);
            setLoading(false);
          });
        return () => controller.abort();
        // snapshot 只用来决定是否显示骨架，不参与请求依赖。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, cwd, visible, tick, refresh, repo]);

      // 选择页出现时才扫描候选仓库；每次打开/重试各扫描一次。
      useEffect(() => {
        if (!pickerActive) return undefined;
        const ticket = ++reposTicket.current;
        const controller = new AbortController();
        setRepos((previous) => ({ ...previous, loading: true, error: null }));
        getJson(`/git-panel/repos?${query({ session: sessionId })}`, controller.signal)
          .then((data) => {
            if (reposTicket.current !== ticket || controller.signal.aborted) return;
            setRepos({ loading: false, error: null, list: data.repos ?? [], truncated: data.truncated === true });
          })
          .catch((failure) => {
            if (failure.name === 'AbortError' || reposTicket.current !== ticket) return;
            setRepos({ loading: false, error: failure, list: [], truncated: false });
          });
        return () => controller.abort();
      }, [pickerActive, sessionId, cwd, reposTick]);

      useEffect(() => {
        if (selected === null) {
          setDiff({ loading: false, error: null, data: null });
          return undefined;
        }
        const ticket = ++diffTicket.current;
        const controller = new AbortController();
        setDiff({ loading: true, error: null, data: null });
        const url = `/git-panel/diff?${query({
          session: sessionId,
          repo: repo ?? '',
          path: selected.path,
          orig: selected.origPath,
          staged: selected.side === 'staged' ? '1' : '',
          untracked: selected.untracked ? '1' : '',
        })}`;
        getJson(url, controller.signal)
          .then((data) => {
            if (diffTicket.current !== ticket || controller.signal.aborted) return;
            setDiff({ loading: false, error: null, data });
          })
          .catch((failure) => {
            if (failure.name === 'AbortError' || diffTicket.current !== ticket) return;
            setDiff({ loading: false, error: failure, data: null });
          });
        return () => controller.abort();
      }, [selected, sessionId, repo, refresh]);

      useEffect(() => {
        if (selected === null && !pickerActive) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (selected !== null) closeFile();
          else if (repo !== null) setPicker(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [selected, pickerActive, repo]);

      if (pickerActive) {
        return h(
          'div',
          { 'data-git-panel': '', className: 'gp-root' },
          h(RepoPicker, {
            cwd: cwd ?? '',
            state: repos,
            filter,
            onFilter: setFilter,
            onSelect: selectRepo,
            onRefresh: () => setReposTick((value) => value + 1),
            onCancel: repo === null ? null : () => setPicker(false),
          }),
        );
      }

      if (selected !== null) {
        return h(
          'div',
          { 'data-git-panel': '', className: 'gp-root' },
          h(DiffPage, {
            selected: selected,
            state: diff,
            onBack: closeFile,
            onRetry: () => setRefresh((value) => value + 1),
            backRef,
          }),
        );
      }

      if (snapshot === null && loading) {
        return h(
          'div',
          { 'data-git-panel': '', className: 'gp-root' },
          h('div', { className: 'gp-notice' }, '读取 Git 状态…'),
        );
      }

      if (snapshot === null) {
        return h(
          'div',
          { 'data-git-panel': '', className: 'gp-root' },
          h(
            'div',
            { className: 'gp-empty' },
            h('strong', null, '读取失败'),
            h('span', null, errorText(error)),
            h('button', { type: 'button', className: 'gp-text-btn', onClick: () => setRefresh((value) => value + 1) }, '重试'),
            repo === null ? null : h('button', { type: 'button', className: 'gp-text-btn', onClick: () => setPicker(true) }, '选择仓库'),
          ),
        );
      }

      if (snapshot.ok !== true) {
        return h(
          'div',
          { 'data-git-panel': '', className: 'gp-root' },
          h(
            'div',
            { className: 'gp-empty' },
            h('strong', null, '读取失败'),
            h('span', null, errorText(error)),
            h('button', { type: 'button', className: 'gp-text-btn', onClick: () => setRefresh((value) => value + 1) }, '重试'),
            repo === null ? null : h('button', { type: 'button', className: 'gp-text-btn', onClick: () => setPicker(true) }, '选择仓库'),
          ),
        );
      }

      if (snapshot.isRepo !== true) {
        return h(
          'div',
          { 'data-git-panel': '', className: 'gp-root' },
          h(
            'div',
            { className: 'gp-empty' },
            h('strong', null, '这个目录不是 Git 仓库'),
            h('span', { className: 'gp-mono', title: snapshot.cwd }, snapshot.cwd),
            h('button', { type: 'button', className: 'gp-text-btn', onClick: () => setPicker(true) }, '选择子仓库'),
          ),
        );
      }

      const groups = groupsOf(snapshot);
      const branch = snapshot.branch ?? {};
      const branchLabel = branchLabelOf(branch);
      return h(
        'div',
        { 'data-git-panel': '', className: 'gp-root' },
        h(
          'div',
          { className: 'gp-head' },
          h(
            'div',
            { className: 'gp-head-main' },
            h(
              'div',
              { className: 'gp-branch-row' },
              h('span', { className: 'gp-branch', title: branchLabel }, branchLabel),
              branch.ahead > 0 ? h('span', { className: 'gp-track', title: `领先上游 ${branch.ahead} 个提交` }, `↑${branch.ahead}`) : null,
              branch.behind > 0
                ? h('span', { className: 'gp-track', title: `落后上游 ${branch.behind} 个提交` }, `↓${branch.behind}`)
                : null,
            ),
            h('div', { className: 'gp-root-line', title: snapshot.root }, repo === null ? snapshot.repo : repo),
          ),
          repo === null
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'gp-icon-btn',
                  onClick: () => setPicker(true),
                  title: '切换仓库',
                  'aria-label': '切换仓库',
                },
                h(SwitchIcon),
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'gp-icon-btn',
              onClick: () => setRefresh((value) => value + 1),
              title: '刷新 Git 状态',
              'aria-label': '刷新 Git 状态',
            },
            h(RefreshIcon),
          ),
        ),
        h(
          'div',
          { className: 'gp-summary' },
          h('span', null, `${snapshot.total} 个文件`),
          snapshot.truncated ? h('span', { className: 'gp-summary-note' }, '只列出前 1000 个') : null,
          error === null ? null : h('span', { className: 'gp-summary-error', title: errorText(error) }, '状态未同步'),
        ),
        groups.length === 0
          ? h(
              'div',
              { className: 'gp-empty gp-empty-grow' },
              h('strong', null, '工作区干净'),
              h('span', null, '没有未提交的改动。'),
            )
          : h(
              'div',
              { className: 'gp-scroll' },
              groups.map((group) =>
                h(FileGroup, {
                  key: group.id,
                  group,
                  onOpen: openFile,
                  registerRow,
                }),
              ),
            ),
      );
    }

    const css = `
[data-git-panel]{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#14181f);background:transparent}
[data-git-panel] *{box-sizing:border-box}
[data-git-panel] .gp-head{display:flex;align-items:center;gap:8px;padding:8px 10px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));flex:0 0 auto;min-width:0}
[data-git-panel] .gp-head-main{flex:1;min-width:0}
[data-git-panel] .gp-branch-row{display:flex;align-items:center;gap:6px;min-width:0}
[data-git-panel] .gp-branch{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-git-panel] .gp-track{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);font-variant-numeric:tabular-nums}
[data-git-panel] .gp-root-line{font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
[data-git-panel] .gp-icon-btn{flex:0 0 auto;display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5c6066);cursor:pointer;font:inherit}
[data-git-panel] .gp-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#14181f)}
[data-git-panel] .gp-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176f5);outline-offset:-2px}
[data-git-panel] .gp-summary{display:flex;align-items:center;gap:6px;padding:6px 10px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8);flex:0 0 auto;min-width:0}
[data-git-panel] .gp-summary-note{font-size:10px;opacity:.8}
[data-git-panel] .gp-summary-error{color:var(--dsw-alias-state-warn-primary,#b26a00)}
[data-git-panel] .gp-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 6px 16px}
[data-git-panel] .gp-group{margin-top:8px}
[data-git-panel] .gp-group-head{display:flex;align-items:center;gap:6px;padding:2px 4px 4px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c6066);min-width:0}
[data-git-panel] .gp-group-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-git-panel] .gp-group-count{display:inline-grid;place-items:center;min-width:16px;height:16px;padding:0 4px;border-radius:5px;background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.14));font-size:10px;font-weight:500;color:var(--dsw-alias-label-tertiary,#adb2b8)}
[data-git-panel] .gp-group-stats{margin-left:auto;display:flex;gap:5px;font-weight:400;font-size:10px;font-variant-numeric:tabular-nums}
[data-git-panel] .gp-file{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:6px;width:100%;min-height:26px;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
[data-git-panel] .gp-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
[data-git-panel] .gp-file:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176f5);outline-offset:-2px}
[data-git-panel] .gp-badge{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:4px;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--gp-badge-fg,#7b8087);background:var(--gp-badge-bg,rgba(128,128,128,.14))}
[data-git-panel] .gp-badge[data-kind="added"]{--gp-badge-fg:var(--dsw-alias-state-success-primary,#2e7d32);--gp-badge-bg:var(--dsw-alias-code-diff-added,rgba(46,125,50,.14))}
[data-git-panel] .gp-badge[data-kind="deleted"]{--gp-badge-fg:var(--dsw-alias-state-error-primary,#d33);--gp-badge-bg:var(--dsw-alias-code-diff-deleted,rgba(211,47,47,.13))}
[data-git-panel] .gp-badge[data-kind="modified"]{--gp-badge-fg:var(--dsw-alias-state-warn-primary,#b26a00);--gp-badge-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 15%,transparent)}
[data-git-panel] .gp-badge[data-kind="renamed"]{--gp-badge-fg:var(--dsw-alias-brand-primary,#4176f5);--gp-badge-bg:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176f5) 13%,transparent)}
[data-git-panel] .gp-badge[data-kind="conflict"]{--gp-badge-fg:var(--dsw-alias-state-error-primary,#d33);--gp-badge-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 16%,transparent)}
[data-git-panel] .gp-path{display:flex;min-width:0;overflow:hidden;white-space:nowrap;font-size:12px}
[data-git-panel] .gp-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#adb2b8)}
[data-git-panel] .gp-base{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#14181f)}
[data-git-panel] .gp-counts{display:flex;gap:4px;flex:0 0 auto;font:10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
[data-git-panel] .gp-add{color:var(--dsw-alias-state-success-primary,#2e7d32)}
[data-git-panel] .gp-del{color:var(--dsw-alias-state-error-primary,#d33)}
[data-git-panel] .gp-binary{flex:0 0 auto;font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-tertiary,#adb2b8)}
[data-git-panel] .gp-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:48px 16px;color:var(--dsw-alias-label-tertiary,#adb2b8);text-align:center;font-size:12px}
[data-git-panel] .gp-empty-grow{flex:1;justify-content:center}
[data-git-panel] .gp-picker{display:flex;flex-direction:column;height:100%;min-height:0;padding:10px 8px 0}
[data-git-panel] .gp-picker-head{display:flex;align-items:center;gap:8px;padding:0 2px}
[data-git-panel] .gp-picker-title{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#14181f)}
[data-git-panel] .gp-picker-cwd{padding:2px 2px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-git-panel] .gp-picker-note{margin:0 2px 6px;padding:4px 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 10%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b26a00));font-size:10px;line-height:1.4}
[data-git-panel] .gp-picker-body{display:flex;flex-direction:column;flex:1;min-height:0}
[data-git-panel] .gp-filter{width:100%;height:26px;margin:0 0 6px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#14181f);font:inherit;font-size:12px;outline:none}
[data-git-panel] .gp-filter:focus{border-color:var(--dsw-alias-brand-primary,#4176f5);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4176f5) 18%,transparent)}
[data-git-panel] .gp-repo-list{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;gap:1px;padding:0 2px 12px}
[data-git-panel] .gp-repo{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:6px;width:100%;padding:5px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
[data-git-panel] .gp-repo:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
[data-git-panel] .gp-repo:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176f5);outline-offset:-2px}
[data-git-panel] .gp-repo-icon{display:inline-grid;place-items:center;color:var(--dsw-alias-label-tertiary,#adb2b8)}
[data-git-panel] .gp-repo-text{display:flex;flex-direction:column;min-width:0}
[data-git-panel] .gp-repo-name{font-size:12px;color:var(--dsw-alias-label-primary,#14181f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-git-panel] .gp-repo-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-git-panel] .gp-empty strong{color:var(--dsw-alias-label-secondary,#5c6066);font-weight:600;font-size:12px}
[data-git-panel] .gp-mono{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
[data-git-panel] .gp-notice{padding:18px 12px;color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:12px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}
[data-git-panel] .gp-notice-inline{padding:4px 10px;text-align:left;align-items:flex-start;font-size:10px;position:sticky;top:0;background:var(--dsw-alias-bg-base,#fff);z-index:1}
[data-git-panel] .gp-text-btn{border:0;background:transparent;color:var(--dsw-alias-link,#4176f5);font:inherit;font-size:12px;padding:2px 6px;border-radius:5px;cursor:pointer}
[data-git-panel] .gp-text-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
[data-git-panel] .gp-detail{display:flex;flex-direction:column;height:100%;min-height:0}
[data-git-panel] .gp-detail-head{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));flex:0 0 auto;min-width:0}
[data-git-panel] .gp-detail-path{flex:1;min-width:0;display:flex;overflow:hidden;white-space:nowrap;font-size:12px;font-weight:600}
[data-git-panel] .gp-detail-side{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
[data-git-panel] .gp-detail-meta{display:flex;align-items:center;gap:8px;padding:4px 12px 6px;font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);flex:0 0 auto;min-width:0}
[data-git-panel] .gp-detail-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-git-panel] .gp-diff{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding-bottom:12px}
[data-git-panel] .gp-hunk-head{position:sticky;top:0;z-index:1;padding:3px 10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176f5) 9%,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:10.5px;white-space:pre;overflow:hidden;text-overflow:ellipsis}
[data-git-panel] .gp-line{display:grid;grid-template-columns:3.4em 3.4em minmax(0,1fr);align-items:start;padding-right:8px;min-width:max-content}
[data-git-panel] .gp-ln{padding-right:6px;text-align:right;color:var(--dsw-alias-label-tertiary,#adb2b8);user-select:none;font-variant-numeric:tabular-nums;font-size:10.5px;line-height:1.7}
[data-git-panel] .gp-code{padding-left:8px;white-space:pre;color:var(--dsw-alias-label-secondary,#5c6066)}
[data-git-panel] .gp-line-add{background:var(--dsw-alias-code-diff-added,rgba(46,125,50,.1))}
[data-git-panel] .gp-line-add .gp-code{color:var(--dsw-alias-state-success-primary,#2e7d32)}
[data-git-panel] .gp-line-del{background:var(--dsw-alias-code-diff-deleted,rgba(211,47,47,.09))}
[data-git-panel] .gp-line-del .gp-code{color:var(--dsw-alias-state-error-primary,#d33)}
@media (prefers-reduced-motion: reduce){[data-git-panel] *{scroll-behavior:auto}}
`;

    /**
     * 挂一份样式表；HMR 时先前的副本还在就不重复挂。
     * @returns {() => void} disposer。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/git-panel';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    /**
     * 静态的 tab 类型声明。
     * @returns {object} 类型定义。
     */
    function definition() {
      return {
        id: ID,
        kind: KIND,
        keepMounted: true,
        title: () => 'Git',
        guide: [
          {
            id: 'git',
            order: 30,
            title: () => 'Git 改动',
            description: () => '查看未提交的文件与差异',
            icon: GitGuideIcon,
          },
        ],
      };
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      /** 供单测直接调用的内部件；席位与宿主都不读它。 */
      internals: { definition, groupsOf, splitPath, letterOf, kindOf, branchLabelOf, DiffBody, FileGroup, RepoPicker, GitBody },
      apply(ctx) {
        ctx.effect(() => ensureStyle(), 'git-panel: styles');
        ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'git-panel: tab type');
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, GitBody),
            ),
          'git-panel: tab body',
        );
      },
    };
  },
});
