/**
 * 浏览器半边：把“刚有活动”的工作区升到工作区列表最上方，并把该会话行升到组内第一。
 *
 * 为什么必须这样写：
 * 1. 侧栏的分组顺序就是 Host 的注册顺序，客户端没有本地组排序列，所以搬动整个分组
 *    只能走 workspaces.insertBefore —— 与侧栏拖拽用的是同一个接口，顺序会持久化。
 * 2. 组内会话行在“最后更新”模式下按 updatedAt 排序，而 Host 只在用户发消息时推进它；
 *    要让 AI 跑完也能上浮，只能调 sessions.handleSessionActivity。该方法在运行时可用，
 *    但不在 ISessions 的公开契约里（只出现在具体类上），所以升级后可能失效，见 README。
 */
window.__ModuleLoader__.load({
  id: '@local/session-activity-order',
  factory(require) {
    /**
     * 会话 → 活动快照。
     *
     * 不写 instanceof Map：单测在 vm 沙箱里执行，跨 realm 时原型不同会误判。
     * 缺失的会话摘要直接跳过：没摘要就没法判断归属与时间。
     */
    function buildSnapshot(list, statuses) {
      const snapshot = new Map();
      const ids = Array.isArray(list?.ids) ? list.ids : [];
      const byId = list?.byId ?? {};
      for (const id of ids) {
        const row = byId[id];
        if (row === undefined || row === null) continue;
        const status =
          statuses !== undefined && statuses !== null && typeof statuses.get === 'function'
            ? statuses.get(id)
            : undefined;
        snapshot.set(id, {
          running: status?.running ?? row.running === true,
          pending: status?.pendingInteraction?.kind ?? null,
          unread: status?.completionUnread === true,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
          blank: row.blank === true,
          hidden: row.origin === 'subagent',
        });
      }
      return snapshot;
    }

    /**
     * 对比两帧快照，返回本帧“发生活动”的会话。
     *
     * 首帧（没有上一帧）不产出任何活动：刚打开页面时每个会话都像“刚变了”，
     * 若那时就升序，刷新一次列表就被打乱。
     * blank 与 subagent 会话始终跳过：前者由官方常驻首位，后者根本不可见。
     * own 记录本插件自己写入的 updatedAt，命中它就说明这次时间变化不是用户发的消息。
     */
    function diffActivity(prev, next, own) {
      const active = [];
      for (const [id, cur] of next) {
        if (cur.hidden || cur.blank) continue;
        const before = prev.get(id);
        if (before === undefined) continue;
        const selfTs = own.get(id);
        const selfBumped = selfTs !== undefined && cur.updatedAt <= selfTs;
        const changed =
          (!before.running && cur.running) ||
          (before.running && !cur.running) ||
          (before.pending === null && cur.pending !== null) ||
          (!before.unread && cur.unread) ||
          (cur.updatedAt > before.updatedAt && !selfBumped);
        if (changed) active.push(id);
      }
      return active;
    }

    /**
     * 算出这次该把哪个工作区挪到哪个 anchor 之前。
     *
     * 恒取“当前整列第一个”作 anchor：侧栏默认是分组视图，所有工作区都在同一层，
     * 按路径算同级兄弟会让嵌套目录下的工作区永远升不上去（在默认视图里它本来就是顶层分组）。
     * 已经在第一位就返回 null，避免无意义的写入与动画。
     */
    function pickPromotion(sessionId, workspaces) {
      const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
      if (items.length === 0) return null;
      const owner = items.find(
        (workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId),
      );
      if (owner === undefined) return null;
      const first = items[0];
      if (first === undefined || first.workspaceId === owner.workspaceId) return null;
      return { workspaceId: owner.workspaceId, anchorId: first.workspaceId };
    }

    return {
      // 只声明确认存在的服务：uiSession 若也写进 inject，一旦它没注册，
      // Cordis 会一直等它，整个插件静默不执行——连分会话行都不做。
      // 它只提供“等你处理 / 未读”两个附加信号，缺失时降级即可（见 readStatuses）。
      inject: ['sessions', 'workspaces'],
      apply(ctx) {
        // 加载自检：控制台打一行，说明插件进页面了，并报告两个宿主接口是否可用。
        // 没有这一行就说明 bundle 没被加载——新增的 bundle 行需要重启 DSH 主进程，仅刷新页面不够。
        try {
          console.info(
            `[session-activity-order] 已加载；insertBefore=${typeof ctx.workspaces?.insertBefore}，` +
              `handleSessionActivity=${typeof ctx.sessions?.handleSessionActivity}`,
          );
        } catch (error) {
          // 自检不应阻断插件
        }

        let stopped = false;
        let baselineReady = false;
        let prev = new Map();
        /** 本插件写入的 updatedAt；用来区分“用户发消息”与“我自己升的行”。 */
        const own = new Map();
        const warned = new Set();
        let sessionsDispose;
        let statusDispose;
        let retryTimer;
        /** 搬移串行化：每次执行前重算 anchor，避免同帧多个活动共用过期 anchor。 */
        let moveChain = Promise.resolve();

        const warnOnce = (key, error) => {
          if (warned.has(key)) return;
          warned.add(key);
          console.warn(`[session-activity-order] ${key}`, error);
        };

        /** uiSession 可能尚未注册：拿不到就退化为只用列表信号，核心功能不受影响。 */
        const statusSource = () => {
          try {
            const source = ctx.uiSession?.sessionStatus;
            return source !== undefined && typeof source.subscribe === 'function' ? source : undefined;
          } catch (error) {
            warnOnce('read-ui-session', error);
            return undefined;
          }
        };

        const readStatuses = () => {
          try {
            const source = statusSource();
            if (source === undefined || typeof source.getSnapshot !== 'function') return undefined;
            return source.getSnapshot();
          } catch (error) {
            warnOnce('read-status', error);
            return undefined;
          }
        };

        const attachStatus = () => {
          if (stopped || statusDispose !== undefined) return;
          const source = statusSource();
          if (source === undefined) return;
          try {
            statusDispose = source.subscribe(tick);
          } catch (error) {
            warnOnce('subscribe-status', error);
            // 标记为已尝试，避免每帧重复报错
            statusDispose = () => {};
          }
        };

        const readSnapshot = () => buildSnapshot(ctx.sessions.list.getSnapshot(), readStatuses());

        const pruneOwn = (next) => {
          for (const [id, ts] of own) {
            const current = next.get(id);
            if (current === undefined || current.updatedAt >= ts) own.delete(id);
          }
        };

        const moveWorkspace = async (sessionId) => {
          if (stopped) return;
          let target;
          try {
            target = pickPromotion(sessionId, ctx.workspaces.list.getSnapshot());
          } catch (error) {
            warnOnce('read-workspaces', error);
            return;
          }
          if (target === null) return;
          try {
            await ctx.workspaces.insertBefore(target.workspaceId, target.anchorId);
          } catch (error) {
            warnOnce('move-workspace', error);
          }
        };

        const promote = (sessionId, floor) => {
          // 取 max(本地时钟, 该行当前时间 + 1)：浏览器与 Host 不同机时时钟可能偏慢，
          // 直接用 Date.now() 会被 applyMutation 的“只进不退”静默丢弃，行就不会上浮。
          const now = Math.max(Date.now(), (Number.isFinite(floor) ? floor : 0) + 1);
          own.set(sessionId, now);
          try {
            ctx.sessions.handleSessionActivity(sessionId, now);
          } catch (error) {
            warnOnce('advance-session-activity', error);
          }
          moveChain = moveChain.then(() => moveWorkspace(sessionId)).catch((error) => {
            warnOnce('move-chain', error);
          });
        };

        const tick = () => {
          if (stopped) return;
          attachStatus();
          let next;
          try {
            next = readSnapshot();
          } catch (error) {
            warnOnce('read-snapshot', error);
            return;
          }
          if (!baselineReady) {
            prev = next;
            baselineReady = true;
            return;
          }
          const previous = prev;
          prev = next;
          let active;
          try {
            active = diffActivity(previous, next, own);
          } catch (error) {
            warnOnce('diff-activity', error);
            return;
          }
          pruneOwn(next);
          for (const sessionId of active) promote(sessionId, next.get(sessionId)?.updatedAt ?? 0);
        };

        ctx.effect(() => {
          sessionsDispose = ctx.sessions.list.subscribe(tick);
          attachStatus();
          // uiSession 晚到时列表未必再变化，补一次延迟注册；成功注册后不再需要。
          if (statusDispose === undefined && typeof setTimeout === 'function') {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              attachStatus();
            }, 1000);
          }
          return () => {
            stopped = true;
            if (retryTimer !== undefined) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            if (sessionsDispose !== undefined) {
              try {
                sessionsDispose();
              } catch (error) {
                // 退订失败不应阻断卸载，其余订阅仍需清理
              }
              sessionsDispose = undefined;
            }
            if (statusDispose !== undefined) {
              try {
                statusDispose();
              } catch (error) {
                // 同上
              }
              statusDispose = undefined;
            }
          };
        }, 'session-activity-order: 订阅会话与状态');

        tick();
      },
      // 供单测使用：把纯函数暴露出来，测试直接跑真实实现，避免复制一份逻辑。
      __internals: { buildSnapshot, diffActivity, pickPromotion },
    };
  },
});
