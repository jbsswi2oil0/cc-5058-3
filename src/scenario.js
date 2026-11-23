// 演出场景：可运行的行为树定义 + 世界初始状态。
// 这棵树包含：等待（wait）、条件变化（反应式守卫）、动作失败（moveTo 被堵 + 兜底重试）、
// 异步道具递交（handOver，含取消/暂挂两种抢占语义）。
//
// 每个需要跨版本保留进度的节点都带稳定 key。热换版只按 key + 语义契约匹配，
// 绝不按节点序号/数组下标继承状态。

export const STAGE = {
  actors: [
    { id: 'A', x: -5, z: 2, color: 0x4f8ef7 },
    { id: 'B', x: 3, z: -1, color: 0xf7954f },
  ],
  props: [{ id: 'prop1', holder: 'A' }],
  exitPoint: { x: -7, z: -4 },
};

// 黑板契约：键 -> 期望类型。候选树校验与换版后类型检查共用。
export const BLACKBOARD_CONTRACT = {
  calledAway: 'boolean',
  'interrupt.mode': 'string',
  propHolder: 'string',
};

export const DEFAULT_TREE = {
  type: 'reactiveSelector',
  key: 'root',
  name: '演出根节点',
  abortModeKey: 'interrupt.mode',
  children: [
    {
      type: 'guarded',
      key: 'interrupt',
      name: '高优先级:叫离',
      guard: { type: 'bbEquals', key: 'interrupt.guard', name: '条件:被叫离?', bbKey: 'calledAway', value: true },
      body: {
        type: 'sequence',
        key: 'interrupt.flow',
        name: '叫离流程',
        children: [
          { type: 'speakLine', key: 'interrupt.line1', name: '台词:马上回来', actor: 'A', text: '导演叫我，马上回来！' },
          { type: 'moveTo', key: 'interrupt.exit', name: '走向侧台', actor: 'A', target: { x: -7, z: -4 } },
          { type: 'wait', key: 'interrupt.wait', name: '台后等待', duration: 1.5 },
          { type: 'moveTo', key: 'interrupt.return', name: '返回舞台', actor: 'A', target: { x: 0, z: 2 } },
          { type: 'setBlackboard', key: 'interrupt.clear', name: '清除叫离标记', bbKey: 'calledAway', value: false },
          { type: 'speakLine', key: 'interrupt.line2', name: '台词:回来了', actor: 'A', text: '我回来了，继续演出！' },
        ],
      },
    },
    {
      type: 'guarded',
      key: 'main',
      name: '主演出分支',
      guard: { type: 'always', key: 'main.guard', name: '条件:总是' },
      body: {
        type: 'retry',
        key: 'main.retry',
        name: '失败重试(≤20)',
        maxAttempts: 20,
        child: {
          type: 'selector',
          key: 'main.or',
          name: '主流程或兜底',
          children: [
            {
              type: 'sequence',
              key: 'main.seq',
              name: '主演出',
              children: [
                { type: 'moveTo', key: 'main.moveB', name: '走向B', actor: 'A', target: { actor: 'B', offset: { x: 0, z: 1.4 } } },
                { type: 'faceTarget', key: 'main.faceB', name: '面向B', actor: 'A', target: { actor: 'B' } },
                {
                  type: 'scope',
                  key: 'handover.scope',
                  name: '递交作用域',
                  scopeName: 'handover',
                  child: {
                    type: 'sequence',
                    key: 'handover.seq',
                    name: '递交道具',
                    children: [
                      { type: 'speakLine', key: 'handover.offer', name: '台词:请收下', actor: 'A', text: '请收下这个道具。' },
                      {
                        type: 'handOver', key: 'handover.op', name: '递交道具', prop: 'prop1', giver: 'A', receiver: 'B',
                        passDuration: 1.2, confirmDelay: 1.0, confirmLine: '谢谢，道具我收到了！',
                      },
                      { type: 'speakLine', key: 'handover.holderLine', name: '台词:持有人接词', actor: 'bb:propHolder', text: '道具在我这里，演出继续。' },
                    ],
                  },
                },
                { type: 'playAnim', key: 'main.bow', name: '谢幕鞠躬', actor: 'bb:propHolder', clip: 'bow', duration: 1.0 },
              ],
            },
            {
              type: 'sequence',
              key: 'fallback.seq',
              name: '兜底:通道被堵',
              children: [
                { type: 'speakLine', key: 'fallback.line', name: '台词:路被堵', actor: 'A', text: '通道被堵住了，稍等……' },
                { type: 'wait', key: 'fallback.wait', name: '等待疏通', duration: 2.0 },
                { type: 'fail', key: 'fallback.fail', name: '失败以触发重试' },
              ],
            },
          ],
        },
      },
    },
  ],
};

// —— 热换版样例 ——
// v2：递交分支里插入一个新动作（增加一句台词），其余 key 与契约不变。
// 预期：已完成动作保留、当前动作按 key 迁移；只重放「最近兼容表演标记」以下的变化。
export function treeV2() {
  const def = JSON.parse(JSON.stringify(DEFAULT_TREE));
  const seq = findDefByKey(def, 'handover.seq');
  seq.children.splice(1, 0, {
    type: 'playAnim', key: 'handover.prepare', name: '递交前整理衣领', actor: 'A', clip: 'adjust', duration: 0.8,
  });
  return def;
}

// v3：删除「谢幕鞠躬」整段正在运行/待运行分支，验证动作退出与资源释放。
export function treeV3RemoveBow() {
  const def = JSON.parse(JSON.stringify(DEFAULT_TREE));
  const seq = findDefByKey(def, 'main.seq');
  seq.children = seq.children.filter((c) => c.key !== 'main.bow');
  return def;
}

// v4：把递交动作改成契约不同的「收回」语义（同 key，动作含义已变）。
// 预期：不得用旧进度续演；旧递交明确退出、道具归还，新动作重新进入。
export function treeV4ChangedHandover() {
  const def = JSON.parse(JSON.stringify(DEFAULT_TREE));
  const op = findDefByKey(def, 'handover.op');
  op.giver = 'B';
  op.receiver = 'A';
  return def;
}

export function findDefByKey(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (node.key === key) return node;
  if (node.guard && node.guard.key === key) return node.guard;
  if (node.body && node.body.key === key) return node.body;
  const pools = [node.children, node.body ? [node.body] : null, node.child ? [node.child] : null, node.guard ? [node.guard] : null];
  for (const pool of pools) {
    if (!pool) continue;
    for (const c of pool) {
      const hit = findDefByKey(c, key);
      if (hit) return hit;
    }
  }
  return null;
}

export function initialBlackboardEntries() {
  return {
    calledAway: false,
    'interrupt.mode': 'cancel',
    propHolder: 'A',
  };
}
