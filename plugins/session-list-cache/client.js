window.__ModuleLoader__.load({
  id: '@local/session-list-cache',
  factory() {
    /*
     * 让会话列表先出内容、再对账。
     *
     * `/api/session/list` 是一个 POST 的 RPC，HTTP 缓存完全够不着它，而且它的响应
     * 有 1.08 MB JSON（gzip 后 369 KB）。每次冷启动都要等它回来侧栏才有内容，在
     * 慢速隧道上是接近两秒的白屏。
     *
     * 这个包把 fetch 包一层，只认这一个端点的 POST：命中本地缓存就立刻返回上次的
     * 内容，同时另发一次真实请求把缓存更新掉。界面上看到的是上一次启动时的列表——
     * 新顺序在下次进应用时生效。这次不追求热更：那要摸清 sessions list 的 store，
     * 收益却只是「本次就能看到」，不值得把确定性押上去。
     *
     * 任何一步出问题（没有存储、配额满、缓存损坏、后台回源失败）都必须等价于
     * 「没装这个插件」：直接走网络、保留旧缓存，绝不拦路。
     */

    /**
     * 缓存记录的版本。v1 存的是响应正文原文，回放时会把上次的 rpcId 一起交出去，
     * 客户端校验 rpcId 不一致就抛错；v2 只存 result，回放时按当前请求重建信封。
     */
    const RECORD_VERSION = 2;

    /** IndexedDB 的库名与对象仓库名。 */
    const DATABASE = 'dsh-list-cache';
    const TABLE = 'entries';

    /** 键前缀：同一个 origin 下不跟别的东西抢名字。 */
    const KEY_PREFIX = 'dsh-list-cache:v1:';

    /** 只认这个端点；客户端传的是相对路径（没有前导斜杠）。 */
    const ENDPOINT = /(^|\/)api\/session\/list(\?|$)/;

    /** 单条缓存的上限（字节），超过就不缓存（正常是 1.1 MB 左右）。 */
    const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

    /**
     * 一次读取最多等这么久。
     *
     * 命中的意义是「不等网络」，所以读取本身也不能变成新的等待：IndexedDB 在隐私策略、
     * 配额异常或首次建库时可能一直不回调，那样会把应用自己的列表请求一起挂住。
     * 超时就当作未命中，直接走网络。
     */
    const READ_TIMEOUT_MS = 250;

    /** 后台回源与存储失败只提示一次，避免每次请求都刷日志。 */
    let warned = false;

    function warnOnce(reason) {
      if (warned) return;
      warned = true;
      console.warn(`session-list-cache：${reason}（已退化为直连）`);
    }

    /**
     * 校验并补全配置。
     * @param {unknown} raw - Loader 行配置，可能是空对象或非对象。
     * @returns {{ enabled: boolean, maxBytes: number }} 归一化后的配置。
     */
    function normalizeConfig(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {};
      const maxBytes = Number(source.maxBytes);
      return {
        enabled: source.enabled !== false,
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES,
      };
    }

    /**
     * 按 UTF-8 字节数算长度：`maxBytes` 的语义是字节，而 `String#length` 数的是
     * UTF-16 码元，纯中文会差三倍。
     * @param {string} text - 待计量文本。
     * @returns {number} UTF-8 字节数。
     */
    function byteLength(text) {
      try {
        return new TextEncoder().encode(text).byteLength;
      } catch {
        // 极老的宿主没有 TextEncoder：退回上界估计，宁可少缓存也不越过配额。
        return text.length * 3;
      }
    }

    /**
     * 稳定序列化：同样的 args 必须得到同样的键，否则第二次启动一定命不中。
     * @param {unknown} value - 任意 JSON 值。
     * @returns {string} 排序过键的 JSON 文本。
     */
    function stableStringify(value) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }

    /** 内存兜底：没有持久化，但语义与命中一致（同一次页面生命周期内不再等网络）。 */
    function memoryStore() {
      const entries = new Map();
      return {
        kind: 'memory',
        async read(key) {
          return entries.get(key);
        },
        async write(key, value) {
          entries.set(key, value);
        },
        async remove(key) {
          entries.delete(key);
        },
      };
    }

    /** localStorage 兜底：1 MB 级的数据放得下，但要防配额异常。 */
    function localStorageStore(storage) {
      return {
        kind: 'localstorage',
        async read(key) {
          const raw = storage.getItem(key);
          if (raw === null || raw === undefined) return undefined;
          try {
            return JSON.parse(raw);
          } catch {
            // 记录坏了就当没缓存，顺手清掉，免得每次启动都白解析一次。
            storage.removeItem(key);
            return undefined;
          }
        },
        async write(key, value) {
          storage.setItem(key, JSON.stringify(value));
        },
        async remove(key) {
          storage.removeItem(key);
        },
      };
    }

    /** IndexedDB：单条 1 MB 级别放这里最稳，不跟 localStorage 的 5 MB 配额抢。 */
    function indexedDbStore(factory) {
      let opened;
      function open() {
        if (opened === undefined) {
          opened = new Promise((resolve, reject) => {
            const request = factory.open(DATABASE, 1);
            request.onupgradeneeded = () => {
              if (!request.result.objectStoreNames.contains(TABLE)) request.result.createObjectStore(TABLE);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            // 库打不开（被策略挡住、另一个标签页在升级）时要立刻失败，不能悬着。
            request.onblocked = () => reject(new Error('blocked'));
          });
        }
        return opened;
      }

      return {
        kind: 'indexeddb',
        async read(key) {
          const db = await open();
          return await new Promise((resolve, reject) => {
            const request = db.transaction(TABLE, 'readonly').objectStore(TABLE).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        },
        async write(key, value) {
          const db = await open();
          await new Promise((resolve, reject) => {
            const request = db.transaction(TABLE, 'readwrite').objectStore(TABLE).put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        },
        async remove(key) {
          const db = await open();
          await new Promise((resolve, reject) => {
            const request = db.transaction(TABLE, 'readwrite').objectStore(TABLE).delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        },
      };
    }

    /**
     * 把若干后端串成一条链：当前这一档出任何错就永久退到下一档，并把这次操作重试一遍。
     *
     * 「探测到 indexedDB 存在」不等于「它真的能用」——隐私模式、被策略阻止、配额为 0
     * 都会让 open/get 失败。只在构造时判断存在性，会让 localStorage 永远轮不到。
     * @param {Array<() => object>} factories - 按优先级排列的后端工厂。
     * @returns {object} 带 kind/read/write/remove 的存储。
     */
    function fallingStore(factories) {
      const built = [];
      let index = 0;

      function current() {
        if (built[index] === undefined) built[index] = factories[index]();
        return built[index];
      }

      async function run(method, ...args) {
        for (;;) {
          const backend = current();
          try {
            return await backend[method](...args);
          } catch (error) {
            if (index >= factories.length - 1) throw error;
            warnOnce(`${backend.kind} 不可用 ${String(error)}`);
            index += 1;
          }
        }
      }

      return {
        get kind() {
          return current().kind;
        },
        /**
         * 主动淘汰当前后端：挂死的后端不会自己报错（IndexedDB 的 open 可能永远不回调），
         * 只能由调用方在超时之后点名换掉，否则每次请求都要再等一遍超时。
         * @returns {boolean} 是否真的换到了下一档。
         */
        demote() {
          if (index >= factories.length - 1) return false;
          warnOnce(`${current().kind} 超时`);
          index += 1;
          return true;
        },
        read: (key) => run('read', key),
        write: (key, value) => run('write', key, value),
        remove: (key) => run('remove', key),
      };
    }

    /**
     * 按可用性排列后端。
     * 探测本身要包在 try 里：隐私模式下访问 localStorage 会直接抛 SecurityError。
     * @returns {object} 带降级的存储。
     */
    function createStore() {
      const factories = [];
      try {
        if (globalThis.indexedDB !== undefined && globalThis.indexedDB !== null) {
          factories.push(() => indexedDbStore(globalThis.indexedDB));
        }
      } catch {
        // 连访问都抛，就当没有 IndexedDB。
      }
      try {
        const storage = globalThis.localStorage;
        if (storage !== undefined && storage !== null) {
          storage.getItem(`${KEY_PREFIX}probe`);
          factories.push(() => localStorageStore(storage));
        }
      } catch {
        // 隐私模式：连探测都抛，跳过这一档。
      }
      factories.push(memoryStore);
      return fallingStore(factories);
    }

    /**
     * 把存储的异常吞成「读不到 / 写不进去」。
     * 存储只是加速手段，任何一次失败都不该让页面拿不到列表。
     * @param {object} store - 真实存储。
     * @returns {object} 不会抛错的存储包装。
     */
    function safeStore(store) {
      return {
        get kind() {
          try {
            return store.kind;
          } catch {
            return 'none';
          }
        },
        async read(key) {
          try {
            return await store.read(key);
          } catch (error) {
            warnOnce(`读取缓存失败 ${String(error)}`);
            return undefined;
          }
        },
        async write(key, value) {
          try {
            await store.write(key, value);
          } catch (error) {
            warnOnce(`写入缓存失败 ${String(error)}`);
          }
        },
        async remove(key) {
          try {
            await store.remove(key);
          } catch {
            // 删不掉不影响任何判断。
          }
        },
        /**
         * 把「当前后端不可用」这件事转告给底下那层。
         * @returns {boolean} 底下是否支持淘汰并且真的换了。
         */
        demote() {
          try {
            return typeof store.demote === 'function' ? store.demote() : false;
          } catch {
            return false;
          }
        },
      };
    }

    /**
     * 认出「这次调用是会话列表」，并取出它的缓存键与本次的 rpcId。
     * @param {unknown} input - fetch 的第一个参数。
     * @param {object} init - fetch 的第二个参数。
     * @returns {{ key: string, rpcId: unknown } | null} 命中判定；不是目标请求就返回 null。
     */
    function matchRequest(input, init) {
      if (init === null || init === undefined) return null;
      if (typeof init.method !== 'string' || init.method.toUpperCase() !== 'POST') return null;
      // Request 对象的 body 只能读一次，读掉就把原请求弄坏了，所以只处理字符串 URL。
      if (typeof input !== 'string') return null;
      if (!ENDPOINT.test(input)) return null;
      if (typeof init.body !== 'string') return null;

      let message;
      try {
        message = JSON.parse(init.body);
      } catch {
        return null;
      }
      if (message === null || typeof message !== 'object') return null;
      if (message.type !== 'client-request' || message.method !== 'session/list') return null;

      const args = message.payload === null || typeof message.payload !== 'object' ? {} : message.payload.args;
      return {
        key: `${KEY_PREFIX}session/list:${stableStringify(args ?? {})}`,
        rpcId: message.rpcId,
      };
    }

    /**
     * 把一次成功响应的 result 写进缓存。
     *
     * 只认 `result.ok === true`：gateway 的业务失败也是 HTTP 200 的 JSON 信封，
     * 把一次临时失败存下来，会让后面每次启动都先把那个错误交还给界面。
     * @param {object} store - 缓存存储。
     * @param {string} key - 缓存键。
     * @param {number} maxBytes - 单条上限（字节）。
     * @param {Response} response - 真实响应。
     * @returns {Promise<void>}
     */
    async function remember(store, key, maxBytes, response) {
      // clone 必须在任何人读 body 之前同步完成，否则这里会抛。
      const copy = response.clone();
      if (!response.ok) return;
      const type = response.headers.get('content-type') ?? '';
      if (!type.toLowerCase().includes('application/json')) return;

      const body = await copy.text();
      if (byteLength(body) > maxBytes) {
        await store.remove(key);
        return;
      }

      let envelope;
      try {
        envelope = JSON.parse(body);
      } catch {
        return;
      }
      if (envelope === null || typeof envelope !== 'object') return;
      if (envelope.result === null || typeof envelope.result !== 'object') return;
      if (envelope.result.ok !== true) return;

      await store.write(key, { v: RECORD_VERSION, savedAt: Date.now(), result: envelope.result });
    }

    /**
     * 用缓存的 result 按**本次请求**的 rpcId 重建响应信封。
     *
     * 客户端会校验响应里的 rpcId 与自己发出去的一致（不一致直接抛），所以不能把上次
     * 的响应原文交回去——那正是缓存一上线就坏的原因。
     * @param {unknown} result - 缓存的 result。
     * @param {unknown} rpcId - 本次请求的 rpcId。
     * @returns {Response} 与真实响应同形的响应。
     */
    function cachedResponse(result, rpcId) {
      return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    /**
     * 安装 fetch 包装。
     * @param {{ maxBytes: number }} config - 归一化后的配置。
     * @returns {() => void} 还原器。
     */
    function install(config) {
      const original = globalThis.fetch;
      if (typeof original !== 'function') return () => {};

      const store = safeStore(createStore());
      // 用函数而不是快照：降级是在运行时发生的，装上的那一刻还不知道最终用哪一档。
      globalThis.__dshSessionListCache = () => store.kind;
      // 每个页面只打一两行，留在 debug 级别：排查「到底有没有命中」只能靠它。
      console.debug(`[session-list-cache] 安装于 ${Math.round(performance.now())}ms，后端 ${store.kind}`);

      /** 后台回源：只更新缓存，不影响本次返回。 */
      async function revalidate(input, init, key) {
        try {
          const response = await original.call(globalThis, input, init);
          await remember(store, key, config.maxBytes, response);
        } catch {
          // 回源失败就保留旧缓存：下次启动仍能用上次的内容。
        }
      }

      /** 带超时的读取：超时按未命中处理并淘汰该后端，绝不把应用的请求挂在这里。 */
      async function readCached(key) {
        const timeoutMarker = { timeout: true };
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve(timeoutMarker), READ_TIMEOUT_MS);
        });
        try {
          const value = await Promise.race([store.read(key), timeout]);
          if (value !== timeoutMarker) return value;
          // 超时说明这一档靠不住：换掉它，否则后续每次请求都要再等满一个超时。
          store.demote();
          return undefined;
        } finally {
          clearTimeout(timer);
        }
      }

      async function wrapped(input, init) {
        const hit = matchRequest(input, init);
        if (hit === null) return original.call(globalThis, input, init);

        const started = performance.now();
        const cached = await readCached(hit.key);
        const elapsed = Math.round(performance.now() - started);
        const usable =
          cached !== undefined &&
          cached !== null &&
          cached.v === RECORD_VERSION &&
          typeof cached.result === 'object' &&
          cached.result !== null;
        console.debug(
          `[session-list-cache] ${usable ? '命中' : '未命中'} @${Math.round(started)}ms，读取 ${elapsed}ms，` +
            `后端 ${store.kind}，记录 ${cached === undefined || cached === null ? '空' : `v${cached.v}`}`,
        );
        if (usable) {
          void revalidate(input, init, hit.key);
          return cachedResponse(cached.result, hit.rpcId);
        }

        const response = await original.call(globalThis, input, init);
        void remember(store, hit.key, config.maxBytes, response);
        return response;
      }

      globalThis.fetch = wrapped;
      return () => {
        if (globalThis.fetch === wrapped) globalThis.fetch = original;
        delete globalThis.__dshSessionListCache;
      };
    }

    return {
      apply(ctx, rawConfig) {
        const config = normalizeConfig(rawConfig);
        if (!config.enabled) return;
        ctx.effect(
          () => install(config),
          'session-list-cache: reuse the last session list while the real one loads',
        );
      },
    };
  },
});
