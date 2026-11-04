import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentDisposition,
  createStore,
  formatSize,
  mimeOf,
  normalizeConfig,
  parseRange,
  resolveFiles,
} from "../index.js";

/**
 * 造一个临时目录，跑完删掉。
 * @param {(dir: string) => Promise<void>} run - 测试体。
 * @returns {Promise<void>} 测试完成。
 */
async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "deliver-unit-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Range：没有头、单段、开区间、后缀、越界、非法各自解析正确", () => {
  assert.deepEqual(parseRange(undefined, 10), { kind: "none" });
  assert.deepEqual(parseRange("", 10), { kind: "none" });
  assert.deepEqual(parseRange("bytes=0-4", 10), { kind: "range", start: 0, end: 4 });
  assert.deepEqual(parseRange("bytes=5-", 10), { kind: "range", start: 5, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { kind: "range", start: 7, end: 9 });
  // 超出右边界要夹到文件末尾，不是直接拒绝。
  assert.deepEqual(parseRange("bytes=0-99", 10), { kind: "range", start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=10-", 10), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=-0", 10), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=abc", 10), { kind: "invalid" });
  assert.deepEqual(parseRange("items=0-1", 10), { kind: "invalid" });
  assert.deepEqual(parseRange("bytes=0-1,5-6", 10), { kind: "range", start: 0, end: 1 });
  assert.deepEqual(parseRange("bytes=-5", 0), { kind: "unsatisfiable" });
});

test("Content-Disposition：中文名走 RFC 5987，引号与非 ASCII 进 ASCII 回退名", () => {
  const header = contentDisposition("报告.pdf");
  assert.match(header, /^attachment; filename="/);
  assert.ok(header.includes("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"));
  // ASCII 回退名里不能出现原始的非 ASCII 字节。
  assert.ok(header.includes('filename="__.pdf"'));
  assert.ok(contentDisposition('a"b.txt').includes('filename="a_b.txt"'));
  assert.ok(contentDisposition("").includes('filename="download"'));
  assert.ok(contentDisposition("x").includes("filename*=UTF-8''x"));
});

test("formatSize：边界与非法输入都有确定文案", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(999), "999 B");
  assert.equal(formatSize(1024), "1 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(1024 * 1024 * 12), "12 MB");
  assert.equal(formatSize(Number.NaN), "未知大小");
  assert.equal(formatSize(-1), "未知大小");
});

test("mimeOf：常见扩展名命中，未知与无扩展名回退二进制", () => {
  assert.equal(mimeOf("a.pdf"), "application/pdf");
  assert.equal(mimeOf("A.PNG"), "image/png");
  assert.equal(mimeOf("报告.md"), "text/markdown; charset=utf-8");
  assert.equal(mimeOf("app.apk"), "application/vnd.android.package-archive");
  assert.equal(mimeOf("noext"), "application/octet-stream");
  assert.equal(mimeOf(undefined), "application/octet-stream");
});

test("resolveFiles：绝对路径、相对路径、自定义名都收下", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "report.txt");
    await writeFile(file, "hello");
    const { accepted, failed } = await resolveFiles(
      [{ path: file }, { path: "report.txt", name: "改名.txt" }],
      { cwd: dir, maxFileBytes: 1024, maxFiles: 5 },
    );
    assert.equal(failed.length, 0);
    // 同一个文件两种写法只收一次，第二次被去重。
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].name, "report.txt");
    assert.equal(accepted[0].size, 5);
  });
});

test("resolveFiles：不存在、目录、超限、空路径各自给出原因，不牵连其余文件", async () => {
  await withTempDir(async (dir) => {
    const ok = join(dir, "ok.txt");
    await writeFile(ok, "1234");
    const big = join(dir, "big.bin");
    await writeFile(big, Buffer.alloc(64));
    await mkdir(join(dir, "folder"));

    const { accepted, failed } = await resolveFiles(
      [
        { path: ok },
        { path: join(dir, "missing.txt") },
        { path: "folder" },
        { path: big },
        { path: "  " },
      ],
      { cwd: dir, maxFileBytes: 32, maxFiles: 5 },
    );

    assert.deepEqual(accepted.map((item) => item.name), ["ok.txt"]);
    const reasons = failed.map((item) => item.reason);
    assert.deepEqual(reasons, ["文件不存在", "是目录，请先打包成文件", "超过上限 32 B", "缺少路径"]);
  });
});

test("resolveFiles：超过 maxFiles 的条目被拒绝并说明上限", async () => {
  await withTempDir(async (dir) => {
    const first = join(dir, "a.txt");
    const second = join(dir, "b.txt");
    await writeFile(first, "a");
    await writeFile(second, "b");
    const { accepted, failed } = await resolveFiles(
      [{ path: first }, { path: second }],
      { cwd: dir, maxFileBytes: 1024, maxFiles: 1 },
    );
    assert.equal(accepted.length, 1);
    assert.equal(failed.length, 1);
    assert.match(failed[0].reason, /一次最多投递 1 个文件/);
  });
});

test("投递表：建、查、列表按时间倒序", () => {
  let now = 1_000;
  const store = createStore({ ttlMs: 60_000, maxDeliveries: 5, clock: () => now });
  const first = store.create([{ absPath: "C:\\a.txt", name: "a.txt", size: 1 }]);
  now += 10;
  const second = store.create([{ absPath: "C:\\b.txt", name: "b.txt", size: 2 }]);

  assert.equal(store.get(first.id).state, "ok");
  assert.deepEqual(
    store.list().map((record) => record.id),
    [second.id, first.id],
  );
});

test("投递表：过期后查询返回 expired，列表里不再出现", () => {
  let now = 1_000;
  const store = createStore({ ttlMs: 100, clock: () => now });
  const record = store.create([{ absPath: "C:\\a.txt", name: "a.txt", size: 1 }]);
  now += 100;
  assert.equal(store.get(record.id).state, "expired");
  assert.deepEqual(store.list(), []);
});

test("投递表：撤销留下墓碑，重复撤销也返回 revoked", () => {
  let now = 1_000;
  const store = createStore({ ttlMs: 60_000, clock: () => now });
  const record = store.create([{ absPath: "C:\\a.txt", name: "a.txt", size: 1 }]);
  assert.equal(store.revoke(record.id), "ok");
  assert.equal(store.get(record.id).state, "revoked");
  assert.equal(store.revoke(record.id), "revoked");
  assert.equal(store.revoke("nope"), "missing");
  assert.deepEqual(store.list(), []);
});

test("投递表：超过容量时丢最旧的", () => {
  let now = 1_000;
  const store = createStore({ ttlMs: 60_000, maxDeliveries: 2, clock: () => now });
  const first = store.create([{ absPath: "C:\\a", name: "a", size: 1 }]);
  now += 1;
  const second = store.create([{ absPath: "C:\\b", name: "b", size: 1 }]);
  now += 1;
  const third = store.create([{ absPath: "C:\\c", name: "c", size: 1 }]);

  assert.equal(store.get(first.id).state, "missing");
  assert.equal(store.get(second.id).state, "ok");
  assert.equal(store.get(third.id).state, "ok");
});

test("投递表：按会话过滤只影响列表，单条查询不受影响", () => {
  let now = 1_000;
  const store = createStore({ ttlMs: 60_000, clock: () => now });
  const mine = store.create([{ absPath: "C:\\a", name: "a", size: 1 }], "s1");
  now += 1;
  const other = store.create([{ absPath: "C:\\b", name: "b", size: 1 }], "s2");

  assert.deepEqual(
    store.list("s1").map((record) => record.id),
    [mine.id],
  );
  assert.deepEqual(
    store.list("s2").map((record) => record.id),
    [other.id],
  );
  assert.equal(store.list().length, 2);
  assert.equal(store.list("").length, 2);
  assert.equal(store.list("unknown").length, 0);
  assert.equal(store.get(mine.id).state, "ok");
});

test("配置归一化：缺省值、非法值、覆盖值", () => {
  assert.deepEqual(normalizeConfig(undefined), {
    ttlMinutes: 720,
    maxFileBytes: 4 * 1024 ** 3,
    maxFiles: 20,
    maxDeliveries: 200,
  });
  assert.deepEqual(normalizeConfig({ ttlMinutes: -5, maxFiles: "x", maxDeliveries: 0 }), {
    ttlMinutes: 720,
    maxFileBytes: 4 * 1024 ** 3,
    maxFiles: 20,
    maxDeliveries: 200,
  });
  const custom = normalizeConfig({
    ttlMinutes: 1,
    maxFileBytes: 1024,
    maxFiles: 3,
    maxDeliveries: 4,
  });
  assert.deepEqual(custom, {
    ttlMinutes: 1,
    maxFileBytes: 1024,
    maxFiles: 3,
    maxDeliveries: 4,
  });
});
