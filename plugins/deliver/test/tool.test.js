import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, createStore, createTool } from "../index.js";

/**
 * 造一个带临时目录的工具实例。
 * @param {(context: { tool: object, dir: string }) => Promise<void>} run - 测试体。
 * @param {{ maxFileBytes?: number, maxFiles?: number }} [options] - 上限。
 * @returns {Promise<void>} 测试完成。
 */
async function withTool(run, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "deliver-tool-"));
  const store = createStore({ ttlMs: 60_000, clock: () => 1_000_000 });
  const tool = createTool({
    store,
    limits: {
      maxFileBytes: options.maxFileBytes ?? 1024,
      maxFiles: options.maxFiles ?? 5,
    },
    // 真实实现由 workingDirectory 服务给目录；这里直接把它钉在临时目录上。
    resolveCwd: async () => dir,
  });
  try {
    await run({ tool, dir, store });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 造一个最小的执行上下文。
 * @param {string} cwd - 会话工作目录。
 * @returns {object} 执行上下文。
 */
function makeExec(cwd) {
  return { agent: { id: "session-1", session: { header: { cwd } } } };
}

test("工具：绝对路径投递成功，返回值与 meta 字段齐全", async () => {
  await withTool(async ({ tool, dir }) => {
    const file = join(dir, "报告.txt");
    await writeFile(file, "0123456789");

    const value = await tool.execute({ files: [{ path: file }] }, makeExec(dir));
    assert.equal(value.failed.length, 0);
    assert.equal(value.files.length, 1);
    assert.equal(value.files[0].name, "报告.txt");
    assert.equal(value.files[0].size, 10);
    assert.equal(value.files[0].sizeText, "10 B");
    assert.equal(value.files[0].index, 0);
    assert.equal(value.files[0].url, `/deliver/${value.deliveryId}/0`);
    assert.ok(value.expiresAt > 0);

    const meta = tool.output.presentationMeta({}, value);
    assert.deepEqual(meta, {
      deliveryId: value.deliveryId,
      expiresAt: value.expiresAt,
      files: [
        {
          index: 0,
          name: "报告.txt",
          size: 10,
          sizeText: "10 B",
          url: `/deliver/${value.deliveryId}/0`,
        },
      ],
    });
    // 客户端读到的是从会话日志里还原的 JSON，投影必须能无损序列化。
    assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
  });
});

test("工具：相对路径按会话工作目录解析，自定义名生效", async () => {
  await withTool(async ({ tool, dir }) => {
    await writeFile(join(dir, "a.txt"), "x");
    const value = await tool.execute(
      { files: [{ path: "a.txt", name: "改名.txt" }] },
      makeExec(dir),
    );
    assert.equal(value.files[0].name, "改名.txt");
  });
});

test("工具：部分文件失败不影响其余，失败原因进 failed", async () => {
  await withTool(async ({ tool, dir }) => {
    await writeFile(join(dir, "ok.txt"), "x");
    const value = await tool.execute(
      { files: [{ path: join(dir, "ok.txt") }, { path: join(dir, "nope.txt") }] },
      makeExec(dir),
    );
    assert.equal(value.files.length, 1);
    assert.equal(value.failed.length, 1);
    assert.equal(value.failed[0].reason, "文件不存在");
  });
});

test("工具：一个都没成功时直接报错，并把每个原因带上", async () => {
  await withTool(async ({ tool, dir }) => {
    await assert.rejects(
      () => tool.execute({ files: [{ path: join(dir, "a.txt") }, { path: "" }] }, makeExec(dir)),
      (error) => {
        assert.match(error.message, /没有可投递的文件/);
        assert.match(error.message, /文件不存在/);
        assert.match(error.message, /缺少路径/);
        return true;
      },
    );
  });
});

test("工具：空 files 直接报错，不建投递", async () => {
  await withTool(async ({ tool, dir, store }) => {
    await assert.rejects(() => tool.execute({ files: [] }, makeExec(dir)), /files 不能为空/);
    assert.deepEqual(store.list(), []);
  });
});

test("工具：没有会话上下文时也能用绝对路径投递", async () => {
  await withTool(async ({ tool, dir }) => {
    const file = join(dir, "x.txt");
    await writeFile(file, "x");
    const value = await tool.execute({ files: [{ path: file }] }, {});
    assert.equal(value.files.length, 1);
  });
});

test("工具：超上限的文件被拒，并说明上限", async () => {
  await withTool(
    async ({ tool, dir }) => {
      await writeFile(join(dir, "big.bin"), Buffer.alloc(16));
      await assert.rejects(
        () => tool.execute({ files: [{ path: join(dir, "big.bin") }] }, makeExec(dir)),
        /超过上限/,
      );
    },
    { maxFileBytes: 8 },
  );
});

test("插件入口：注册 deliver 工具与 /deliver 前缀路由", () => {
  const tools = [];
  const routes = [];
  const ctx = {
    effect(factory) {
      return factory();
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    inject(_deps, callback) {
      callback(ctx);
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };

  apply(ctx, { ttlMinutes: 5 });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "deliver");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, "/deliver");
});

test("插件入口：相对路径按 workingDirectory 服务给的目录解析", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deliver-wiring-"));
  await writeFile(join(dir, "a.txt"), "x");
  try {
    let tool = null;
    const ctx = {
      effect(factory) {
        return factory();
      },
      tools: {
        register(value) {
          tool = value;
          return () => {};
        },
      },
      inject(_deps, callback) {
        callback(ctx);
      },
      webServer: {
        register() {
          return () => {};
        },
      },
      // 真实 Cordis 上未在 inject 里声明的服务只能通过 ctx.get 取，直接读属性会抛错。
      get(name) {
        return name === "workingDirectory" ? { ensure: async () => dir } : undefined;
      },
    };

    apply(ctx, {});
    const value = await tool.execute({ files: [{ path: "a.txt" }] }, { agent: { id: "s1" } });
    assert.equal(value.files[0].name, "a.txt");
    assert.equal(value.files[0].size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("工具：给模型看的文字含文件名与大小，但不含站内路径", async () => {
  await withTool(async ({ tool, dir }) => {
    await writeFile(join(dir, "a.txt"), "x");
    const value = await tool.execute({ files: [{ path: join(dir, "a.txt") }] }, makeExec(dir));
    const content = tool.output.render({}, value);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /已投递 1 个文件/);
    assert.match(content[0].text, /a\.txt（1 B）/);
    assert.match(content[0].text, /投递卡片/);
    // 路径写进正文会被渲染成文件链接而不是下载，必须由卡片承载。
    assert.ok(!content[0].text.includes("/deliver/"));
  });
});
