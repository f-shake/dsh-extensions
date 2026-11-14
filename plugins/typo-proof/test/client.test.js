/**
 * 面板里那些纯函数。
 *
 * client.js 是浏览器模块（入口是 `window.__ModuleLoader__`），所以在 import 之前
 * 得把 window / document 与一个最小 React 摆好。这里只测不碰 DOM 的部分：
 * 状态规整、候选标识、演示数据源的状态机。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** 最小 React：createElement 建一棵能走的树，其余 hook 给空实现。 */
const FAKE_REACT = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  // 初始值按 initializer 真算：表单组件靠它拿 draft，返回 null 会直接崩。
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};

/**
 * 把元素树里的文字拼起来，用来断言「渲染出了什么」。
 * @param {any} node - 节点。
 * @returns {string} 文本。
 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const children = Array.isArray(node.children) ? node.children : [];
  return children.map(textOf).join("");
}

/**
 * 把树摊平成节点列表，用来找按钮、选项这类具体元素。
 * @param {any} node - 节点。
 * @param {object[]} [out] - 收集器。
 * @returns {object[]} 所有元素节点。
 */
function nodesOf(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) nodesOf(item, out);
    return out;
  }
  out.push(node);
  for (const child of node.children ?? []) nodesOf(child, out);
  return out;
}

globalThis.window = globalThis.window ?? {};
globalThis.window.__ModuleLoader__ = {
  load(module) {
    globalThis.__typoProofModule = module;
  },
};

/** 页面上已插入的样式节点：ensureStyle 靠它判断「要不要换内容」。 */
const styleNodes = new Map();

globalThis.document = {
  getElementById: (id) => styleNodes.get(id) ?? null,
  createElement(tag) {
    const node = { tagName: tag, style: {}, children: [], setAttribute() {}, select() {}, setSelectionRange() {} };
    let id = "";
    let text = "";
    Object.defineProperty(node, "id", {
      get: () => id,
      set: (value) => {
        id = value;
        styleNodes.set(value, node);
      },
    });
    Object.defineProperty(node, "textContent", {
      get: () => text,
      set: (value) => {
        text = value;
      },
    });
    Object.defineProperty(node, "value", { writable: true, value: "" });
    return node;
  },
  head: {
    appendChild(node) {
      if (node.id !== "") styleNodes.set(node.id, node);
    },
  },
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
};

await import("../client.js");
const plugin = globalThis.__typoProofModule.factory((name) => (name === "react" ? FAKE_REACT : undefined));
const { normalizeState, itemKey, viewOf, dirOf, copyPayload, ensureStyle } = plugin.__test;
const { ToolCard, SettingsForm, IssueRow } = plugin.__components;
// 合并后的候选长什么样、说明怎么拼，由宿主实现；卡片用例用它喂数据，避免两边各写一份。
const { toItems } = await import("../index.js");

test("client：工具卡片先判错误，失败的调用不能一直显示“正在检查”", () => {
  const failed = textOf(
    ToolCard({ phase: "result", block: { isError: true, content: [{ type: "text", text: "Error: 连不上本地模型" }] } }),
  );
  assert.match(failed, /错别字检查失败/);
  assert.match(failed, /连不上本地模型/);
  assert.doesNotMatch(failed, /正在检查/);

  const pending = textOf(ToolCard({ phase: "call" }));
  assert.match(pending, /正在检查/);

  // 成功结果但没 meta：既不能当成失败，也不能继续显示“正在检查”。
  const bare = textOf(ToolCard({ phase: "result", block: {} }));
  assert.match(bare, /没有结果/);
});

test("client：正文视图的选择——失败的任务要落在 error 上，不能是空白", () => {
  assert.equal(viewOf({ status: "done" }, null), "active");
  assert.equal(viewOf({ status: "running" }, null), "active");
  assert.equal(viewOf({ status: "idle" }, null), "idle");
  assert.equal(viewOf({ status: "error" }, null), "error");
  assert.equal(viewOf({ status: "loading" }, null), "loading");
  assert.equal(viewOf({}, null), "loading");
  assert.equal(viewOf({ status: "error" }, { message: "拿不到状态" }), "failure");
});

test("client：面板状态必须带着两个下载地址，否则按钮永远是灰的", () => {
  const state = normalizeState({
    status: "done",
    file: "2011~2014.docx",
    downloadUrl: "/typo-proof/download?job=job-1",
    csvUrl: "/typo-proof/csv?job=job-1",
    items: [{ seg: 12, state: "confirmed" }],
  });
  assert.equal(state.downloadUrl, "/typo-proof/download?job=job-1");
  assert.equal(state.csvUrl, "/typo-proof/csv?job=job-1");
  assert.equal(state.counts.confirmed, 1);
});

test("client：字段缺失或类型不对时退回安全值", () => {
  const state = normalizeState({ status: "wat", downloadUrl: 42, items: null, progress: null });
  assert.equal(state.status, "idle");
  assert.equal(state.downloadUrl, "");
  assert.deepEqual(state.items, []);
  assert.equal(state.progress.localTotal, 0);
  assert.equal(normalizeState(null).file, "");
});

test("client：同一段多条候选的 key 不会撞车", () => {
  const left = { id: "12:0:3:得", seg: 12, pos: 3 };
  const right = { id: "12:1:7:地", seg: 12, pos: 7 };
  assert.notEqual(itemKey(left), itemKey(right));
  assert.equal(itemKey(left), "12:0:3:得");
  // 没有 id 的老数据退回段号 + 位置。
  assert.equal(itemKey({ seg: 12, pos: 7 }), "12-7");
});

test("client：从文件路径取目录，不会把目录再切一层", () => {
  assert.equal(dirOf("C:\\a\\b\\2011.docx"), "C:\\a\\b");
  assert.equal(dirOf("C:/a/b/2011.docx"), "C:/a/b");
  assert.equal(dirOf("只有文件名.docx"), "");
  assert.equal(dirOf(""), "");
  // 「上一级」用的是 loadDir(parent)，不经这里——这里只吃文件路径。
  assert.equal(dirOf("C:\\a\\b"), "C:\\a", "目录当文件路径传进来会多切一层，所以目录必须走 loadDir");
});

test("client：设置表单带着当前值打开，保存时把数字真的转成数字", () => {
  const saved = [];
  const tree = SettingsForm({
    config: {
      file: "C:/日记/2011~2014.docx",
      localProvider: "lmstudio",
      localModel: "qwen3-4b",
      reviewProvider: "deepseek-official",
      reviewModel: "deepseek-flash",
      minHanzi: 9,
      samples: 3,
      concurrency: 4,
    },
    providers: [{ id: "lmstudio", models: ["qwen3-4b", "qwen3-8b"] }, { id: "deepseek-official", models: ["deepseek-flash"] }],
    error: "",
    saving: false,
    onSave: (patch) => saved.push(patch),
    onCancel: () => {},
  });

  const text = textOf(tree);
  assert.match(text, /采样 provider/);
  assert.match(text, /复核模型/);
  // 插件已经没有演示模式了，表单里不该再有这个开关。
  assert.doesNotMatch(text, /演示数据/);

  // 文件是一次运行的输入，不该出现在设置里。
  const inputs = nodesOf(tree).filter((node) => node.type === "input");
  const fileInput = inputs.find((node) => String(node.props.placeholder ?? "").includes("2011"));
  assert.equal(fileInput, undefined, "设置里不该再有 docx 路径输入框");
  const minHanzi = inputs.find((node) => node.props.type === "number" && node.props.value === "9");
  assert.ok(minHanzi !== undefined, "数字字段要带当前值");

  // 模型做成下拉：选项来自模型栏，用户不用手打。这里断言候选真的进了页面。
  const options = nodesOf(tree)
    .filter((node) => node.type === "option")
    .map((node) => node.props.value);
  assert.ok(options.includes("lmstudio"), "provider 要是下拉项");
  assert.ok(options.includes("qwen3-8b"), "模型要是下拉项");
  assert.ok(nodesOf(tree).some((node) => node.type === "select"), "要有 select，而不是让人手打");

  const save = nodesOf(tree).find((node) => node.type === "button" && textOf(node) === "保存");
  assert.ok(save !== undefined, "要有保存按钮");
  save.props.onClick();

  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    localProvider: "lmstudio",
    localModel: "qwen3-4b",
    reviewProvider: "deepseek-official",
    reviewModel: "deepseek-flash",
    minHanzi: 9,
    samples: 3,
    concurrency: 4,
  });
  // 数字字段必须是 number：传字符串过去服务端会当成非法值拒掉。
  assert.equal(typeof saved[0].minHanzi, "number");
});

test("client：设置保存失败时把原因显示在表单里", () => {
  const tree = SettingsForm({
    config: { file: "", minHanzi: 8, samples: 3, concurrency: 3 },
    providers: [],
    error: "minHanzi 要是不小于 1 的整数",
    saving: false,
    onSave: () => {},
    onCancel: () => {},
  });
  assert.match(textOf(tree), /minHanzi 要是不小于 1 的整数/);
});

/** 一条典型的候选：卡片用例都拿它当底。 */
const SAMPLE_ITEM = {
  id: "12:0:3:帖",
  seg: 13,
  prev: "那年冬天特别冷，我住在城西一间没有暖气的出租屋里，每天写字写得手指都僵了，暖气片一直是凉的。",
  original: "那时候我每天都要花四个小时在论坛上回复贴子。",
  corrected: "那时候我每天都要花四个小时在论坛上回复帖子。",
  next: "回完之后手指都僵了，但心里是热的，那点热乎劲儿够我撑过一整个冬天。",
  hits: 3,
  state: "confirmed",
  note: "三次采样都改成了“帖子”。",
  samples: ["那时候我每天都要花四个小时在论坛上回复帖子。", "那时候我每天都要花四个小时在论坛上回复贴子。", "那时候我每天都要花四个小时在论坛上回复帖子。"],
};

test("client：复制口分成原文、修改后、错字、正字四段", () => {
  assert.deepEqual(copyPayload(SAMPLE_ITEM), {
    original: "那时候我每天都要花四个小时在论坛上回复贴子。",
    corrected: "那时候我每天都要花四个小时在论坛上回复帖子。",
    wrong: "贴",
    right: "帖",
  });

  // 多字替换：错字/正字都要整段给全，不能只取第一个字。
  const long = copyPayload({ original: "他担误了时间。", corrected: "他耽误了时间。" });
  assert.equal(long.wrong, "担");
  assert.equal(long.right, "耽");

  // 没有改动时两段是空的：按钮要靠它变灰，别把空串塞进剪贴板。
  const same = copyPayload({ original: "一字不改。", corrected: "一字不改。" });
  assert.equal(same.wrong, "");
  assert.equal(same.right, "");

  // 字段缺失/类型不对不能抛：缺了 corrected 就不做 diff，别把整句当成「被删掉的字」。
  const broken = copyPayload({ original: "只有原文" });
  assert.equal(broken.original, "只有原文");
  assert.equal(broken.corrected, "");
  assert.equal(broken.wrong, "");
  assert.equal(broken.right, "");
});

test("client：候选卡片常开，四个复制按钮与内部折叠都在，前/后句不截断", () => {
  const tree = IssueRow({ item: SAMPLE_ITEM, samples: 3 });
  const text = textOf(tree);

  assert.match(text, /第 13 段/);
  assert.match(text, /3\/3/, "票数要一直看得见");
  assert.match(text, /已确认/);

  const labels = nodesOf(tree)
    .filter((node) => node.type === "button")
    .map((node) => textOf(node));
  assert.deepEqual(labels, ["复制原文", "复制修改后", "复制错字", "复制正字"], "四个按钮，顺序固定");

  // 卡片本体不再是一个折叠按钮：点开整卡的交互已经去掉了。
  assert.ok(!nodesOf(tree).some((node) => node.props["aria-expanded"] !== undefined), "整卡不该再有 aria-expanded");

  const details = nodesOf(tree).find((node) => node.type === "details");
  assert.ok(details !== undefined, "前/后与采样要收在卡片内部的折叠里");
  assert.equal(details.props.open, undefined, "内部折叠默认关，卡片本体常开");
  assert.match(textOf(details), /前\/后与 3 次采样/);

  // 前/后句给整句：之前按 40 字截断过，判断时被裁掉的恰好是要看的部分。
  assert.ok(text.includes(SAMPLE_ITEM.prev), "前一句要完整");
  assert.ok(text.includes(SAMPLE_ITEM.next), "后一句要完整");
  assert.match(text, /第1次/);
  assert.match(text, /第3次/);
  assert.match(text, /三次采样都改成了“帖子”。/, "复核说明要显示");
});

test("client：合并后的候选真的能走到卡片上——说明、票数与备选都来自同一条数据", () => {
  // 这里走的是真链路：pipeline 合并后的候选 → toItems → IssueRow，
  // 而不是直接把预期文案写进 note 再断言它显示出来（那等于什么都没测）。
  const [item] = toItems([
    {
      paraIndex: 806,
      sentenceIndex: 0,
      pos: 9,
      orig: "行",
      sugg: "算",
      votes: 2,
      changedVotes: 3,
      samples: ["早上妈妈走的时候就行了。"],
      context: { before: "前一句。", text: "早上妈妈走的时候就行了。", after: "后一句。" },
      review: { status: "redirected", suggestion: "醒", note: "复核模型也认为这里错，但改成“醒”" },
      alternatives: [{ sugg: "走", votes: 1, status: "rejected", suggestion: "" }],
    },
  ]);
  const tree = IssueRow({ item, samples: 3 });
  const text = textOf(tree);
  assert.match(text, /2\/3/, "票数用支持最终改法的票数，不是该处改动总数");
  assert.match(text, /复核模型也认为这里错，但改成“醒”；另有改法：走（已否决）/, "否决的备选要标出来，别让人照着改");
  const hits = nodesOf(tree).find((node) => node.props.className === 'tp-hits');
  assert.match(String(hits.props.title), /该处共 3 次采样改动过/, "总数藏到悬停里，不占版面");
});

test("client：否决项的错字/正字按钮禁用——那两个字的语义是反的", () => {
  const rejected = IssueRow({
    item: { ...SAMPLE_ITEM, state: "rejected", note: "复核认为这里不是错别字" },
    samples: 3,
  });
  const buttons = new Map(nodesOf(rejected).filter((node) => node.type === "button").map((node) => [textOf(node), node]));
  assert.equal(buttons.get("复制原文").props.disabled, false);
  assert.equal(buttons.get("复制修改后").props.disabled, false);
  assert.equal(buttons.get("复制错字").props.disabled, true, "否决项的「错字」其实是原文里那个对的字");
  assert.equal(buttons.get("复制正字").props.disabled, true, "否决项的「正字」是被复核否掉的字");
  assert.match(String(buttons.get("复制错字").props.title), /否决项没有可改正的字/);
});

test("client：没有错字/正字时按钮禁用，采样与原文一致时不重复贴整句", () => {
  const same = IssueRow({
    item: { ...SAMPLE_ITEM, corrected: SAMPLE_ITEM.original, samples: [SAMPLE_ITEM.original] },
    samples: 3,
  });
  const buttons = nodesOf(same).filter((node) => node.type === "button");
  const byLabel = new Map(buttons.map((node) => [textOf(node), node]));
  assert.equal(byLabel.get("复制原文").props.disabled, false);
  assert.equal(byLabel.get("复制修改后").props.disabled, false);
  assert.equal(byLabel.get("复制错字").props.disabled, true, "没有错字时不能点，点了是往剪贴板塞空串");
  assert.equal(byLabel.get("复制正字").props.disabled, true);
  assert.match(textOf(same), /与原文一致/, "采样与原文一致时不要重复贴整句");
});

test("client：点四个复制按钮，各自把对应那段交给剪贴板", async () => {
  const captured = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (value) => captured.push(value) } },
    configurable: true,
  });
  try {
    const tree = IssueRow({ item: SAMPLE_ITEM, samples: 3 });
    for (const button of nodesOf(tree).filter((node) => node.type === "button")) {
      button.props.onClick();
    }
    // copyText 是异步的：让它跑完两轮微任务再断言。
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(captured, [SAMPLE_ITEM.original, SAMPLE_ITEM.corrected, "贴", "帖"]);
  } finally {
    Object.defineProperty(globalThis, "navigator", original);
  }
});

test("client：样式表在插件重载后整份换掉，旧规则不会留在页面上", () => {
  // 模拟「上一次加载插进去的样式还在」：热重载时 ensureStyle 必须换内容而不是直接返回。
  styleNodes.set("typo-proof", { textContent: ".tp-old-rule{color:red}" });
  ensureStyle();
  const replaced = styleNodes.get("typo-proof").textContent;
  assert.match(replaced, /\.tp-copy-btn/, "新加的复制按钮样式要到位");
  assert.match(replaced, /\.tp-detail/, "内部折叠的样式要到位");
  assert.doesNotMatch(replaced, /\.tp-old-rule/, "旧规则要整份被替换掉");

  // 页面上什么都没有时，照旧插一份新的。
  styleNodes.clear();
  ensureStyle();
  assert.match(styleNodes.get("typo-proof").textContent, /\.tp-issue-body/);
});

