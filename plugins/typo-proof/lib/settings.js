/**
 * 面板里那份设置。
 *
 * 为什么单独存一个 JSON 而不是回写 `cordis.patch.yml`：那份是 Loader 的输入，
 * 由人手工维护，插件去改它等于改自己的启动参数——改完还得重启，且会把用户的注释冲掉。
 * 这里存的是「用户在面板里改过的值」，运行时的优先级是：
 * 面板设置 > Loader 配置 > 默认值。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 面板能改的字段。不在这张表里的键一律忽略。 */
export const EDITABLE_KEYS = new Set([
  "file",
  "localProvider",
  "localModel",
  "reviewProvider",
  "reviewModel",
  "minHanzi",
  "samples",
  "concurrency",
]);

/**
 * 校验一份改动。
 *
 * 只做「能不能存」的判断，不做业务判断（模型存不存在要等真跑的时候才知道）。
 * @param {object} patch - 待保存的字段。
 * @returns {{ ok: boolean, value: object, errors: string[] }} 结果。
 */
export function validateSettings(patch) {
  const source = patch !== null && typeof patch === "object" ? patch : {};
  const value = {};
  const errors = [];

  for (const [key, raw] of Object.entries(source)) {
    if (!EDITABLE_KEYS.has(key)) continue;
    if (key === "file" || key === "localProvider" || key === "localModel" || key === "reviewProvider" || key === "reviewModel") {
      if (typeof raw !== "string") {
        errors.push(`${key} 必须是字符串`);
        continue;
      }
      value[key] = raw.trim();
      continue;
    }
    // 三个数字参数：整数、有上下限。上限只是防手滑，不是业务约束。
    const limits = { minHanzi: [1, 100], samples: [1, 10], concurrency: [1, 16] };
    const [low, high] = limits[key];
    const number = Number(raw);
    if (!Number.isInteger(number) || number < low || number > high) {
      errors.push(`${key} 要是 ${low} 到 ${high} 之间的整数`);
      continue;
    }
    value[key] = number;
  }

  return { ok: errors.length === 0, value, errors };
}

/**
 * 读设置文件。文件不存在、坏了、格式不对都按「没设置过」处理。
 * @param {string} path - 文件路径。
 * @returns {Promise<object>} 设置对象；永远不抛。
 */
export async function readSettings(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // 逐字段校验：手工改坏一个 minHanzi 不该把模型、文件、其余设置一起作废。
    // 写盘时仍然是整份严格校验——存的时候就别存坏的。
    const value = {};
    for (const [key, field] of Object.entries(parsed)) {
      const checked = validateSettings({ [key]: field });
      if (checked.ok) Object.assign(value, checked.value);
    }
    return value;
  } catch {
    return {};
  }
}

/**
 * 合并保存。
 *
 * 只覆盖这次带的字段，其余保留——面板一次只改一行也是常事。
 * 先写临时文件再改名：写一半断电不至于把整份设置弄坏。
 * @param {string} path - 文件路径。
 * @param {object} patch - 待保存字段。
 * @returns {Promise<{ ok: boolean, settings: object, errors: string[] }>} 结果。
 */
export async function writeSettings(path, patch) {
  const checked = validateSettings(patch);
  if (!checked.ok) return { ok: false, settings: {}, errors: checked.errors };

  const merged = { ...(await readSettings(path)), ...checked.value };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(merged, null, 2), "utf8");
  await rename(temp, path);
  return { ok: true, settings: merged, errors: [] };
}
