// 行为树内核：节点生命周期与状态机。
//
// 状态：idle -> running -> success | failure
// 生命周期钩子：
//   enter(ctx)   —— 节点从 idle 首次被驱动时调用，且只调用一次
//   tick(ctx)    —— running 期间每个更新步调用一次；不得重复 enter
//   exit(ctx, status) —— 终态（success/failure）时调用一次
// 打断协议：
//   abort(ctx, reason)   —— 高优先级分支抢占；沿运行路径向下传播，
//                           动作节点借此取消真实世界的异步意图（导航/动画/递交）
//   suspend(ctx)/resume(ctx) —— 暂挂语义：保留节点与异步操作状态，之后恢复
//
// 所有迁移都会写入 ctx.log，供界面检查与测试逐步核对。

export const Status = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILURE: 'failure',
});

let nextNodeId = 1;

export class Node {
  constructor(name) {
    this.id = nextNodeId++;
    this.name = name || `${this.constructor.name}#${this.id}`;
    this.status = Status.IDLE;
    this.suspended = false;
    this.enterCount = 0;
    this.exitCount = 0;
    this.lastExitStatus = null; // 'success' | 'failure' | 'aborted'
    this.parent = null;
  }

  addChild(child) {
    child.parent = this;
    return child;
  }

  // 由父节点（或测试）驱动。返回当前状态。
  run(ctx) {
    if (this.suspended) return this.status; // 暂挂中：本步不推进
    if (this.status === Status.IDLE) {
      this.status = Status.RUNNING;
      this.enterCount += 1;
      ctx.log({ type: 'enter', node: this.name, nodeId: this.id });
      this.enter(ctx);
    }
    if (this.status !== Status.RUNNING) return this.status;

    const result = this.tick(ctx);
    if (result !== Status.RUNNING) {
      this._finish(ctx, result);
    }
    return this.status;
  }

  _finish(ctx, status) {
    this.status = status;
    this.exitCount += 1;
    this.lastExitStatus = status;
    this.exit(ctx, status);
    ctx.log({ type: 'exit', node: this.name, nodeId: this.id, status });
  }

  // 抢占：取消语义。返回是否真的有运行中的子树被取消。
  abort(ctx, reason = 'preempted') {
    if (this.status !== Status.RUNNING) return false;
    this.onAbort(ctx, reason);
    this.status = Status.IDLE; // 被取消后回到 idle，下次进入会重新 enter
    this.exitCount += 1;
    this.lastExitStatus = 'aborted';
    ctx.log({ type: 'exit', node: this.name, nodeId: this.id, status: 'aborted', reason });
    this.exit(ctx, 'aborted');
    return true;
  }

  // 暂挂：保留 running 状态与异步操作，本分支暂停推进。
  suspend(ctx) {
    if (this.status !== Status.RUNNING || this.suspended) return false;
    this.suspended = true;
    this.onSuspend(ctx);
    ctx.log({ type: 'suspend', node: this.name, nodeId: this.id });
    return true;
  }

  resume(ctx) {
    if (!this.suspended) return false;
    this.suspended = false;
    this.onResume(ctx);
    ctx.log({ type: 'resume', node: this.name, nodeId: this.id });
    return true;
  }

  reset() {
    this.status = Status.IDLE;
    this.suspended = false;
    this.lastExitStatus = null;
    // 注意：enterCount/exitCount 是累计证据，不随重进清零
  }

  // —— 子类钩子 ——
  enter(_ctx) {}
  tick(_ctx) { return Status.SUCCESS; }
  exit(_ctx, _status) {}
  onAbort(_ctx, _reason) {}
  onSuspend(_ctx) {}
  onResume(_ctx) {}
}

export function resetTree(node) {
  node.reset();
  const children = node.children || (node.child ? [node.child] : []);
  for (const c of children) resetTree(c);
  if (node.body) resetTree(node.body);
  if (node.guard) resetTree(node.guard);
}

// 深度优先收集运行路径（供界面高亮与调试）
export function runningPath(node, out = []) {
  if (node.status === Status.RUNNING) {
    out.push(node);
    const children = node.children || (node.child ? [node.child] : []);
    for (const c of children) runningPath(c, out);
  }
  return out;
}
