import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHandlers, createStore } from "../index.js";

/**
 * 起一个真实 HTTP 服务，跑完关掉。
 * @param {(context: object) => Promise<void>} run - 测试体。
 * @param {{ ttlMs?: number }} [options] - 投递表选项。
 * @returns {Promise<void>} 测试完成。
 */
async function withServer(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "deliver-route-"));
  let now = 1_000_000;
  const clock = () => now;
  const store = createStore({
    ttlMs: options.ttlMs ?? 60_000,
    maxDeliveries: 20,
    clock,
  });
  const handlers = createHandlers({ store, clock, openFile: options.openFile });
  const server = createServer((req, res) => {
    void handlers.handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("boom");
      }
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({
      root,
      store,
      base,
      advance(ms) {
        now += ms;
      },
    });
  } finally {
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 把磁盘上的文件登记进投递表。
 * @param {object} store - 投递表。
 * @param {string} absPath - 文件路径。
 * @param {string} [name] - 下载名。
 * @returns {Promise<object>} 投递记录。
 */
async function deliver(store, absPath, name) {
  const info = await stat(absPath);
  return store.create([{ absPath, name: name ?? basename(absPath), size: info.size }]);
}

test("下载：200、完整字节、下载相关的响应头齐全", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "report.txt");
    await writeFile(file, "hello world");
    const record = await deliver(store, file, "报告.txt");

    const response = await fetch(`${base}/deliver/${record.id}/0`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    // no-transform 必须在：宿主 gzip 层看到它才会保留 Content-Length。
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(response.headers.get("content-length"), "11");
    assert.ok(response.headers.get("content-disposition").includes("attachment"));
    assert.equal(await response.text(), "hello world");
  });
});

test("下载：Range 命中返回 206 与片段", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);

    const response = await fetch(`${base}/deliver/${record.id}/0`, {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(await response.text(), "2345");
  });
});

test("下载：后缀 Range 取末尾，右边界超长时夹到文件尾", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);

    const suffix = await fetch(`${base}/deliver/${record.id}/0`, {
      headers: { range: "bytes=-3" },
    });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), "789");

    const clamped = await fetch(`${base}/deliver/${record.id}/0`, {
      headers: { range: "bytes=8-100" },
    });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.headers.get("content-range"), "bytes 8-9/10");
    assert.equal(await clamped.text(), "89");
  });
});

test("下载：越界 Range 返回 416 并给出总长度", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);

    const response = await fetch(`${base}/deliver/${record.id}/0`, {
      headers: { range: "bytes=100-" },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */10");
    assert.equal(await response.text(), "");
  });
});

test("下载：语法非法的 Range 当作没有 Range，返回全文", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);

    const response = await fetch(`${base}/deliver/${record.id}/0`, {
      headers: { range: "bytes=oops" },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "0123456789");
  });
});

test("下载：HEAD 只回头，长度与 GET 一致", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);

    const response = await fetch(`${base}/deliver/${record.id}/0`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "10");
    assert.equal(await response.text(), "");
  });
});

test("下载：未知 id 与非法序号给说明页，不泄露别的文件", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);

    const missing = await fetch(`${base}/deliver/not-a-real-id/0`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type"), /text\/html/);
    assert.match(await missing.text(), /这条投递不存在/);

    const wrongIndex = await fetch(`${base}/deliver/${record.id}/3`);
    assert.equal(wrongIndex.status, 404);
    assert.match(await wrongIndex.text(), /文件不存在/);
  });
});

test("下载：过期返回 410，撤销返回 410，两者文案不同", async () => {
  await withServer(async ({ root, base, store, advance }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const expired = await deliver(store, file);
    advance(60_000);

    const gone = await fetch(`${base}/deliver/${expired.id}/0`);
    assert.equal(gone.status, 410);
    assert.match(await gone.text(), /已过期/);

    advance(1);
    const alive = await deliver(store, file);
    store.revoke(alive.id);
    const revoked = await fetch(`${base}/deliver/${alive.id}/0`);
    assert.equal(revoked.status, 410);
    assert.match(await revoked.text(), /已撤销/);
  });
});

test("下载：源文件被删后返回 404 说明页", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "data.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);
    await unlink(file);

    const response = await fetch(`${base}/deliver/${record.id}/0`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /源文件已删除/);
  });
});

test("下载：0 字节文件正常返回空体", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "empty.txt");
    await writeFile(file, "");
    const record = await deliver(store, file);

    const response = await fetch(`${base}/deliver/${record.id}/0`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "0");
    assert.equal(await response.text(), "");
  });
});

test("下载：中文文件名走 RFC 5987，ASCII 回退名不含非 ASCII", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "whatever.bin");
    await writeFile(file, "x");
    const record = await deliver(store, file, "周报 2026.pdf");

    const response = await fetch(`${base}/deliver/${record.id}/0`);
    const header = response.headers.get("content-disposition");
    assert.ok(header.includes("filename*=UTF-8''"));
    assert.ok(header.includes("%E5%91%A8%E6%8A%A5"));
    assert.ok(header.includes('filename="'));
    assert.ok(!/[^\x00-\x7f]/.test(header));
  });
});

test("列表：只给未过期未撤销的，新的在前，字段够客户端渲染", async () => {
  await withServer(async ({ root, base, store, advance }) => {
    const file = join(root, "a.txt");
    await writeFile(file, "abcdef");
    const older = await deliver(store, file, "旧.txt");
    advance(5);
    const newer = await deliver(store, file, "新.txt");
    advance(5);
    const revoked = await deliver(store, file, "撤销.txt");
    store.revoke(revoked.id);

    const response = await fetch(`${base}/deliver/list`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.deliveries.map((item) => item.id),
      [newer.id, older.id],
    );
    const first = payload.deliveries[0];
    assert.equal(first.files[0].name, "新.txt");
    assert.equal(first.files[0].size, 6);
    assert.equal(first.files[0].sizeText, "6 B");
    assert.equal(first.files[0].url, `/deliver/${newer.id}/0`);
    assert.ok(first.expiresAt > first.createdAt);
  });
});

test("列表：空表返回空数组而不是 404", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/deliver/list`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, now: 1_000_000, deliveries: [] });
  });
});

test("撤销：DELETE 成功、重复撤销幂等、未知 id 404", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "a.txt");
    await writeFile(file, "a");
    const record = await deliver(store, file);

    const first = await fetch(`${base}/deliver/${record.id}`, { method: "DELETE" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });

    const again = await fetch(`${base}/deliver/${record.id}`, { method: "DELETE" });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, already: true });

    const unknown = await fetch(`${base}/deliver/nope`, { method: "DELETE" });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { ok: false, error: "missing" });
  });
});

test("路由：未知路径与不支持的请求方法都回 404 JSON", async () => {
  await withServer(async ({ base }) => {
    const unknown = await fetch(`${base}/elsewhere`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { ok: false, error: "not-found" });

    const wrongMethod = await fetch(`${base}/deliver/list`, { method: "POST" });
    assert.equal(wrongMethod.status, 404);
  });
});

test("下载：只认规范十进制序号，00/01 与前缀别名都是 404", async () => {
  await withServer(async ({ root, base, store }) => {
    const first = join(root, "a.txt");
    const second = join(root, "b.txt");
    await writeFile(first, "a");
    await writeFile(second, "b");
    // 必须投两个文件：单文件时 01 会因为越界才 404，测不出「前导零别名」。
    const record = store.create([
      { absPath: first, name: "a.txt", size: 1 },
      { absPath: second, name: "b.txt", size: 1 },
    ]);

    for (const alias of ["00", "01", "1e0", "0x1", "+1", "-1"]) {
      const response = await fetch(`${base}/deliver/${record.id}/${encodeURIComponent(alias)}`);
      assert.equal(response.status, 404, `序号 ${alias} 不该命中`);
    }

    const zero = await fetch(`${base}/deliver/${record.id}/0`);
    assert.equal(zero.status, 200);
    assert.equal(await zero.text(), "a");
    const one = await fetch(`${base}/deliver/${record.id}/1`);
    assert.equal(one.status, 200);
    assert.equal(await one.text(), "b");
  });
});

test("下载：suffix 为 0 的 Range 按不可满足回 416", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "a.txt");
    await writeFile(file, "0123456789");
    const record = await deliver(store, file);

    const response = await fetch(`${base}/deliver/${record.id}/0`, {
      headers: { range: "bytes=-0" },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */10");
  });
});

test("下载：打开文件失败时回 500 说明页，不再发完 200 断流", async () => {
  const busy = async () => {
    const error = new Error("resource busy");
    error.code = "EBUSY";
    throw error;
  };
  await withServer(
    async ({ root, base, store }) => {
      const file = join(root, "locked.bin");
      await writeFile(file, "x");
      const record = await deliver(store, file);

      const response = await fetch(`${base}/deliver/${record.id}/0`);
      assert.equal(response.status, 500);
      assert.match(await response.text(), /文件暂时读不出来/);

      // 卡片的前置检查也要如实失败，否则用户会点到一个没有信息的下载。
      const head = await fetch(`${base}/deliver/${record.id}/0`, { method: "HEAD" });
      assert.equal(head.status, 500);
    },
    { openFile: busy },
  );
});

test("下载：源文件被换成目录后，打开失败按源文件不存在处理", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "swap.bin");
    await writeFile(file, "x");
    const record = await deliver(store, file);
    await rm(file, { force: true });
    await mkdir(file);

    const response = await fetch(`${base}/deliver/${record.id}/0`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /源文件已删除/);
  });
});

test("列表：session 参数只返回该会话的投递，缺省仍是全部", async () => {
  await withServer(async ({ root, base, store }) => {
    const file = join(root, "a.txt");
    await writeFile(file, "a");
    const mine = store.create([{ absPath: file, name: "a.txt", size: 1 }], "session-a");
    store.create([{ absPath: file, name: "b.txt", size: 1 }], "session-b");

    const filtered = await fetch(`${base}/deliver/list?session=session-a`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      (await filtered.json()).deliveries.map((item) => item.id),
      [mine.id],
    );

    const all = await fetch(`${base}/deliver/list`);
    assert.equal((await all.json()).deliveries.length, 2);

    const unknown = await fetch(`${base}/deliver/list?session=nobody`);
    assert.deepEqual((await unknown.json()).deliveries, []);
  });
});
