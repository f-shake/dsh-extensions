/**
 * typo-proof 的设计预览：把真实的 client.js 装进一个仿宿主的页面，截图出来看。
 *
 * 为什么要有这一步：2a 只做界面与交互，还没法在真正的 dsh 里验证
 * （插件要装进 profile、重启才生效）。这份预览用本机的 React UMD 把同一份组件
 * 渲染出来，设计评审看的就是最终会跑在宿主里的那份 DOM 与 CSS。
 *
 * 用法：
 *   node e2e/preview.mjs            生成页面并截全套图
 *   node e2e/preview.mjs --serve    只生成页面，打印路径，自己拿浏览器打开
 *
 * React 从本机已装的包目录里取（不联网、不往仓库里放第三方文件）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const clientPath = join(pluginDir, 'client.js');
const templatePath = join(here, 'preview.html');
const outDir = join(here, '.preview');
const shotDir = join(outDir, 'shots');

/** 本机可能装着 React 18 UMD 的目录，按序取第一个可用的。 */
const REACT_CANDIDATES = [
  process.env.REACT_UMD_DIR,
  'C:\\Running\\Anywhere-next\\dsh-bridge-next\\node_modules',
  join(pluginDir, 'node_modules'),
].filter((item) => typeof item === 'string' && item !== '');

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
 * 拼出可直接双击打开的预览页。
 * @param {{ react: string, reactDom: string }} react - React UMD 路径。
 * @returns {{ html: string, path: string }} 页面内容与落盘路径。
 */
function compose(react) {
  const toUrl = (path) => `file:///${path.replaceAll('\\', '/')}`;
  const scripts = [
    `<script src="${toUrl(react.react)}"></script>`,
    `<script src="${toUrl(react.reactDom)}"></script>`,
  ].join('\n    ');
  const source = readFileSync(clientPath, 'utf8');
  // 预览专用的假数据源：去掉 export，直接当页面里的脚本用。
  const fake = readFileSync(join(here, 'fake-source.js'), 'utf8').replace('export function createFakeSource', 'function createFakeSource');
  const template = readFileSync(templatePath, 'utf8');
  const html = template
    .replace('<!--__REACT__-->', () => scripts)
    .replace('/*__CLIENT_SOURCE__*/', () => source)
    .replace('/*__FAKE_SOURCE__*/', () => fake);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'index.html');
  writeFileSync(path, html, 'utf8');
  return { html, path };
}

/**
 * 跑一次无头浏览器截图。
 * @param {string} browser - 浏览器可执行文件。
 * @param {string} page - 页面文件绝对路径。
 * @param {{ width: number, height: number }} size - 视口。
 * @param {string} query - 查询串（不含问号）。
 * @param {string} out - 输出 PNG 绝对路径。
 */
function shoot(browser, page, size, query, out) {
  const profile = join(outDir, `profile-${size.width}x${size.height}`);
  const result = spawnSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=2',
      `--user-data-dir=${profile}`,
      `--window-size=${size.width},${size.height}`,
      '--virtual-time-budget=6000',
      `--screenshot=${out}`,
      `file:///${page.replaceAll('\\', '/')}?${query}`,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (!existsSync(out)) {
    console.error(`截图失败：${query}`);
    console.error((result.stderr ?? '').slice(0, 800));
    process.exit(1);
  }
}

const react = findReact();
if (react === null) {
  console.error('找不到 React 18 的 UMD 构建，预览无法生成。');
  console.error('可以设 REACT_UMD_DIR 指向含 react / react-dom 的 node_modules 目录。');
  process.exit(2);
}

const composed = compose(react);
console.log(`预览页：${composed.path}`);

if (process.argv.includes('--serve')) {
  process.exit(0);
}

const browser = BROWSERS.find((path) => existsSync(path));
if (browser === undefined) {
  console.error('找不到 Edge 或 Chrome，截图无法执行（预览页仍可手动打开）。');
  process.exit(2);
}

mkdirSync(shotDir, { recursive: true });

/** 全套截图：面板三种阶段 + 浅色 + 展开一条候选 + 对话里的工具卡片。 */
const SHOTS = [
  { name: 'panel-idle', size: { width: 420, height: 720 }, query: 'view=panel&state=idle&theme=dark' },
  { name: 'panel-running', size: { width: 420, height: 760 }, query: 'view=panel&state=running&theme=dark' },
  { name: 'panel-done', size: { width: 420, height: 960 }, query: 'view=panel&state=done&theme=dark' },
  { name: 'panel-expanded', size: { width: 420, height: 960 }, query: 'view=panel&state=done&theme=dark&expand=74-0' },
  { name: 'panel-done-light', size: { width: 420, height: 960 }, query: 'view=panel&state=done&theme=light' },
  { name: 'panel-autostart', size: { width: 420, height: 960 }, query: 'view=panel&state=idle&theme=dark&auto=start' },
  { name: 'panel-settings', size: { width: 420, height: 860 }, query: 'view=settings&theme=dark' },
  { name: 'panel-picker', size: { width: 420, height: 760 }, query: 'view=picker&theme=dark' },
  { name: 'tool-card', size: { width: 760, height: 220 }, query: 'view=card&state=done&theme=dark' },
];

for (const shot of SHOTS) {
  const out = join(shotDir, `${shot.name}.png`);
  shoot(browser, composed.path, shot.size, shot.query, out);
  console.log(`  ${shot.name}.png`);
}

console.log(`截图目录：${shotDir}`);
