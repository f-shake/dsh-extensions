import test from 'node:test';
import assert from 'node:assert/strict';

import { apply as applyBackgroundSend, createWaitTap, isUserSteer, normalizeConfig } from '../index.js';

/** 让出事件循环，等待定时器。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 造一个 job 视图，形状与真实注册表一致的部分只保留被测字段。 */
function view(job) {
  return { id: job.id, kind: job.kind, status: job.status };
}

/**
 * 真实注册表的最小替身：等待者按 job 登记，结算时释放；超时返回当时的视图。
 * 语义与 packages/jobs 的 local 实现保持同构，用于验证包装层没有改变四条出口。
 */
class FakeRegistry {
  constructor() {
    this.store = new Map();
    this.waiters = new Map();
  }

  spawn(id, kind, owner) {
    this.store.set(id, { id, kind, status: 'running', owner });
    this.waiters.set(id, new Set());
  }

  settle(id, status = 'completed') {
    const job = this.store.get(id);
    job.status = status;
    for (const notify of [...this.waiters.get(id)]) notify();
  }

  get(id, caller) {
    const job = this.store.get(String(id));
    if (job === undefined) throw new Error(`unknown job ${id}`);
    if (job.owner !== undefined && job.owner !== caller) throw new Error(`job ${id} belongs to another session`);
    return view(job);
  }

  wait(id, timeoutMs, caller, signal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error(`invalid wait timeout: ${JSON.stringify(timeoutMs)}`));
    }
    const job = this.store.get(String(id));
    if (job === undefined) return Promise.reject(new Error(`unknown job ${id}`));
    if (job.status !== 'running' && job.status !== 'stopping') return Promise.resolve(view(job));
    if (signal !== undefined && signal.aborted) return Promise.reject(new Error('wait aborted'));
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (settle) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.get(String(id))?.delete(notify);
        settle();
      };
      const notify = () => finish(() => resolve(view(job)));
      const timer = setTimeout(() => finish(() => resolve(view(job))), timeoutMs);
      const onAbort = () => finish(() => reject(new Error('wait aborted')));
      this.waiters.get(String(id)).add(notify);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  pendingWaiters(id) {
    return this.waiters.get(String(id))?.size ?? 0;
  }
}

test('wait 包装：任务结算时返回终态视图，且不残留等待者', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-1', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0 });
  tap.install();

  const pending = registry.wait('pwsh-1', 5000, 's1');
  await delay(15);
  registry.settle('pwsh-1');

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.deepEqual(tap.waiterIds(), []);
});

test('wait 包装：总超时到点返回运行中的视图，语义与原来一致', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-2', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0 });
  tap.install();

  const startedAt = Date.now();
  const result = await registry.wait('pwsh-2', 60, 's1');
  assert.equal(result.status, 'running');
  assert.ok(Date.now() - startedAt >= 55, '不应在总超时之前返回');
});

test('wait 包装：中断信号照旧拒绝，工具仍会走它自己的中止路径', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-3', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0 });
  tap.install();
  const controller = new AbortController();
  const pending = registry.wait('pwsh-3', 5000, 's1', controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /wait aborted/);
});

test('release：返回运行中的视图、进程不被结束，且原等待者已摘除', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-4', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 20, preparationGraceMs: 0 });
  tap.install();

  const pending = registry.wait('pwsh-4', 5000, 's1');
  await delay(30);
  assert.equal(tap.release('s1'), 1);

  const result = await pending;
  assert.equal(result.status, 'running');
  assert.equal(registry.store.get('pwsh-4').status, 'running');
  // 关键：释放后原 wait 的等待者已经摘除，任务真正结算时不会被判成「已取走」，
  // 模型的完成通知因此不会被吞掉。
  assert.equal(registry.pendingWaiters('pwsh-4'), 0);
});

test('release：只放行同会话的任务', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-5', 'pwsh', 's1');
  registry.spawn('pwsh-6', 'pwsh', 's2');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0 });
  tap.install();

  const first = registry.wait('pwsh-5', 5000, 's1');
  const second = registry.wait('pwsh-6', 5000, 's2');
  await delay(15);
  assert.equal(tap.release('s2'), 1);
  assert.equal((await second).status, 'running');

  registry.settle('pwsh-5');
  assert.equal((await first).status, 'completed');
});

test('release：只放行配置内的任务类型，其他 job 的等待不受影响', async () => {
  const registry = new FakeRegistry();
  registry.spawn('workflow-1', 'workflow', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0, kinds: ['pwsh', 'bash'] });
  tap.install();

  const pending = registry.wait('workflow-1', 5000, 's1');
  await delay(15);
  assert.equal(tap.release('s1'), 0);
  registry.settle('workflow-1');
  assert.equal((await pending).status, 'completed');
});

test('release：重复释放不重复计数，空会话与未登记会话是空操作', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-7', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0 });
  tap.install();

  const pending = registry.wait('pwsh-7', 5000, 's1');
  await delay(15);
  assert.equal(tap.release('s1'), 1);
  assert.equal(tap.release('s1'), 0);
  assert.equal(tap.release(undefined), 0);
  assert.equal(tap.release('unknown'), 0);
  assert.equal((await pending).status, 'running');
});

test('wait 包装：非法超时仍由原实现抛出它自己的错误', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-8', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0 });
  tap.install();
  await assert.rejects(registry.wait('pwsh-8', 0, 's1'), /invalid wait timeout/);
  await assert.rejects(registry.wait('pwsh-8', Number.NaN, 's1'), /invalid wait timeout/);
});

test('dispose：把 wait 还原成原型方法，不留下自有属性', async () => {
  const registry = new FakeRegistry();
  const original = FakeRegistry.prototype.wait;
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 0 });
  tap.install();
  assert.equal(Object.prototype.hasOwnProperty.call(registry, 'wait'), true);
  tap.dispose();
  assert.equal(registry.wait, original);
  assert.equal(Object.prototype.hasOwnProperty.call(registry, 'wait'), false);
});

test('isUserSteer：只认用户来源的插话', () => {
  const userMessage = { source: { kind: 'user' } };
  assert.equal(isUserSteer({ type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [userMessage] } }), true);
  assert.equal(isUserSteer({ type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [userMessage] } }), false);
  assert.equal(isUserSteer({ type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [{ source: { kind: 'plan' } }] } }), false);
  assert.equal(isUserSteer({ type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [] } }), false);
  assert.equal(isUserSteer({ type: 'agent/inbox/spliced', data: { target: 'next-step' } }), false);
  assert.equal(isUserSteer({ type: 'session/event' }), false);
  assert.equal(isUserSteer(null), false);
  assert.equal(isUserSteer(undefined), false);
});

test('apply：装上包装并订阅会话事件，用户插话时放行本会话的等待', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-9', 'pwsh', 's1');
  let listener;
  const scope = {
    jobs: registry,
    effect: (run) => (typeof run === 'function' ? run() : run),
  };
  const ctx = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['jobs']);
      callback(scope);
    },
    on: (name, handler) => {
      assert.equal(name, 'session/event');
      listener = handler;
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} },
  };

  applyBackgroundSend(ctx, { sliceMs: 10 });

  const pending = registry.wait('pwsh-9', 5000, 's1');
  await delay(15);
  listener({ id: 's1' }, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [{ source: { kind: 'user' } }] } });

  assert.equal((await pending).status, 'running');
  assert.equal(registry.store.get('pwsh-9').status, 'running');
});

test('apply：总开关关闭时完全不碰注册表', () => {
  const registry = new FakeRegistry();
  const original = registry.wait;
  let injected = false;
  const ctx = {
    inject: () => {
      injected = true;
    },
    on: () => () => {},
    logger: { info: () => {}, warn: () => {} },
  };
  applyBackgroundSend(ctx, { enabled: false });
  assert.equal(injected, false);
  assert.equal(registry.wait, original);
});

test('apply：注册表缺少可用 wait 时只记日志，不抛错', () => {
  const warnings = [];
  const ctx = {
    inject: (deps, callback) => callback({ jobs: { get: () => ({ status: 'running', kind: 'pwsh' }) }, effect: () => {} }),
    on: () => () => {},
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
  };
  assert.doesNotThrow(() => applyBackgroundSend(ctx, {}));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /未安装等待包装/);
});

test('normalizeConfig：缺省、非法与越界取值都回落到安全值', () => {
  assert.deepEqual(normalizeConfig(undefined), { enabled: true, kinds: ['pwsh', 'bash'], sliceMs: 250 });
  assert.deepEqual(normalizeConfig({ enabled: false }), { enabled: false, kinds: ['pwsh', 'bash'], sliceMs: 250 });
  assert.deepEqual(normalizeConfig({ kinds: ['pwsh', '', 3], sliceMs: 5 }), { enabled: true, kinds: ['pwsh'], sliceMs: 50 });
  assert.deepEqual(normalizeConfig({ sliceMs: 9_000 }), { enabled: true, kinds: ['pwsh', 'bash'], sliceMs: 1000 });
  assert.deepEqual(normalizeConfig({ kinds: [] }), { enabled: true, kinds: ['pwsh', 'bash'], sliceMs: 250 });
  assert.deepEqual(normalizeConfig('nonsense'), { enabled: true, kinds: ['pwsh', 'bash'], sliceMs: 250 });
});


test('release：收尾等待期间的中止照样抛出，工具仍会杀掉命令', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-10', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 30, preparationGraceMs: 0 });
  tap.install();

  const controller = new AbortController();
  const pending = registry.wait('pwsh-10', 5000, 's1', controller.signal);
  await delay(40);
  assert.equal(tap.release('s1'), 1);
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(pending, /wait aborted/);
});

test('release：任务刚注册时延迟唤醒，给进程 spawn 留出窗口', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-11', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 120 });
  tap.install();

  const startedAt = Date.now();
  const pending = registry.wait('pwsh-11', 5000, 's1');
  await delay(10);
  assert.equal(tap.release('s1'), 1);

  const view = await pending;
  const elapsed = Date.now() - startedAt;
  assert.equal(view.status, 'running');
  assert.ok(elapsed >= 100, `应当等到最小等待年龄之后再唤醒，实际 ${elapsed}ms`);
});

test('dispose：宽限期内的唤醒定时器会被撤掉，卸载后不再放走等待', async () => {
  const registry = new FakeRegistry();
  registry.spawn('pwsh-12', 'pwsh', 's1');
  const tap = createWaitTap({ jobs: registry, sliceMs: 10, preparationGraceMs: 200 });
  tap.install();

  const pending = registry.wait('pwsh-12', 5000, 's1');
  await delay(10);
  assert.equal(tap.release('s1'), 1);
  tap.dispose();
  await delay(250);
  registry.settle('pwsh-12');

  const view = await pending;
  assert.equal(view.status, 'completed');
});
