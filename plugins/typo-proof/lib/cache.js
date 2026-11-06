/**
 * 句级缓存。
 *
 * 一次全量检查要送几千次模型调用，本地 4B 跑一轮十几分钟；缓存让「同一句话、
 * 同一模型、同一版提示词」第二次直接命中，也让中断之后能续跑——不命中就重算，
 * 命中就跳过，不需要另存一份断点状态。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 造缓存键。
 *
 * 三个因素缺一不可：句子决定内容，模型决定输出分布，提示词版本决定问法。
 * 少任何一个，改配置之后就会拿到旧结果。
 * @param {{ model: string, promptVersion: string, text: string }} input - 三个因素。
 * @returns {string} sha1 十六进制。
 */
export function cacheKey({ model, promptVersion, text }) {
  return createHash("sha1").update(`${model}\u0000${promptVersion}\u0000${text}`).digest("hex");
}

/**
 * 打开一份缓存文件。
 *
 * 全部读进内存，改完统一落盘：一次运行会有几千次 set，每条都写盘光是 IO 就够呛。
 * @param {{ dir: string, name?: string }} options - 目录与文件名。
 * @returns {{ get: (key: string) => any, set: (key: string, value: any) => void, size: () => number, flush: () => Promise<void> }} 缓存。
 */
export function createCache(options) {
  const dir = options.dir;
  const path = join(dir, options.name ?? "typo-cache.json");
  let entries = null;
  let loading = null;
  let dirty = false;
  // flush 可能被并发触发（周期落盘 + 收尾落盘），串成一条链：
  // 两次同时写同一个 `.tmp` 会互相踩。
  let writing = Promise.resolve();

  /**
   * 读盘一次。
   *
   * 并发调用方会同时进来（三条采样任务一起起步），所以必须共用同一个进行中的 promise；
   * 各自读一遍的话，后完成的那次会把前一次已经写进内存的条目整个覆盖掉。
   * @returns {Promise<void>} 完成。
   */
  async function load() {
    if (entries !== null) return;
    if (loading !== null) return loading;
    loading = (async () => {
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        entries = parsed !== null && typeof parsed === "object" && typeof parsed.entries === "object" && parsed.entries !== null ? parsed.entries : {};
      } catch {
        // 文件不存在 / 坏了都按空缓存处理：重算一遍总比拿错结果强。
        entries = {};
      }
    })();
    return loading;
  }

  return {
    /**
     * 读一条。命中返回值，未命中返回 null。
     * @param {string} key - 缓存键。
     * @returns {any} 之前存的值。
     */
    async get(key) {
      await load();
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
    },
    /**
     * 写一条（只在内存里，等 flush）。
     * @param {string} key - 缓存键。
     * @param {any} value - 值。
     */
    async set(key, value) {
      await load();
      entries[key] = value;
      dirty = true;
    },
    /**
     * 落盘。先写临时文件再改名，避免写一半进程被杀留下半截 JSON。
     *
     * 周期落盘与收尾落盘可能同时触发，所以串成一条链：两次同时写同一个 `.tmp`
     * 会互相踩，改名也会失败。
     * @returns {Promise<void>} 完成。
     */
    flush() {
      writing = writing.then(async () => {
        if (!dirty) return;
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.tmp`;
        await writeFile(temp, JSON.stringify({ version: 1, entries }), "utf8");
        await rename(temp, path);
        dirty = false;
      });
      return writing;
    },
  };
}
