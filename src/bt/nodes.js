// 组合节点与装饰节点。
// 组合节点本身不产生副作用，它们依据子节点返回的「真实动作结果」
// （success / failure / running）决定后续分支。

import { Node, Status, resetTree } from './kernel.js';

// —— 顺序：任一子节点失败即失败，全部成功才成功 ——
export class Sequence extends Node {
  constructor(name, children = []) {
    super(name);
    this.children = children.map((c) => this.addChild(c));
    this.index = 0;
  }
  enter() {
    this.index = 0;
    for (const c of this.children) resetTree(c); // 重进时子树回到 idle，保证重演
  }
  tick(ctx) {
    while (this.index < this.children.length) {
      const st = this.children[this.index].run(ctx);
      if (st === Status.RUNNING) return Status.RUNNING;
      if (st === Status.FAILURE) return Status.FAILURE;
      this.index += 1;
    }
    return Status.SUCCESS;
  }
  onAbort(ctx, reason) {
    const c = this.children[this.index];
    if (c && c.status === Status.RUNNING) c.abort(ctx, reason);
  }
  onSuspend(ctx) {
    const c = this.children[this.index];
    if (c && c.status === Status.RUNNING) c.suspend(ctx);
  }
  onResume(ctx) {
    const c = this.children[this.index];
    if (c && c.suspended) c.resume(ctx);
  }
}

// —— 选择（兜底）：任一子节点成功即成功 ——
export class Selector extends Node {
  constructor(name, children = []) {
    super(name);
    this.children = children.map((c) => this.addChild(c));
    this.index = 0;
  }
  enter() {
    this.index = 0;
    for (const c of this.children) resetTree(c);
  }
  tick(ctx) {
    while (this.index < this.children.length) {
      const st = this.children[this.index].run(ctx);
      if (st === Status.RUNNING) return Status.RUNNING;
      if (st === Status.SUCCESS) return Status.SUCCESS;
      this.index += 1;
    }
    return Status.FAILURE;
  }
  onAbort(ctx, reason) {
    const c = this.children[this.index];
    if (c && c.status === Status.RUNNING) c.abort(ctx, reason);
  }
  onSuspend(ctx) {
    const c = this.children[this.index];
    if (c && c.status === Status.RUNNING) c.suspend(ctx);
  }
  onResume(ctx) {
    const c = this.children[this.index];
    if (c && c.suspended) c.resume(ctx);
  }
}

// —— 并行：全部成功才成功，任一失败即失败（中止其余） ——
export class Parallel extends Node {
  constructor(name, children = []) {
    super(name);
    this.children = children.map((c) => this.addChild(c));
  }
  enter() { for (const c of this.children) resetTree(c); }
  tick(ctx) {
    let allDone = true;
    for (const c of this.children) {
      if (c.status === Status.SUCCESS) continue;
      if (c.status === Status.FAILURE) return Status.FAILURE;
      const st = c.run(ctx);
      if (st === Status.FAILURE) {
        for (const o of this.children) {
          if (o !== c && o.status === Status.RUNNING) o.abort(ctx, 'parallel-sibling-failed');
        }
        return Status.FAILURE;
      }
      if (st === Status.RUNNING) allDone = false;
    }
    return allDone ? Status.SUCCESS : Status.RUNNING;
  }
  onAbort(ctx, reason) {
    for (const c of this.children) if (c.status === Status.RUNNING) c.abort(ctx, reason);
  }
  onSuspend(ctx) {
    for (const c of this.children) if (c.status === Status.RUNNING) c.suspend(ctx);
  }
  onResume(ctx) {
    for (const c of this.children) if (c.suspended) c.resume(ctx);
  }
}

// —— 守卫分支：guard 为即时条件节点，body 为子树 ——
export class GuardedBranch extends Node {
  constructor(name, guard, body) {
    super(name);
    this.guard = guard;
    this.guard.parent = this;
    this.body = this.addChild(body);
  }
  evalGuard(ctx) {
    this.guard.reset();
    return this.guard.run(ctx) === Status.SUCCESS;
  }
  tick(ctx) {
    if (this.body.status === Status.SUCCESS || this.body.status === Status.FAILURE) {
      resetTree(this.body); // 上次已终结：重进前复位
    }
    return this.body.run(ctx);
  }
  onAbort(ctx, reason) { if (this.body.status === Status.RUNNING) this.body.abort(ctx, reason); }
  onSuspend(ctx) { if (this.body.status === Status.RUNNING) this.body.suspend(ctx); }
  onResume(ctx) { if (this.body.suspended) this.body.resume(ctx); }
}

// —— 反应式选择器：每个更新步都重新评估优先级。
// 高优先级分支成立时抢占当前分支：按黑板 abortModeKey 决定
// 取消（abort，子树回到 idle，之后重进）或暂挂（suspend，保留现场之后恢复）。
// 最后一个子分支视为「主分支」：根的结果由主分支决定；
// 打断分支完成后根继续运行（恢复暂挂分支或重评守卫）。
export class ReactiveSelector extends Node {
  constructor(name, children = [], abortModeKey = 'interrupt.mode') {
    super(name);
    this.children = children.map((c) => this.addChild(c));
    this.abortModeKey = abortModeKey;
    this.mainIndex = children.length - 1;
    this.runningIndex = -1;
    this.suspendedIndex = -1;
  }
  enter() { this.runningIndex = -1; this.suspendedIndex = -1; }
  tick(ctx) {
    let selected = -1;
    for (let i = 0; i < this.children.length; i++) {
      const branch = this.children[i];
      const ok = branch instanceof GuardedBranch ? branch.evalGuard(ctx) : true;
      if (ok) { selected = i; break; }
    }
    if (selected === -1) {
      if (this.runningIndex !== -1) {
        this.children[this.runningIndex].abort(ctx, 'no-guard-passed');
        this.runningIndex = -1;
      }
      return Status.FAILURE;
    }
    if (this.runningIndex !== -1 && selected !== this.runningIndex) {
      if (selected < this.runningIndex) {
        const mode = ctx.bb.get(this.abortModeKey) || 'cancel';
        const cur = this.children[this.runningIndex];
        ctx.log({ type: 'preempt', node: this.name, from: cur.name, to: this.children[selected].name, mode });
        if (mode === 'suspend') {
          cur.suspend(ctx);
          this.suspendedIndex = this.runningIndex;
        } else {
          cur.abort(ctx, 'preempted-by-higher-priority');
        }
      } else {
        selected = this.runningIndex; // 当前分支优先级更高，继续
      }
    }
    this.runningIndex = selected;
    const child = this.children[selected];
    if (child.suspended) child.resume(ctx);
    const st = child.run(ctx);
    if (st === Status.RUNNING) return Status.RUNNING;
    this.runningIndex = -1;
    if (this.suspendedIndex !== -1 && selected !== this.suspendedIndex) {
      // 抢占分支已结束：立即恢复被暂挂的分支，演出无缝继续
      const s = this.suspendedIndex;
      this.suspendedIndex = -1;
      this.runningIndex = s;
      const sc = this.children[s];
      sc.resume(ctx);
      const sst = sc.run(ctx);
      if (sst !== Status.RUNNING) { this.runningIndex = -1; return sst; }
      return Status.RUNNING;
    }
    // 主分支（最低优先级）完成 -> 整棵树的结果；打断分支完成 -> 演出继续
    return selected === this.mainIndex ? st : Status.RUNNING;
  }
  onAbort(ctx, reason) {
    if (this.runningIndex !== -1) this.children[this.runningIndex].abort(ctx, reason);
    if (this.suspendedIndex !== -1) {
      const c = this.children[this.suspendedIndex];
      if (c.suspended) c.resume(ctx);
      c.abort(ctx, reason);
      this.suspendedIndex = -1;
    }
  }
}

// —— 装饰：取反 ——
export class Inverter extends Node {
  constructor(name, child) {
    super(name);
    this.child = this.addChild(child);
  }
  enter() { resetTree(this.child); }
  tick(ctx) {
    const st = this.child.run(ctx);
    if (st === Status.SUCCESS) return Status.FAILURE;
    if (st === Status.FAILURE) return Status.SUCCESS;
    return Status.RUNNING;
  }
  onAbort(ctx, reason) { if (this.child.status === Status.RUNNING) this.child.abort(ctx, reason); }
}

// —— 装饰：黑板作用域。子树读写落在派生黑板（父链可查、局部可遮蔽） ——
export class Scope extends Node {
  constructor(name, child, scopeName) {
    super(name);
    this.child = this.addChild(child);
    this.scopeName = scopeName || name;
    this.scopeBB = null;
  }
  enter(ctx) {
    this.scopeBB = ctx.bb.createScope(this.scopeName);
    resetTree(this.child);
    ctx.log({ type: 'scope-enter', node: this.name, scope: this.scopeName });
  }
  tick(ctx) {
    return this.child.run({ ...ctx, bb: this.scopeBB });
  }
  onAbort(ctx, reason) { if (this.child.status === Status.RUNNING) this.child.abort(ctx, reason); }
  onSuspend(ctx) { if (this.child.status === Status.RUNNING) this.child.suspend(ctx); }
  onResume(ctx) { if (this.child.suspended) this.child.resume(ctx); }
}

// —— 装饰：失败重试，直到成功或耗尽次数 ——
export class RetryUntilSuccess extends Node {
  constructor(name, child, maxAttempts = 3) {
    super(name);
    this.child = this.addChild(child);
    this.maxAttempts = maxAttempts;
    this.attempts = 0;
  }
  enter() {
    this.attempts = 0;
    resetTree(this.child);
  }
  tick(ctx) {
    for (;;) {
      const st = this.child.run(ctx);
      if (st === Status.RUNNING) return Status.RUNNING;
      if (st === Status.SUCCESS) return Status.SUCCESS;
      this.attempts += 1;
      ctx.log({ type: 'retry', node: this.name, attempt: this.attempts, max: this.maxAttempts });
      if (this.attempts >= this.maxAttempts) return Status.FAILURE;
      resetTree(this.child);
    }
  }
  onAbort(ctx, reason) { if (this.child.status === Status.RUNNING) this.child.abort(ctx, reason); }
  onSuspend(ctx) { if (this.child.status === Status.RUNNING) this.child.suspend(ctx); }
  onResume(ctx) { if (this.child.suspended) this.child.resume(ctx); }
}
