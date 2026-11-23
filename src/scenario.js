// 演出场景：可运行的行为树定义 + 世界初始状态。
// 这棵树包含：等待（wait）、条件变化（反应式守卫）、动作失败（moveTo 被堵 + 兜底重试）、
// 异步道具递交（handOver，含取消/暂挂两种抢占语义）。

export const STAGE = {
  actors: [
    { id: 'A', x: -5, z: 2, color: 0x4f8ef7 },
    { id: 'B', x: 3, z: -1, color: 0xf7954f },
  ],
  props: [{ id: 'prop1', holder: 'A' }],
  exitPoint: { x: -7, z: -4 },
};

export const DEFAULT_TREE = {
  type: 'reactiveSelector',
  name: '演出根节点',
  abortModeKey: 'interrupt.mode',
  children: [
    {
      type: 'guarded',
      name: '高优先级:叫离',
      guard: { type: 'bbEquals', name: '条件:被叫离?', key: 'calledAway', value: true },
      body: {
        type: 'sequence',
        name: '叫离流程',
        children: [
          { type: 'speakLine', name: '台词:马上回来', actor: 'A', text: '导演叫我，马上回来！' },
          { type: 'moveTo', name: '走向侧台', actor: 'A', target: { x: -7, z: -4 } },
          { type: 'wait', name: '台后等待', duration: 1.5 },
          { type: 'moveTo', name: '返回舞台', actor: 'A', target: { x: 0, z: 2 } },
          { type: 'setBlackboard', name: '清除叫离标记', key: 'calledAway', value: false },
          { type: 'speakLine', name: '台词:回来了', actor: 'A', text: '我回来了，继续演出！' },
        ],
      },
    },
    {
      type: 'guarded',
      name: '主演出分支',
      guard: { type: 'always', name: '条件:总是' },
      body: {
        type: 'retry',
        name: '失败重试(≤20)',
        maxAttempts: 20,
        child: {
          type: 'selector',
          name: '主流程或兜底',
          children: [
            {
              type: 'sequence',
              name: '主演出',
              children: [
                { type: 'moveTo', name: '走向B', actor: 'A', target: { actor: 'B', offset: { x: 0, z: 1.4 } } },
                { type: 'faceTarget', name: '面向B', actor: 'A', target: { actor: 'B' } },
                {
                  type: 'scope',
                  name: '递交作用域',
                  scopeName: 'handover',
                  child: {
                    type: 'sequence',
                    name: '递交道具',
                    children: [
                      { type: 'speakLine', name: '台词:请收下', actor: 'A', text: '请收下这个道具。' },
                      {
                        type: 'handOver', name: '递交道具', prop: 'prop1', giver: 'A', receiver: 'B',
                        passDuration: 1.2, confirmDelay: 1.0, confirmLine: '谢谢，道具我收到了！',
                      },
                      { type: 'speakLine', name: '台词:持有人接词', actor: 'bb:propHolder', text: '道具在我这里，演出继续。' },
                    ],
                  },
                },
                { type: 'playAnim', name: '谢幕鞠躬', actor: 'bb:propHolder', clip: 'bow', duration: 1.0 },
              ],
            },
            {
              type: 'sequence',
              name: '兜底:通道被堵',
              children: [
                { type: 'speakLine', name: '台词:路被堵', actor: 'A', text: '通道被堵住了，稍等……' },
                { type: 'wait', name: '等待疏通', duration: 2.0 },
                { type: 'fail', name: '失败以触发重试' },
              ],
            },
          ],
        },
      },
    },
  ],
};

export function initialBlackboardEntries() {
  return {
    calledAway: false,
    'interrupt.mode': 'cancel',
    propHolder: 'A',
  };
}
