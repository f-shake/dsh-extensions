/**
 * header-compact 的浏览器端到端验证。
 *
 * 把真实的 client.js 塞进一份按宿主结构搭的标题行页面，用无头 Chromium
 * 在两个视口宽度下各跑一次：窄屏看收紧与隐藏、宽屏看不生效与不误伤。
 * 断言写在页面里，本脚本只负责起浏览器、读结果、给退出码。
 *
 * 用法：node e2e/run.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = resolve(here, "..", "client.js");
const templatePath = join(here, "page.html");

/** 常见浏览器安装位置，按顺序取第一个存在的。 */
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

const browser = BROWSERS.find((path) => existsSync(path));
if (browser === undefined) {
  console.error("找不到 Edge 或 Chrome，端到端验证无法执行");
  process.exit(2);
}

const template = readFileSync(templatePath, "utf8");
const source = readFileSync(clientPath, "utf8");
const page = template.replace("/*__CLIENT_SOURCE__*/", () => source);

const work = mkdtempSync(join(tmpdir(), "header-compact-e2e-"));
const pagePath = join(work, "page.html");
writeFileSync(pagePath, page, "utf8");

/** headless 的 dump-dom 里文本节点可能带实体。 */
function decode(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * 在一个视口宽度下跑一次页面。
 * @param {number} width - 视口宽度（px）。
 * @param {string} label - 报告里用的名字。
 * @returns {{ compact: boolean, checks: object[] }} 页面自证的结果。
 */
function run(width, label) {
  const result = spawnSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=1",
      `--user-data-dir=${join(work, `profile-${width}`)}`,
      `--window-size=${width},900`,
      "--virtual-time-budget=8000",
      "--dump-dom",
      `file:///${pagePath.replaceAll("\\", "/")}`,
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  const dom = result.stdout ?? "";
  const match = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom);
  if (match === null) {
    console.error(`${label}: 页面没有产出结果`);
    console.error((result.stderr ?? "").slice(0, 800));
    console.error(dom.slice(0, 800));
    process.exit(1);
  }
  return JSON.parse(decode(match[1]));
}

let failed = 0;
let passed = 0;
for (const [width, label, wantCompact] of [
  [393, "窄屏 393px", true],
  [1200, "宽屏 1200px", false],
]) {
  const { compact, checks } = run(width, label);
  const bad = checks.filter((check) => !check.ok);
  failed += bad.length;
  passed += checks.length - bad.length;
  console.log(`\n${label}（matchMedia 命中窄屏：${compact ? "是" : "否"}）`);
  if (compact !== wantCompact) {
    failed += 1;
    console.log(`  ✖ 视口判定不符：期望 ${wantCompact ? "窄屏" : "宽屏"}，实际 ${compact}`);
  }
  for (const check of checks) {
    const mark = check.ok ? "✔" : "✖";
    console.log(`  ${mark} ${check.name}：${JSON.stringify(check.actual)}`);
    if (!check.ok) console.log(`      期望：${JSON.stringify(check.expected)}`);
  }
}

rmSync(work, { recursive: true, force: true });

console.log(`\n端到端：通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
