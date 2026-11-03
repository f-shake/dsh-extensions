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
