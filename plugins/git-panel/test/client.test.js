import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

/**
 * 在 VM 里加载客户端 bundle，返回 factory 的导出与 React mock。
 *
 * 浏览器里由 `__ModuleLoader__` 提供 factory；这里只实现同一条入口，避免为了
 * 一个组件引入 React/dom 测试工具。
 * @returns {{ exports: object, react: object }} 导出与 React 替身。
 */
function loadClient() {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  let exports;
  const react = {
    /** 与 React.createElement 同形的轻量节点。 */
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) };
    },
    /** 单次渲染只取初始值；状态更新留给浏览器。 */
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    /** 每次渲染一个独立 ref。 */
    useRef(initial) {
      return { current: initial };
    },
    /** 渲染测试不跑副作用。 */
    useEffect() {},
  };
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
    head: { appendChild() {} },
  };
  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        exports = factory((id) => {
          if (id === "react") return react;
          throw new Error(`unexpected module ${id}`);
        });
      },
    },
  };
  vm.runInNewContext(source, { window, document, console, URLSearchParams, fetch: async () => {} });
  return { exports, react };
}

/**
 * 收集节点树里的文本。
 * @param {unknown} node - 节点。
 * @returns {string} 文本。
 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    // 组件节点先渲染成元素节点；组件内部不使用 hook 才这样递归。
    if (typeof node.type === "function") return textOf(node.type(node.props));
    if (Array.isArray(node.children)) return textOf(node.children);
  }
  return "";
}

test("apply 注册 Git 页面类型、引导入口与正文", () => {
  const { exports } = loadClient();
  assert.deepEqual(Array.from(exports.inject), ["slots", "sidebarRightTabs"]);

  const types = [];
  const bodies = [];
  const ctx = {
    effect(callback) {
      const dispose = callback();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    sidebarRightTabs: {
      register(definition) {
        types.push(definition);
        return () => {};
      },
    },
    slots: {
      inject(_name, callback) {
        return callback();
      },
      register(meta, component) {
        bodies.push({ meta, component });
        return () => {};
      },
    },
  };

  exports.apply(ctx);
  assert.equal(types.length, 1);
  assert.equal(types[0].id, "@local/git-panel");
  assert.equal(types[0].kind, "git");
  assert.equal(types[0].title(), "Git");
  assert.equal(types[0].guide[0].title(), "Git 改动");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].meta.name, "sidebar.right.pane.tab");
  assert.equal(bodies[0].meta.key, "@local/git-panel");
  assert.equal(typeof bodies[0].component, "function");
});

test("groupsOf 把文件拆成冲突/已暂存/未暂存/未跟踪", () => {
  const { exports } = loadClient();
  const groups = exports.internals.groupsOf({
    files: [
      { path: "a.txt", x: "M", y: "M", conflict: false, untracked: false, staged: {}, unstaged: {} },
      { path: "b.txt", x: "A", y: " ", conflict: false, untracked: false, staged: {}, unstaged: null },
      { path: "c.txt", x: "??", y: "??", conflict: false, untracked: true, staged: null, unstaged: {} },
      { path: "d.txt", x: "UU", y: "UU", conflict: true, untracked: false, staged: null, unstaged: null },
      { path: "e.txt", x: " ", y: "D", conflict: false, untracked: false, staged: null, unstaged: {} },
    ],
  });
  assert.deepEqual(Array.from(groups, (group) => group.id), ["conflict", "staged", "unstaged", "untracked"]);
  assert.equal(groups[1].items.length, 2);
  assert.equal(groups[2].items.length, 2);
  assert.equal(groups[3].items.length, 1);
});

test("路径与状态字母按侧计算", () => {
  const { exports } = loadClient();
  const path = exports.internals.splitPath("src/client/a.ts");
  assert.equal(path.dir, "src/client/");
  assert.equal(path.base, "a.ts");
  const rootFile = exports.internals.splitPath("README.md");
  assert.equal(rootFile.dir, "");
  assert.equal(rootFile.base, "README.md");
  const file = { x: "R", y: "M", conflict: false, untracked: false };
  assert.equal(exports.internals.letterOf(file, "staged"), "R");
  assert.equal(exports.internals.letterOf(file, "unstaged"), "M");
  assert.equal(exports.internals.kindOf(file, "staged"), "renamed");
  assert.equal(exports.internals.kindOf(file, "unstaged"), "modified");
});

test("FileGroup 渲染文件行与合计", () => {
  const { exports } = loadClient();
  const group = {
    id: "staged",
    title: "已暂存",
    side: "staged",
    items: [
      {
        path: "src/a.ts",
        x: "M",
        y: " ",
        conflict: false,
        untracked: false,
        staged: { additions: 3, deletions: 2, binary: false },
        unstaged: null,
      },
    ],
  };
  const tree = exports.internals.FileGroup({ group, onOpen: () => {} });
  const text = textOf(tree);
  assert.match(text, /已暂存/);
  assert.match(text, /src\//);
  assert.match(text, /a\.ts/);
  assert.match(text, /\+3/);
  assert.match(text, /−2/);
  assert.equal(tree.type, "section");
});

test("DiffBody 渲染 hunk 头、行号与增删行", () => {
  const { exports } = loadClient();
  const tree = exports.internals.DiffBody({
    state: {
      loading: false,
      error: null,
      data: {
        binary: false,
        oversized: false,
        conflict: false,
        truncated: false,
        additions: 1,
        deletions: 1,
        hunks: [
          {
            header: "@@ -1,2 +1,2 @@",
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              { type: " ", text: "same", oldNo: 1, newNo: 1 },
              { type: "-", text: "old", oldNo: 2, newNo: null },
              { type: "+", text: "new", oldNo: null, newNo: 2 },
            ],
          },
        ],
      },
    },
    onRetry: () => {},
  });
  const text = textOf(tree);
  assert.match(text, /@@ -1,2 \+1,2 @@/);
  assert.match(text, /-old/);
  assert.match(text, /\+new/);
  assert.match(text, /same/);
});

test("branchLabelOf 区分空仓库、分离头与普通分支", () => {
  const { exports } = loadClient();
  assert.equal(exports.internals.branchLabelOf({ name: "main", detached: false, empty: false }), "main");
  assert.equal(exports.internals.branchLabelOf({ name: "", detached: true, empty: false, sha: "abc1234" }), "detached@abc1234");
  assert.equal(exports.internals.branchLabelOf({ name: "", detached: true, empty: false, sha: "" }), "detached HEAD");
  assert.equal(exports.internals.branchLabelOf({ name: "main", detached: false, empty: true }), "空仓库（无提交）");
});

test("DiffBody 对 multiFile 给出说明", () => {
  const { exports } = loadClient();
  const text = textOf(
    exports.internals.DiffBody({
      state: {
        loading: false,
        error: null,
        data: { binary: false, oversized: false, conflict: false, multiFile: true, hunks: [] },
      },
      onRetry: () => {},
    }),
  );
  assert.match(text, /多段差异/);
});

test("DiffBody 对二进制与冲突给出说明", () => {
  const { exports } = loadClient();
  const binary = textOf(
    exports.internals.DiffBody({
      state: { loading: false, error: null, data: { binary: true } },
      onRetry: () => {},
    }),
  );
  assert.match(binary, /二进制/);
  const conflict = textOf(
    exports.internals.DiffBody({
      state: { loading: false, error: null, data: { binary: false, conflict: true } },
      onRetry: () => {},
    }),
  );
  assert.match(conflict, /合并冲突/);
});

test("RepoPicker 按输入过滤并列出相对路径", () => {
  const { exports } = loadClient();
  const state = {
    loading: false,
    error: null,
    truncated: false,
    list: [
      { path: "SpatialQuery", name: "SpatialQuery" },
      { path: "xmzhyp/backend", name: "backend" },
      { path: "xmzhyp/frontend", name: "frontend" },
    ],
  };
  const tree = exports.internals.RepoPicker({
    cwd: "D:/Programming",
    state,
    filter: "xmzhyp",
    onFilter: () => {},
    onSelect: () => {},
    onRefresh: () => {},
    onCancel: null,
  });
  const text = textOf(tree);
  assert.match(text, /选择 Git 仓库/);
  assert.match(text, /xmzhyp\/backend/);
  assert.match(text, /frontend/);
  assert.doesNotMatch(text, /SpatialQuery/);
});

test("未加载时 GitBody 渲染读取中状态", () => {
  const { exports } = loadClient();
  const tree = exports.internals.GitBody({
    sessionId: "session-1",
    useSessions: (selector) => selector({ byId: { "session-1": { cwd: "D:/repo" } } }),
    useTabInfo: () => ({ tab: { visible: true, actions: { bindCommands: () => () => {} } } }),
  });
  assert.match(textOf(tree), /读取 Git 状态/);
});

test("ViewSwitch 把两个视图画成 tab 并标出当前选中", () => {
  const { exports } = loadClient();
  const tree = exports.internals.ViewSwitch({ view: "history", onChange: () => {} });
  assert.equal(tree.props.role, "tablist");
  const buttons = tree.children.filter((child) => child.type === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].props["aria-selected"], false);
  assert.equal(buttons[1].props["aria-selected"], true);
  assert.match(textOf(buttons[1]), /历史/);
});

test("BranchPicker 按分组列出分支并按输入过滤", () => {
  const { exports } = loadClient();
  const state = {
    loading: false,
    error: null,
    data: {
      current: { name: "feat/git-panel-sidebar", detached: false },
      branches: [
        { kind: "local", name: "feat/git-panel-sidebar", time: 1700000000 },
        { kind: "local", name: "main", time: 1700000100 },
        { kind: "remote", name: "origin/main", time: 1700000100 },
      ],
      truncated: false,
    },
  };
  const tree = exports.internals.BranchPicker({
    state,
    filter: "feat",
    onFilter: () => {},
    selected: "feat/git-panel-sidebar",
    onSelect: () => {},
    onClose: () => {},
  });
  const text = textOf(tree);
  assert.match(text, /选择分支/);
  assert.match(text, /本地分支/);
  assert.match(text, /feat\/git-panel-sidebar/);
  assert.doesNotMatch(text, /origin\/main/);
});

test("BranchPicker 无匹配时给出提示", () => {
  const { exports } = loadClient();
  const tree = exports.internals.BranchPicker({
    state: {
      loading: false,
      error: null,
      data: { current: null, branches: [{ kind: "local", name: "main", time: 0 }], truncated: false },
    },
    filter: "zzz",
    onFilter: () => {},
    selected: null,
    onSelect: () => {},
    onClose: () => {},
  });
  assert.match(textOf(tree), /没有匹配的分支/);
});

test("CommitRow 渲染短 hash、标题与作者，展开后显示详情", () => {
  const { exports } = loadClient();
  const commit = {
    sha: "0a36669625924b469d1a8ae1bea7320e6c3d92eb",
    shortSha: "0a36669",
    author: "autod",
    time: 1700000000,
    parents: ["5387b99"],
    refs: ["HEAD -> main"],
    subject: "plugin(git-panel): 增加历史视图",
    body: "第一行\n第二行",
    bodyTruncated: false,
  };
  const collapsed = textOf(exports.internals.CommitRow({ commit, expanded: false, onToggle: () => {} }));
  assert.match(collapsed, /0a36669/);
  assert.match(collapsed, /增加历史视图/);
  assert.match(collapsed, /autod/);
  assert.doesNotMatch(collapsed, /父提交/);

  const expanded = textOf(exports.internals.CommitRow({ commit, expanded: true, onToggle: () => {} }));
  assert.match(expanded, /父提交/);
  assert.match(expanded, /5387b99/);
  assert.match(expanded, /第一行/);
  assert.match(expanded, /HEAD -> main/);
});

test("HistoryView 空仓库与有提交两种状态", () => {
  const { exports } = loadClient();
  const base = {
    selected: null,
    picker: false,
    filter: "",
    onFilter: () => {},
    onOpen: () => {},
    onClose: () => {},
    onSelect: () => {},
    onLoadMore: () => {},
    onRetry: () => {},
    onExpand: () => {},
    expandedSha: null,
    buttonRef: { current: null },
    commits: { items: [], hasMore: false, loading: false, error: null, pageError: null },
  };

  const empty = textOf(
    exports.internals.HistoryView({
      ...base,
      state: { loading: false, error: null, data: { current: null, branches: [], truncated: false } },
    }),
  );
  assert.match(empty, /空仓库（无提交）/);

  const filled = textOf(
    exports.internals.HistoryView({
      ...base,
      selected: "main",
      state: {
        loading: false,
        error: null,
        data: {
          current: { name: "main", detached: false },
          branches: [{ kind: "local", name: "main", time: 1700000000, upstream: "origin/main" }],
          truncated: false,
        },
      },
      commits: {
        items: [
          {
            sha: "abc1234def",
            shortSha: "abc1234",
            author: "autod",
            time: 1700000000,
            parents: [],
            refs: [],
            subject: "首个提交",
            body: "",
            bodyTruncated: false,
          },
        ],
        hasMore: true,
        loading: false,
        error: null,
        pageError: null,
      },
    }),
  );
  assert.match(filled, /main/);
  assert.match(filled, /首个提交/);
  assert.match(filled, /加载更多/);
});

test("HistoryView 读取失败时给出重试", () => {
  const { exports } = loadClient();
  const text = textOf(
    exports.internals.HistoryView({
      state: { loading: false, error: new Error("读取失败"), data: null },
      commits: { items: [], hasMore: false, loading: false, error: null, pageError: null },
      selected: null,
      picker: false,
      filter: "",
      onFilter: () => {},
      onOpen: () => {},
      onClose: () => {},
      onSelect: () => {},
      onLoadMore: () => {},
      onRetry: () => {},
      onExpand: () => {},
      expandedSha: null,
      buttonRef: { current: null },
    }),
  );
  assert.match(text, /重试/);
});

test("relativeTime 与 absoluteTime 的时间格式", () => {
  const { exports } = loadClient();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(exports.internals.relativeTime(now - 5), "刚刚");
  assert.equal(exports.internals.relativeTime(now - 120), "2 分钟前");
  assert.equal(exports.internals.relativeTime(now - 7200), "2 小时前");
  assert.equal(exports.internals.relativeTime(now - 3 * 86400), "3 天前");
  assert.match(exports.internals.relativeTime(1700000000), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(exports.internals.absoluteTime(1700000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(exports.internals.relativeTime(0), "");
});

/**
 * 有状态的最小 React 替身 + 渲染器：让 GitBody 的 effect/状态机能被真正驱动，
 * 而不是只渲染一次静态树（否则重复追加、重试无效这类 bug 测不出来）。
 * @param {Function} fetchImpl - fetch 替身。
 * @returns {{ exports: object, settle: Function, click: Function, text: Function, calls: string[], refresh: Function }}
 */
function mountPanel(fetchImpl) {
  const calls = [];
  const commands = {};
  const states = new Map();
  let currentKey = null;
  let hookIndex = 0;
  let dirty = false;
  let pending = [];
  let tree = null;

  const storeOf = (key) => {
    if (!states.has(key)) states.set(key, { hooks: [] });
    return states.get(key);
  };

  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      };
    },
    useState(initial) {
      const store = storeOf(currentKey);
      const slot = hookIndex++;
      if (store.hooks[slot] === undefined) {
        store.hooks[slot] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const cell = store.hooks[slot];
      return [
        cell.value,
        (next) => {
          const value = typeof next === 'function' ? next(cell.value) : next;
          if (Object.is(value, cell.value)) return;
          cell.value = value;
          dirty = true;
        },
      ];
    },
    useRef(initial) {
      const store = storeOf(currentKey);
      const slot = hookIndex++;
      if (store.hooks[slot] === undefined) store.hooks[slot] = { current: initial };
      return store.hooks[slot];
    },
    useEffect(fn, deps) {
      const store = storeOf(currentKey);
      const slot = hookIndex++;
      if (store.hooks[slot] === undefined) store.hooks[slot] = { deps: undefined, cleanup: undefined };
      const cell = store.hooks[slot];
      const changed =
        cell.deps === undefined ||
        deps === undefined ||
        deps.length !== cell.deps.length ||
        deps.some((value, index) => !Object.is(value, cell.deps[index]));
      if (!changed) return;
      cell.deps = deps === undefined ? undefined : [...deps];
      pending.push(() => {
        if (typeof cell.cleanup === 'function') cell.cleanup();
        const result = fn();
        cell.cleanup = typeof result === 'function' ? result : undefined;
      });
    },
  };

  const renderNode = (node) => {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (typeof node.type === 'function') {
      const previousKey = currentKey;
      const previousIndex = hookIndex;
      currentKey = node.type;
      hookIndex = 0;
      const output = node.type(node.props ?? {});
      currentKey = previousKey;
      hookIndex = previousIndex;
      return renderNode(output);
    }
    return {
      type: node.type,
      props: node.props ?? {},
      children: (node.children ?? []).map(renderNode).filter((child) => child !== null),
    };
  };

  const textOfNode = (node) => {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOfNode).join('');
    return node.children.map(textOfNode).join('');
  };

  const findButton = (node, label) => {
    if (node === null || typeof node === 'string') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findButton(child, label);
        if (found !== null) return found;
      }
      return null;
    }
    if (node.type === 'button' && textOfNode(node).includes(label)) return node;
    for (const child of node.children) {
      const found = findButton(child, label);
      if (found !== null) return found;
    }
    return null;
  };

  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        exports = factory((id) => {
          if (id === 'react') return react;
          throw new Error(`unexpected module ${id}`);
        });
      },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const tab = {
    visible: true,
    actions: {
      bindCommands(handlers) {
        Object.assign(commands, handlers);
        return () => {};
      },
    },
  };
  let exports;

  vm.runInNewContext(readFileSync(new URL("../client.js", import.meta.url), 'utf8'), {
    window,
    document,
    console,
    URLSearchParams,
    fetch: (url, options) => {
      calls.push(String(url));
      return fetchImpl(String(url), options);
    },
    AbortController,
    setTimeout,
    clearTimeout,
  });

  const element = () =>
    react.createElement(exports.internals.GitBody, {
      sessionId: 'session-1',
      useSessions: (selector) => selector({ byId: { 'session-1': { cwd: 'D:/repo' } } }),
      useTabInfo: () => ({ tab }),
    });

  const settle = async () => {
    for (let round = 0; round < 25; round += 1) {
      dirty = false;
      pending = [];
      tree = renderNode(element());
      for (const effect of pending) effect();
      pending = [];
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) return;
    }
  };

  return {
    exports,
    calls,
    settle,
    text: () => textOfNode(tree),
    click: (label) => {
      const button = findButton(tree, label);
      if (button === null) throw new Error(`没有找到按钮：${label}`);
      button.props.onClick?.({ preventDefault() {} });
    },
    refresh: () => commands.refresh(),
    /**
     * 按 className 找渲染树里的第一个宿主节点。
     * @param {string} className - 片段。
     * @returns {object | null} 节点。
     */
    find: (className) => {
      const walk = (node) => {
        if (node === null || typeof node === 'string') return null;
        if (Array.isArray(node)) {
          for (const child of node) {
            const found = walk(child);
            if (found !== null) return found;
          }
          return null;
        }
        if (typeof node.props?.className === 'string' && node.props.className.includes(className)) return node;
        for (const child of node.children) {
          const found = walk(child);
          if (found !== null) return found;
        }
        return null;
      };
      return walk(tree);
    },
  };
}

/**
 * 造一个 JSON 响应替身。
 * @param {object} body - 响应体。
 * @param {number} [status] - 状态码。
 * @returns {object} 响应。
 */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * 生成第 index 个提交。
 * @param {number} index - 序号。
 * @returns {object} 提交。
 */
function commitAt(index) {
  return {
    sha: `sha-${index}`,
    shortSha: `s${index}`,
    author: 'autod',
    time: 1700000000 + index,
    parents: [],
    refs: [],
    subject: `提交 ${index}`,
    body: '',
    bodyTruncated: false,
  };
}

/**
 * 造一个按 skip 分页的 commits 响应。
 * @param {string} url - 请求地址。
 * @param {number} total - 总提交数。
 * @returns {object} 响应。
 */
function commitsResponse(url, total) {
  const search = new URLSearchParams(url.split('?')[1] ?? '');
  const skip = Number(search.get('skip') ?? 0);
  const page = [];
  for (let index = skip; index < Math.min(skip + 50, total); index += 1) page.push(commitAt(index));
  return jsonResponse({ ok: true, branch: 'master', skip, limit: 50, commits: page, hasMore: skip + page.length < total });
}

test("GitBody 切到历史视图会拉分支与提交，并渲染提交行", async () => {
  const panel = mountPanel(async (url) => {
    if (url.startsWith('/git-panel/status')) {
      return jsonResponse({ ok: true, isRepo: true, repo: 'r', root: 'D:/repo', total: 0, truncated: false, branch: { name: 'master', detached: false, empty: false, ahead: 0, behind: 0 }, files: [] });
    }
    if (url.startsWith('/git-panel/branches')) {
      return jsonResponse({ ok: true, root: 'D:/repo', current: { name: 'master', detached: false, sha: 'sha-0' }, branches: [{ kind: 'local', name: 'master', current: true, time: 1700000000, upstream: null }], truncated: false });
    }
    if (url.startsWith('/git-panel/commits')) return commitsResponse(url, 120);
    throw new Error(`unexpected ${url}`);
  });

  await panel.settle();
  assert.match(panel.text(), /工作区干净/);
  panel.click('历史');
  await panel.settle();

  const text = panel.text();
  assert.match(text, /提交 0/);
  assert.match(text, /加载更多/);
  assert.equal(panel.calls.filter((url) => url.startsWith('/git-panel/commits')).length, 1);
});

test("加载更多追加下一页，刷新后从第一页重来且不重复", async () => {
  const panel = mountPanel(async (url) => {
    if (url.startsWith('/git-panel/status')) {
      return jsonResponse({ ok: true, isRepo: true, repo: 'r', root: 'D:/repo', total: 0, truncated: false, branch: { name: 'master', detached: false, empty: false, ahead: 0, behind: 0 }, files: [] });
    }
    if (url.startsWith('/git-panel/branches')) {
      return jsonResponse({ ok: true, root: 'D:/repo', current: { name: 'master', detached: false, sha: 'sha-0' }, branches: [{ kind: 'local', name: 'master', current: true, time: 1700000000, upstream: null }], truncated: false });
    }
    return commitsResponse(url, 120);
  });

  await panel.settle();
  panel.click('历史');
  await panel.settle();
  panel.click('加载更多');
  await panel.settle();
  assert.match(panel.text(), /提交 99/);

  panel.refresh();
  await panel.settle();
  const text = panel.text();
  assert.match(text, /提交 49/);
  // 刷新回到第一页：正好 50 条、没有重复行。
  const subjects = text.match(/提交 \d+/g) ?? [];
  assert.equal(subjects.length, 50);
  assert.equal(new Set(subjects).size, subjects.length);
});

test("加载更多失败后点重试会重新请求并追加", async () => {
  let failing = true;
  const panel = mountPanel(async (url) => {
    if (url.startsWith('/git-panel/status')) {
      return jsonResponse({ ok: true, isRepo: true, repo: 'r', root: 'D:/repo', total: 0, truncated: false, branch: { name: 'master', detached: false, empty: false, ahead: 0, behind: 0 }, files: [] });
    }
    if (url.startsWith('/git-panel/branches')) {
      return jsonResponse({ ok: true, root: 'D:/repo', current: { name: 'master', detached: false, sha: 'sha-0' }, branches: [{ kind: 'local', name: 'master', current: true, time: 1700000000, upstream: null }], truncated: false });
    }
    if (failing && url.includes('skip=50')) return jsonResponse({ ok: false, error: 'git-failed' }, 500);
    return commitsResponse(url, 120);
  });

  await panel.settle();
  panel.click('历史');
  await panel.settle();
  panel.click('加载更多');
  await panel.settle();
  assert.match(panel.text(), /重试/);

  failing = false;
  panel.click('重试');
  await panel.settle();
  assert.match(panel.text(), /提交 99/);
});

test("分支浮层支持键盘选择，并标出当前分支", async () => {
  const requests = [];
  const panel = mountPanel(async (url) => {
    requests.push(url);
    if (url.startsWith('/git-panel/status')) {
      return jsonResponse({ ok: true, isRepo: true, repo: 'r', root: 'D:/repo', total: 0, truncated: false, branch: { name: 'master', detached: false, empty: false, ahead: 0, behind: 0 }, files: [] });
    }
    if (url.startsWith('/git-panel/branches')) {
      return jsonResponse({
        ok: true,
        root: 'D:/repo',
        current: { name: 'master', detached: false, sha: 'sha-0' },
        branches: [
          { kind: 'local', name: 'master', current: true, time: 1700000000, upstream: null },
          { kind: 'local', name: 'release', current: false, time: 1700000100, upstream: null },
        ],
        truncated: false,
      });
    }
    return commitsResponse(url, 5);
  });

  await panel.settle();
  panel.click('历史');
  await panel.settle();
  panel.click('master');
  await panel.settle();

  assert.match(panel.text(), /当前/);
  const dialog = panel.find('gp-branch-pop');
  assert.ok(dialog !== null, '浮层应已打开');

  dialog.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  await panel.settle();
  panel.find('gp-branch-pop').props.onKeyDown({ key: 'Enter', preventDefault() {} });
  await panel.settle();

  assert.match(panel.text(), /release/);
  assert.ok(requests.some((url) => url.includes('branch=release')));
});

test("已有数据时刷新失败会显示内联错误条并保留旧内容", () => {
  const { exports } = loadClient();
  const commit = {
    sha: 'abc1234',
    shortSha: 'abc1234',
    author: 'autod',
    time: 1700000000,
    parents: [],
    refs: [],
    subject: '旧提交',
    body: '',
    bodyTruncated: false,
  };
  const base = {
    selected: 'main',
    picker: false,
    filter: '',
    onFilter: () => {},
    onOpen: () => {},
    onClose: () => {},
    onSelect: () => {},
    onLoadMore: () => {},
    onRetry: () => {},
    onExpand: () => {},
    expandedSha: null,
    buttonRef: { current: null },
  };
  const tree = exports.internals.HistoryView({
    ...base,
    state: {
      loading: false,
      error: new Error('读取失败'),
      data: { current: { name: 'main', detached: false }, branches: [{ kind: 'local', name: 'main', time: 1700000000, upstream: null }], truncated: false },
    },
    commits: { items: [commit], hasMore: false, loading: false, error: new Error('网络失败'), pageError: null },
  });
  const text = textOf(tree);
  assert.match(text, /读取失败/);
  assert.match(text, /网络失败/);
  assert.match(text, /重试/);
  assert.match(text, /旧提交/);
});
