// 节点类型 -> 进度迁移策略表。
//
// 热换版不允许「按序号直接继承旧状态」：先按稳定 key + 语义契约确认是同一节点，
// 再由本表决定该类型的运行进度怎样交接、哪些必须退出后重新进入。
//
// decision 含义：
//   resume-progress   —— 迁移运行进度（等待剩余时间 / 导航 token / 组合节点索引）
//   continue-op       —— 外部动作沿用同一 token，不签发第二份控制意图
//   resume-children   —— 并行/反应式：逐个按 key 迁移子节点
//   reset-reenter     —— 同 key 但契约改变：旧状态必须退出，新节点重新 enter
//   cancel-exit       —— 节点在新版消失：取消外部动作并释放资源（道具归还）
//   preserve-terminal —— 已完成的兼容动作保留终态，不重播

export const MIGRATION_TABLE = {
  Wait: {
    decision: 'resume-progress',
    resumable: true,
    progress: (node) => ({ remaining: node.remaining }),
    apply: (next, progress) => { next.remaining = progress.remaining; },
  },
  AsyncOpAction: {
    decision: 'continue-op',
    resumable: true,
    progress: (node) => ({ token: node.token }),
    apply: (next, progress) => { next.token = progress.token; },
  },
  Sequence: { decision: 'resume-progress', progress: (node) => ({ index: node.index }) },
  Selector: { decision: 'resume-progress', progress: (node) => ({ index: node.index }) },
  Parallel: { decision: 'resume-children' },
  ReactiveSelector: {
    decision: 'resume-children',
    progress: (node) => ({ runningIndex: node.runningIndex, suspendedIndex: node.suspendedIndex }),
  },
  GuardedBranch: { decision: 'resume-progress' },
  Scope: { decision: 'resume-progress' },
  RetryUntilSuccess: { decision: 'resume-progress', progress: (node) => ({ attempts: node.attempts }) },
  Inverter: { decision: 'resume-progress' },
  // 即时叶子：一个 tick 内即终结，跨版本只可能保留终态
  SpeakLine: { decision: 'preserve-terminal' },
  SetBlackboard: { decision: 'preserve-terminal' },
  Fail: { decision: 'preserve-terminal' },
  BlackboardEquals: { decision: 'preserve-terminal' },
  PropHeldBy: { decision: 'preserve-terminal' },
  Always: { decision: 'preserve-terminal' },
  MoveTo: { decision: 'continue-op' },
  FaceTarget: { decision: 'continue-op' },
  PlayAnim: { decision: 'continue-op' },
  HandOver: { decision: 'continue-op' },
};

// 向上查找节点类型的迁移策略（子类回落到最近的行为基类）
const CLASS_CHAIN = {
  MoveTo: 'AsyncOpAction', FaceTarget: 'AsyncOpAction', PlayAnim: 'AsyncOpAction', HandOver: 'AsyncOpAction',
};

export function migrationSpec(node) {
  const name = node.constructor.name;
  return MIGRATION_TABLE[name] || MIGRATION_TABLE[CLASS_CHAIN[name]] || null;
}

export function decisionLabel(decision) {
  switch (decision) {
    case 'resume-progress': return '迁移进度';
    case 'continue-op': return '沿用操作';
    case 'resume-children': return '迁移子节点';
    case 'reset-reenter': return '退出后重进';
    case 'cancel-exit': return '退出并释放';
    case 'preserve-terminal': return '保留终态';
    default: return decision;
  }
}
