import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readSettings, validateSettings, writeSettings } from "../lib/settings.js";

test("settings：合法值原样收下，不认识的键忽略", () => {
  const checked = validateSettings({
    file: "  C:/日记/a.docx  ",
    localProvider: "lmstudio",
    localModel: "qwen3-4b",
    minHanzi: 9,
    samples: 3,
    concurrency: 4,
    登录口令: "不该出现",
  });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value, {
    file: "C:/日记/a.docx",
    localProvider: "lmstudio",
    localModel: "qwen3-4b",
    minHanzi: 9,
    samples: 3,
    concurrency: 4,
  });
});

test("settings：越界与类型不对的字段给出可读的错误", () => {
  const bad = validateSettings({ minHanzi: 0, samples: 99, concurrency: 2.5, file: 42 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4);
  assert.match(bad.errors.join("；"), /minHanzi 要是 1 到 100 之间的整数/);
  assert.match(bad.errors.join("；"), /samples 要是 1 到 10 之间的整数/);
  assert.match(bad.errors.join("；"), /concurrency 要是 1 到 16 之间的整数/);
  assert.match(bad.errors.join("；"), /file 必须是字符串/);
});

test("settings：文件不存在或内容坏掉都当没设置过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "typo-settings-"));
  assert.deepEqual(await readSettings(join(dir, "nope.json")), {});

  const broken = join(dir, "broken.json");
  await writeFile(broken, "{不是 JSON");
  assert.deepEqual(await readSettings(broken), {});

  const wrong = join(dir, "wrong.json");
  await writeFile(wrong, JSON.stringify({ minHanzi: 999 }));
  assert.deepEqual(await readSettings(wrong), {}, "有一项不合法就整份不认，避免半套设置生效");
});

test("settings：保存是合并而不是整份覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "typo-settings-"));
  const path = join(dir, "settings.json");

  const first = await writeSettings(path, { localProvider: "lmstudio", localModel: "qwen3-4b", minHanzi: 8 });
  assert.equal(first.ok, true);

  const second = await writeSettings(path, { minHanzi: 12 });
  assert.equal(second.ok, true);
  assert.deepEqual(second.settings, { localProvider: "lmstudio", localModel: "qwen3-4b", minHanzi: 12 });

  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.localModel, "qwen3-4b", "只改一项时别的不能被冲掉");
  assert.equal(onDisk.minHanzi, 12);
});

test("settings：非法值不落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "typo-settings-"));
  const path = join(dir, "settings.json");
  const result = await writeSettings(path, { samples: 0 });
  assert.equal(result.ok, false);
  assert.deepEqual(await readSettings(path), {}, "被拒绝的保存不该留下任何东西");
});

test("settings：读的时候逐字段容错，坏一个字段不牵连其余", async () => {
  const dir = await mkdtemp(join(tmpdir(), "typo-settings-"));
  const mixed = join(dir, "mixed.json");
  await writeFile(mixed, JSON.stringify({ file: "C:/a.docx", minHanzi: 999, localModel: "qwen3-4b" }));
  const value = await readSettings(mixed);
  assert.equal(value.file, "C:/a.docx", "好的字段要留下");
  assert.equal(value.localModel, "qwen3-4b");
  assert.equal(value.minHanzi, undefined, "坏字段单独丢掉，不整份作废");
});
