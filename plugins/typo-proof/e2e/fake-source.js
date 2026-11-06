/**
 * 预览页专用的假数据源。
 *
 * 插件本体已经没有演示模式了（面板只认真后端），但设计预览还得有东西可画：
 * 这份夹具只被 e2e/preview.html 用，不进插件、不进宿主。
 */

const DEMO_ITEMS = [
  {
    seg: 12,
    prev: '那年冬天特别冷，我住在城西一间没有暖气的出租屋里。',
    original: '那时候我每天都要花四个小时在论坛上回复贴子。',
    corrected: '那时候我每天都要花四个小时在论坛上回复帖子。',
    next: '回完之后手指都僵了，但心里是热的。',
    hits: 3,
    state: 'confirmed',
    samples: [
      '那时候我每天都要花四个小时在论坛上回复帖子。',
      '那时候我每天都要花四个小时在论坛上回复帖子。',
      '那时候我每天都要花四个小时在论坛上回复帖子。',
    ],
    note: '三次采样都改成了“帖子”。',
  },
  {
    seg: 35,
    prev: '我妈在电话里说了很久，最后叹了口气。',
    original: '我妈说我这样下去不是办法，迟早要担误了自己。',
    corrected: '我妈说我这样下去不是办法，迟早要耽误了自己。',
    next: '我嘴上应着，心里并不服气。',
    hits: 3,
    state: 'confirmed',
    samples: [
      '我妈说我这样下去不是办法，迟早要耽误了自己。',
      '我妈说我这样下去不是办法，迟早要耽误了自己。',
      '我妈说我这样下去不是办法，迟早要耽误了自己。',
    ],
    note: '三次采样都改成了“耽误”。',
  },
  {
    seg: 74,
    prev: '第一个月结账的时候，我盯着后台看了很久。',
    original: '第一个月的收入是三百二十块，我还记得那个数子。',
    corrected: '第一个月的收入是三百二十块，我还记得那个数字。',
    next: '三百二十块，连房租都不够。',
    hits: 2,
    state: 'disputed',
    samples: [
      '第一个月的收入是三百二十块，我还记得那个数字。',
      '第一个月的收入是三百二十块，我还记得那个数字。',
      '第一个月的收入是三百二十块，我还记得那个数目。',
    ],
    note: '两次判为“数字”，一次判为“数目”，需要人定夺。',
  },
  {
    seg: 118,
    prev: '那天下午我一直在等他的电话。',
    original: '他给我发了一条消息，说这批货以经发出去了。',
    corrected: '他给我发了一条消息，说这批货已经发出去了。',
    next: '我松了一口气，又有点慌。',
    hits: 3,
    state: 'confirmed',
    samples: [
      '他给我发了一条消息，说这批货已经发出去了。',
      '他给我发了一条消息，说这批货已经发出去了。',
      '他给我发了一条消息，说这批货已经发出去了。',
    ],
    note: '三次采样都改成了“已经”。',
  },
  {
    seg: 152,
    prev: '她说话的时候一直看着别处。',
    original: '那种感觉很奇妙，像是一下子被人看透了心是。',
    corrected: '那种感觉很奇妙，像是一下子被人看透了心事。',
    next: '我赶紧把话题岔开了。',
    hits: 2,
    state: 'disputed',
    samples: [
      '那种感觉很奇妙，像是一下子被人看透了心事。',
      '那种感觉很奇妙，像是一下子被人看透了心事。',
      '那种感觉很奇妙，像是一下子被人看透了心思。',
    ],
    note: '两次判为“心事”，一次判为“心思”，需要人定夺。',
  },
  {
    seg: 187,
    prev: '价格来来回回谈了好几轮。',
    original: '我在旺旺上跟他聊了两个小时，最后还是没谈陇。',
    corrected: '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
    next: '第二天他却在别家下了单。',
    hits: 3,
    state: 'confirmed',
    samples: [
      '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
      '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
      '我在旺旺上跟他聊了两个小时，最后还是没谈拢。',
    ],
    note: '三次采样都改成了“谈拢”。',
  },
  {
    seg: 205,
    prev: '毕业之后我先去了一家广告公司。',
    original: '我在那家公司做了三个月就辞职了。',
    corrected: '我在那家公司作了三个月就辞职了。',
    next: '现在想起来，那三个月也不是全无用处。',
    hits: 3,
    state: 'rejected',
    samples: [
      '我在那家公司作了三个月就辞职了。',
      '我在那家公司作了三个月就辞职了。',
      '我在那家公司作了三个月就辞职了。',
    ],
    note: '云端认为“做了三个月”用法正确，建议保留原文。',
  },
  {
    seg: 229,
    prev: '那段时间我几乎每天都在群里说话。',
    original: '9月中旬，我的群人数终于达到了1000人满人，需要清除一些人。',
    corrected: '9月中旬，我的群人数终于达到了1000人满员，需要清除一些人。',
    next: '踢人的时候我还犹豫了很久。',
    hits: 2,
    state: 'confirmed',
    samples: [
      '9月中旬，我的群人数终于达到了1000人满员，需要清除一些人。',
      '9月中旬，我的群人数终于达到了1000人满员，需要清除一些人。',
      '9月中旬，我的群人数终于达到了1000人满，需要清除一些人。',
    ],
    note: '两次改“满人”为“满员”；第三次只删了“人”，按同一处改动计。',
  },
  {
    seg: 231,
    prev: '那天下午我跑了三趟快递点。',
    original: '那天晚上我睡的特别早，第二天起来天还没亮。',
    corrected: '那天晚上我睡得特别早，第二天起来天还没亮。',
    next: '窗外的雨下了一整夜。',
    hits: 3,
    state: 'confirmed',
    samples: [
      '那天晚上我睡得特别早，第二天起来天还没亮。',
      '那天晚上我睡得特别早，第二天起来天还没亮。',
      '那天晚上我睡得特别早，第二天起来天还没亮。',
    ],
    note: '三次采样都改成了“睡得”。',
  },
];

/** 演示文件的元信息：直接用那本日记里的真实尺寸，进度条看起来才像真的。 */
const DEMO_META = {
  demo: true,
  file: '2011~2014.docx',
  dir: 'C:\\Users\\autod\\OneDrive\\旧事重提\\日记',
  segments: 234,
  hanzi: 16_916,
  localModel: 'lmstudio / qwen3-4b',
  reviewModel: 'deepseek-official / deepseek-flash',
  minHanzi: 8,
};

/**
 * 造一个假数据源。接口形状与 lib 那边给面板的一致：read / subscribe / start / pause / resume / stop。
 * @param {{ preload?: 'idle' | 'running' | 'done' }} [options] - 起点。
 * @returns {object} 假数据源。
 */
export function createFakeSource(options = {}) {
  const preload = options.preload === 'running' || options.preload === 'done' ? options.preload : 'idle';
  const listeners = new Set();
  let timer = null;
  let paused = false;

  /** 按起点拼一份状态。 */
  function build(stage) {
    if (stage === 'done') {
      return { ...DEMO_META, status: 'done', items: DEMO_ITEMS, progress: { localDone: 234, localTotal: 234, reviewDone: 9, reviewTotal: 9 } };
    }
    if (stage === 'running') {
      const half = DEMO_ITEMS.slice(0, 4);
      return { ...DEMO_META, status: 'running', items: half, progress: { localDone: 145, localTotal: 234, reviewDone: 2, reviewTotal: 4 } };
    }
    return { ...DEMO_META, status: 'idle', items: [], progress: {} };
  }

  let state = build(preload);
  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  return {
    kind: 'fake',
    /** @returns {Promise<object>} 当前状态。 */
    read() {
      return Promise.resolve(state);
    },
    /**
     * 订阅。
     * @param {(next: object) => void} listener - 回调。
     * @returns {() => void} 退订。
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      state = build('running');
      emit();
      if (timer !== null) clearInterval(timer);
      timer = setInterval(() => {
        if (paused) return;
        const done = state.items.length >= DEMO_ITEMS.length;
        state = done ? build('done') : { ...state, items: DEMO_ITEMS.slice(0, state.items.length + 1) };
        emit();
        if (done && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }, 200);
    },
    pause() {
      paused = true;
      state = { ...state, note: '已暂停' };
      emit();
    },
    resume() {
      paused = false;
      state = { ...state, note: '' };
      emit();
    },
    stop() {
      paused = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
      state = build('idle');
      emit();
    },
  };
}
