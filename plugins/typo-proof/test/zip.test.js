import assert from "node:assert/strict";
import { test } from "node:test";

import { crc32, readZip, writeZip } from "../lib/zip.js";

test("zip：写出再读回，内容与名字都不变（含中文名）", () => {
  const entries = [
    { name: "word/document.xml", data: Buffer.from("<w:document>你好</w:document>", "utf8") },
    { name: "docProps/核心.xml", data: Buffer.from("中文名字也要能读回来", "utf8") },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];
  const buffer = writeZip(entries, new Date("2026-11-06T10:00:00Z"));
  const back = readZip(buffer);
  assert.equal(back.size, 3);
  for (const entry of entries) {
    assert.deepEqual(back.get(entry.name), entry.data, `条目 ${entry.name}`);
  }
});

test("zip：不是 zip 的输入给出可读错误", () => {
  assert.throws(() => readZip(Buffer.from("这不是一个 zip 文件")), /不是有效的 zip/);
});

test("zip：crc32 对得上标准向量", () => {
  // "123456789" 的 CRC32 是经典向量。
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});
