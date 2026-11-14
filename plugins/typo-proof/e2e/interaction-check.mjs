/**
 * 候选卡片的交互自检：真浏览器里点一遍，不是靠单测的假 DOM。
 *
 * 单测（test/client.test.js）验的是「渲染出什么」和「copyPayload 切出哪四段」，
 * 但按钮点下去到底有没有把字交给剪贴板、内部折叠点一下会不会开、卡片是不是真的常开，
 * 这些只有真 DOM 能给答案。这里用无头 Edge 跑一份最小页面，把结论写进 <title>。
 *
 * 用法：
 *   node e2e/interaction-check.mjs
 * 退出码 0 = 全过；非 0 = 有断言没过（会打出是哪一个）。
 *
 * 剪贴板只验到「路径走到、文字对」为止：无头浏览器没有用户手势，碰不到系统剪贴板，
 * 而这条路径本身也就是 textarea + execCommand。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const clientPath = join(pluginDir, 'client.js');
const outDir = join(here, '.preview');

/** 自检用的候选：页面里渲染的就是这一份，断言也用这一份，避免两边写两份字面量。 */
const ITEM = {
  id: '12:0:3:帖',
  seg: 13,
  prev: '那年冬天特别冷，我住在城西一间没有暖气的出租屋里。',
  original: '那时候我每天都要花四个小时在论坛上回复贴子。',
  corrected: '那时候我每天都要花四个小时在论坛上回复帖子。',
  next: '回完之后手指都僵了，但心里是热的。',
  hits: 3,
  state: 'confirmed',
  note: '三次采样都改成了“帖子”；另有改法：字',
  samples: [
    '那时候我每天都要花四个小时在论坛上回复帖子。',
    '那时候我每天都要花四个小时在论坛上回复贴子。',
    '那时候我每天都要花四个小时在论坛上回复帖子。',
  ],
};

/** 常见的 React 18 UMD 目录。 */
const REACT_CANDIDATES = [process.env.REACT_UMD_DIR, join(pluginDir, 'node_modules')].filter(
  (item) => typeof item === 'string' && item !== '',
);

/** 常见浏览器安装位置。 */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/**
 * 找一套 React 18 的 UMD 构建。
 * @returns {{ react: string, reactDom: string } | null} 两个绝对路径。
 */
function findReact() {
  for (const root of REACT_CANDIDATES) {
    const react = join(root, 'react', 'umd', 'react.production.min.js');
    const reactDom = join(root, 'react-dom', 'umd', 'react-dom.production.min.js');
    if (existsSync(react) && existsSync(reactDom)) return { react, reactDom };
  }
  return null;
}

/**
 * 生成并落盘自检页。
 * @param {{ react: string, reactDom: string }} react - React UMD 路径。
 * @returns {string} 页面绝对路径。
 */
function compose(react) {
  const toUrl = (path) => `file:///${path.replaceAll('\\', '/')}`;
  const source = readFileSync(clientPath, 'utf8');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>pending</title>
<style>body{margin:0;font:13px system-ui;background:#1b1c1f;color:#f2f3f5}#root{width:400px;padding:8px}
:root{--dsw-alias-label-primary:#f2f3f5;--dsw-alias-label-secondary:#b9bec7;--dsw-alias-label-tertiary:#8a8f98;
--dsw-alias-border-l2:rgba(255,255,255,.14);--dsw-alias-state-success-primary:#48b47f;
--dsw-alias-state-warn-primary:#d9a03c;--dsw-alias-state-error-primary:#e05b5b;
--dsw-alias-code-diff-added:rgba(72,180,127,.16);--dsw-alias-code-diff-deleted:rgba(224,91,91,.16);
--dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);--dsw-static-deepseek-500:#5686fe}</style>
</head><body>
<div id="root"></div>
<script src="${toUrl(react.react)}"></script>
<script src="${toUrl(react.reactDom)}"></script>
<script>window.__ModuleLoader__ = { load(module) { window.__module = module; } };</script>
<script>
${source}
</script>
<script>
(async () => {
  const results = {};
  const item = ${JSON.stringify(ITEM)};
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const plugin = window.__module.factory((name) => (name === 'react' ? React : undefined));

  ReactDOM.createRoot(document.getElementById('root')).render(
    React.createElement(plugin.__components.IssueRow, { item, samples: 3 }),
  );
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await frame();
  await frame();

  const card = document.querySelector('.tp-issue');
  results.cardRendered = card !== null;
  results.noCardToggle = card !== null && card.querySelector('button.tp-issue-head') === null;
  results.buttons = card === null ? [] : [...card.querySelectorAll('.tp-copy-btn')].map((node) => node.textContent);

  const details = card === null ? null : card.querySelector('details.tp-detail');
  results.detailClosedByDefault = details !== null && details.open === false;
  if (details !== null) {
    details.querySelector('summary').click();
    await frame();
    results.detailOpensOnClick = details.open === true;
    details.querySelector('summary').click();
    await frame();
  }

  // 路径一：navigator.clipboard 可用（https / localhost 上的宿主）。
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (value) => { copied.push(value); } },
    configurable: true,
  });
  for (const button of card.querySelectorAll('.tp-copy-btn')) button.click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  results.clipboardWrites = copied;
  results.copiedHint = card.querySelector('.tp-copy-ok') !== null;

  // 路径二：没有 navigator.clipboard（http://局域网 IP 的宿主），必须落到 textarea + execCommand。
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  const areaValues = [];
  const appendChild = document.body.appendChild.bind(document.body);
  document.body.appendChild = (node) => {
    if (node.tagName === 'TEXTAREA') areaValues.push(node.value);
    return appendChild(node);
  };
  let execCalls = 0;
  document.execCommand = () => {
    execCalls += 1;
    return true;
  };
  // 点「复制正字」：单字，最容易看出取错了段。
  card.querySelectorAll('.tp-copy-btn')[3].click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  results.fallbackValues = areaValues;
  results.fallbackExecCalls = execCalls;

  document.title = 'RESULT ' + JSON.stringify(results);
})().catch((error) => {
  document.title = 'ERROR ' + String((error && error.message) || error);
});
</script>
</body></html>`;
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'interaction.html');
  writeFileSync(path, html, 'utf8');
  return path;
}

const react = findReact();
if (react === null) {
  console.error('找不到 React 18 的 UMD 构建（先 npm i --no-save react@18 react-dom@18，或设 REACT_UMD_DIR）。');
  process.exit(2);
}

const browser = BROWSERS.find((path) => existsSync(path));
if (browser === undefined) {
  console.error('找不到 Edge 或 Chrome。');
  process.exit(2);
}

const page = compose(react);
const url = `file:///${page.replaceAll('\\', '/')}`;
const port = 9333;
const profile = join(outDir, 'profile-check');

/**
 * 等 DevTools 的页面清单出现。
 * @param {string} target - 要等的 URL 片段。
 * @returns {Promise<{ webSocketDebuggerUrl: string }>} 页面目标。
 */
async function waitForTarget(target) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const found = list.find((item) => item.type === 'page' && String(item.url).includes(target));
      if (found !== undefined) return found;
    } catch {
      // 端口还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

/**
 * 用一次 DevTools 调用读页面标题——--dump-dom 只在 load 事件后吐一次，
 * 等不到页面里那些 await 之后的断言。
 * @param {string} socketUrl - 页面 WebSocket 地址。
 * @param {string} expression - 要执行的表达式。
 * @returns {Promise<any>} 结果。
 */
function evaluate(socketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('DevTools 调用超时'));
    }, 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(payload.result?.result?.value);
    });
    socket.addEventListener('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdio: 'ignore' },
);

/** 收尾：别把无头浏览器留在后台。 */
const cleanup = () => {
  try {
    child.kill();
  } catch {
    // 已经退了。
  }
};
process.on('exit', cleanup);

let title = '';
try {
  const target = await waitForTarget(page.split('\\').pop());
  if (target === null) throw new Error('无头浏览器没有起来（devtools 端口连不上）');
  for (let attempt = 0; attempt < 100 && !title.startsWith('RESULT ') && !title.startsWith('ERROR '); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    title = String((await evaluate(target.webSocketDebuggerUrl, 'document.title')) ?? '');
  }
} finally {
  cleanup();
}

if (!title.startsWith('RESULT ')) {
  console.error(`自检页没有跑出结论：${title === '' ? '（title 为空）' : title}`);
  process.exit(1);
}

/** @type {Record<string, any>} */
const seen = JSON.parse(title.slice('RESULT '.length));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

check(seen.cardRendered === true, '卡片没渲染出来');
check(seen.noCardToggle === true, '卡片头部还是个折叠按钮，整卡应该常开');
check(same(seen.buttons, ['复制原文', '复制修改后', '复制错字', '复制正字']), `四个按钮不对：${JSON.stringify(seen.buttons)}`);
check(seen.detailClosedByDefault === true, '内部折叠该默认关着');
check(seen.detailOpensOnClick === true, '内部折叠点不开');
check(same(seen.clipboardWrites, [ITEM.original, ITEM.corrected, '贴', '帖']), `clipboard 收到的四段不对：${JSON.stringify(seen.clipboardWrites)}`);
check(seen.copiedHint === true, '复制成功没有给「已复制」提示');
check(same(seen.fallbackValues, ['帖']), `兜底路径没拿到正字：${JSON.stringify(seen.fallbackValues)}`);
check(seen.fallbackExecCalls > 0, '没有 navigator.clipboard 时没走 execCommand 兜底');

if (failures.length > 0) {
  console.error('交互自检未通过：');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`原始结果：${title}`);
  process.exit(1);
}

console.log('交互自检通过：');
console.log(`  卡片常开（无整卡折叠），按钮：${seen.buttons.join(' / ')}`);
console.log('  内部折叠默认关，点一下能开');
console.log(`  clipboard 收到：${JSON.stringify(seen.clipboardWrites)}`);
console.log(`  兜底路径收到：${JSON.stringify(seen.fallbackValues)}（execCommand 调用 ${seen.fallbackExecCalls} 次）`);
