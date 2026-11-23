// 行为树叶子节点：动作与条件，绑定真实世界异步操作。
//
// 动作节点遵循「一次进入、一次签发」：enter 里签发唯一 token，
// running 期间的每个 tick 只查询该 token 的状态，绝不重复签发。
// 被高优先级分支抢占时，onAbort 取消真实世界的导航/动画/递交意图。

import { Node, Status } from '../bt/kernel.js';
import { OpStatus } from './world.js';
import { MissingKeyError } from '../bt/blackboard.js';
import { lineSignature } from '../bt/identity.js';

// —— 异步操作动作基类 ——
// 子类实现 issue(ctx)：返回 token；若无需/无法签发，返回 null 并设置 immediateResult。
export class AsyncOpAction extends Node {
  constructor(name, params) {
    super(name);
    this.params = params;
    this.token = null;
    this.immediateResult = null;
  }
  enter(ctx) {
    this.immediateResult = null;
    this.token = this.issue(ctx);
    if (this.token !== null) {
      ctx.log({ type: 'action-issue', node: this.name, token: this.token });
    } else if (this.immediateResult === null) {
      // 防御：子类既没签发也没给立即结果，按失败处理（不静默放行）
      this.immediateResult = Status.FAILURE;
      ctx.log({ type: 'action-failed', node: this.name, reason: 'no-op-issued' });
    }
  }
  issue(_ctx) { throw new Error('not implemented'); }
  tick(ctx) {
    if (this.token === null) return this.immediateResult;
    const op = ctx.world.op(this.token);
    if (!op) return Status.FAILURE;
    switch (op.status) {
      case OpStatus.ACTIVE:
      case OpStatus.SUSPENDED:
        return Status.RUNNING;
      case OpStatus.DONE:
        return this.onDone(ctx, op);
      case OpStatus.FAILED:
        ctx.log({ type: 'action-failed', node: this.name, token: this.token, reason: op.failReason || 'unknown' });
        return Status.FAILURE;
      default:
        return Status.FAILURE;
    }
  }
  onDone(_ctx, _op) { return Status.SUCCESS; }
  onAbort(ctx, reason) {
    if (this.token !== null) ctx.world.cancelOp(this.token, reason);
  }
  onSuspend(ctx) {
    if (this.token !== null) ctx.world.suspendOp(this.token);
  }
  onResume(ctx) {
    if (this.token !== null) ctx.world.resumeOp(this.token);
  }
}

export class MoveTo extends AsyncOpAction {
  issue(ctx) {
    const p = this.params;
    this.resolved = resolveTarget(ctx, p.target);
    return ctx.world.issueMove(p.actor, this.resolved);
  }
}

export class FaceTarget extends AsyncOpAction {
  issue(ctx) {
    return ctx.world.issueFace(this.params.actor, this.params.target.actor);
  }
}

export class PlayAnim extends AsyncOpAction {
  issue(ctx) {
    const p = this.params;
    const actorId = resolveActor(ctx, p.actor);
    if (actorId === null) {
      this.immediateResult = Status.FAILURE;
      ctx.log({ type: 'action-failed', node: this.name, reason: `cannot resolve actor '${p.actor}'` });
      return null;
    }
    return ctx.world.issueAnim(actorId, p.clip, p.duration);
  }
}

// —— 递交道具：幂等。进入时先查真实占用：
//    已在接手人手中 -> 直接成功（不重演、不二次转交）
//    不在递交人手中 -> 失败（不能递交不属于自己的道具）
export class HandOver extends AsyncOpAction {
  issue(ctx) {
    const p = this.params;
    const holder = ctx.world.propHolder(p.prop);
    if (holder === p.receiver) {
      this.immediateResult = Status.SUCCESS;
      ctx.log({ type: 'handover-idempotent', node: this.name, prop: p.prop, holder });
      ctx.bbRoot.set('propHolder', p.receiver, ctx.tick);
      return null;
    }
    if (holder !== p.giver) {
      this.immediateResult = Status.FAILURE;
      ctx.log({ type: 'action-failed', node: this.name, reason: `giver ${p.giver} does not hold ${p.prop} (holder=${holder})` });
      return null;
    }
    return ctx.world.issueHandover(p.giver, p.receiver, p.prop, p.passDuration, p.confirmDelay);
  }
  onDone(ctx, op) {
    // 真实确认发生：镜像占用到黑板（版本推进），接手人说出接词
    ctx.bbRoot.set('propHolder', op.receiver, ctx.tick);
    ctx.world.say(op.receiver, this.params.confirmLine || '谢谢，道具我收到了！');
    return Status.SUCCESS;
  }
  onAbort(ctx, reason) {
    super.onAbort(ctx, reason);
    // 取消后占用恢复为递交人，镜像同步
    ctx.bbRoot.set('propHolder', this.params.giver, ctx.tick);
  }
}

// —— 即时叶子基类：携带参数 ——
export class LeafNode extends Node {
  constructor(name, params = {}) {
    super(name);
    this.params = params;
  }
}

// —— 台词：立即动作。actor 可为 "bb:key" 从黑板严格解析 ——
// 热换版去重：兼容动作恢复后不得重播已发台词。ctx.carriedLines 只在换版时
// 由旧树已完成台词填充；普通抢占/重演时为空，仍按演出语义重说。
export class SpeakLine extends LeafNode {
  tick(ctx) {
    const sig = lineSignature(this);
    if (sig && ctx.carriedLines && ctx.carriedLines.has(sig)) {
      // 只抑制换版造成的那一次重进；之后有明确原因（如重试）的再入仍可重说
      ctx.carriedLines.delete(sig);
      ctx.log({ type: 'line-suppressed', node: this.name, key: this.key, text: this.params.text });
      return Status.SUCCESS;
    }
    const actorId = resolveActor(ctx, this.params.actor);
    if (actorId === null) {
      ctx.log({ type: 'action-failed', node: this.name, reason: `cannot resolve actor '${this.params.actor}'` });
      return Status.FAILURE;
    }
    ctx.world.say(actorId, this.params.text);
    return Status.SUCCESS;
  }
}

// —— 写黑板 ——
export class SetBlackboard extends LeafNode {
  tick(ctx) {
    const p = this.params;
    const bbKey = p.bbKey ?? p.key;
    const bb = p.scope === 'local' ? ctx.bb : ctx.bbRoot;
    bb.set(bbKey, p.value, ctx.tick);
    ctx.log({ type: 'bb-set', node: this.name, key: bbKey, value: p.value, scope: p.scope || 'root' });
    return Status.SUCCESS;
  }
}

// —— 等待：按世界时钟倒计时；暂挂时不推进（suspended 节点不被 tick） ——
export class Wait extends LeafNode {
  enter() { this.remaining = this.params.duration; }
  tick(ctx) {
    this.remaining -= ctx.dt;
    return this.remaining <= 0 ? Status.SUCCESS : Status.RUNNING;
  }
}

// —— 恒失败（用于兜底分支尾部触发重试） ——
export class Fail extends LeafNode {
  tick() { return Status.FAILURE; }
}

// ============ 条件节点（即时，不返回 RUNNING） ============

// 黑板等值：缺失键 -> FAILURE（reason: missing-key），绝不默认真值放行
export class BlackboardEquals extends LeafNode {
  tick(ctx) {
    const p = this.params;
    const bbKey = p.bbKey ?? p.key;
    let value;
    try {
      value = ctx.bb.require(bbKey);
    } catch (e) {
      if (e instanceof MissingKeyError) {
        ctx.log({ type: 'cond-missing-key', node: this.name, key: bbKey });
        return Status.FAILURE;
      }
      throw e;
    }
    const ok = value === p.value;
    return ok ? Status.SUCCESS : Status.FAILURE;
  }
}

// 道具归属（直接查世界真实状态，不经过黑板缓存）
export class PropHeldBy extends LeafNode {
  tick(ctx) {
    const ok = ctx.world.propHolder(this.params.prop) === this.params.actor;
    return ok ? Status.SUCCESS : Status.FAILURE;
  }
}

export class Always extends LeafNode {
  tick() { return Status.SUCCESS; }
}

// —— 工具 ——

function resolveTarget(ctx, target) {
  if (target.actor) {
    const a = ctx.world.actor(target.actor);
    const off = target.offset || { x: 0, z: 0 };
    return { x: a.pos.x + off.x, z: a.pos.z + off.z };
  }
  return { x: target.x, z: target.z };
}

// 返回 null 表示解析失败（如黑板缺键），调用方据此判 FAILURE
function resolveActor(ctx, spec) {
  if (typeof spec === 'string' && spec.startsWith('bb:')) {
    try {
      return ctx.bb.require(spec.slice(3));
    } catch (e) {
      if (e instanceof MissingKeyError) return null;
      throw e;
    }
  }
  return spec;
}
