// 世界模拟：演员、道具、异步操作与回执。
//
// 关键原则：
// - 「发出移动命令」≠「已到达」：操作是异步的，按固定步长推进，
//   完成时通过回执/状态告知行为树。
// - 每个异步操作有唯一 token。回执按 token 路由：
//   已取消/已完成的 token 收到的迟到回执一律丢弃并记录（幂等）。
// - 道具占用（holder-of-record）只能由「生效中的递交操作」或
//   「取消恢复」改变，迟到回执无权改变占用。

export const OpStatus = Object.freeze({
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SUSPENDED: 'suspended',
});

const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class World {
  constructor(log) {
    this.log = log || (() => {});
    this.time = 0;
    this.tick = 0;
    this.actors = new Map();
    this.props = new Map();
    this.ops = new Map(); // token -> op（终态也保留，用于识别迟到回执）
    this.nextToken = 1;
    this.receipts = []; // 待处理回执 { atTick, token, kind, source }
    this.droppedReceipts = [];
    this.heldReceipts = [];
    this.dialogue = [];
    this.transferCount = 0;
    this.pathBlocked = false;
  }

  addActor(id, x, z, color) {
    this.actors.set(id, {
      id, pos: { x, z }, yaw: 0, speed: 2.4, turnSpeed: Math.PI * 2.2,
      anim: null, color: color || 0x8888ff,
    });
  }

  addProp(id, holderId) {
    this.props.set(id, {
      id, holder: holderId, state: 'held', // held | inTransit
      giver: null, receiver: null, pos: { x: 0, z: 0 },
    });
  }

  actor(id) {
    const a = this.actors.get(id);
    if (!a) throw new Error(`unknown actor: ${id}`);
    return a;
  }

  prop(id) {
    const p = this.props.get(id);
    if (!p) throw new Error(`unknown prop: ${id}`);
    return p;
  }

  propHolder(propId) { return this.prop(propId).holder; }

  say(actorId, text) {
    const line = { tick: this.tick, actor: actorId, text };
    this.dialogue.push(line);
    this.log({ type: 'line', actor: actorId, text });
  }

  // —— 操作签发 ——

  issueMove(actorId, target) {
    const token = this.nextToken++;
    this.ops.set(token, { token, type: 'move', actor: actorId, target: { ...target }, status: OpStatus.ACTIVE });
    this.log({ type: 'op-issue', token, op: 'move', actor: actorId, target });
    return token;
  }

  issueFace(actorId, targetActorId) {
    const token = this.nextToken++;
    this.ops.set(token, { token, type: 'face', actor: actorId, targetActor: targetActorId, status: OpStatus.ACTIVE });
    this.log({ type: 'op-issue', token, op: 'face', actor: actorId, targetActor: targetActorId });
    return token;
  }

  issueAnim(actorId, clip, duration) {
    const token = this.nextToken++;
    this.ops.set(token, { token, type: 'anim', actor: actorId, clip, duration, t: 0, status: OpStatus.ACTIVE });
    this.log({ type: 'op-issue', token, op: 'anim', actor: actorId, clip, duration });
    return token;
  }

  // 递交：passDuration 后进入待确认；接手人反应 confirmDelay 后自动确认，
  // 并且（模拟现场常见的重复回执）会多发一份重复确认。
  // 注意：确认回执在签发时就排入日程——即使操作之后被取消，
  // 这些回执仍会迟到到达，由回执路由按 token 丢弃（幂等）。
  issueHandover(giverId, receiverId, propId, passDuration, confirmDelay) {
    const token = this.nextToken++;
    const prop = this.prop(propId);
    prop.state = 'inTransit';
    prop.giver = giverId;
    prop.receiver = receiverId;
    this.ops.set(token, {
      token, type: 'handover', giver: giverId, receiver: receiverId, prop: propId,
      phase: 'passing', passT: 0, passDuration, confirmDelay, status: OpStatus.ACTIVE,
    });
    const dt = 1 / 30;
    const at = this.tick + Math.round(passDuration / dt) + Math.round(confirmDelay / dt);
    this.receipts.push({ atTick: at, token, kind: 'confirm', source: `${receiverId}-auto` });
    this.receipts.push({ atTick: at + 2, token, kind: 'confirm', source: `${receiverId}-auto-dup` });
    this.log({ type: 'op-issue', token, op: 'handover', giver: giverId, receiver: receiverId, prop: propId, confirmAtTick: at });
    return token;
  }

  op(token) { return this.ops.get(token); }

  // —— 取消 / 暂挂 / 恢复 ——

  cancelOp(token, reason = 'cancelled') {
    const op = this.ops.get(token);
    if (!op || op.status !== OpStatus.ACTIVE) return false;
    if (op.type === 'handover') this._restorePropToGiver(op, reason);
    if (op.type === 'anim') this.actor(op.actor).anim = null;
    op.status = OpStatus.CANCELLED;
    this.log({ type: 'op-cancel', token, op: op.type, reason });
    return true;
  }

  suspendOp(token) {
    const op = this.ops.get(token);
    if (!op || op.status !== OpStatus.ACTIVE) return false;
    op.status = OpStatus.SUSPENDED;
    // 暂挂期间占用仍归递交人：道具回到递交人手边，传递进度保留
    if (op.type === 'handover') {
      const prop = this.prop(op.prop);
      prop.state = 'held'; // 视觉与占用都回到 giver；op 内 passT 保留
      this.log({ type: 'op-suspend', token, op: op.type, occupancy: op.giver });
    } else {
      this.log({ type: 'op-suspend', token, op: op.type });
    }
    return true;
  }

  resumeOp(token) {
    const op = this.ops.get(token);
    if (!op || op.status !== OpStatus.SUSPENDED) return false;
    op.status = OpStatus.ACTIVE;
    if (op.type === 'handover') {
      const prop = this.prop(op.prop);
      prop.state = 'inTransit';
    }
    // 暂挂期间被扣下的回执重新排队
    for (const r of this.heldReceipts.filter((r) => r.token === token)) {
      this.receipts.push({ ...r, atTick: this.tick });
    }
    this.heldReceipts = this.heldReceipts.filter((r) => r.token !== token);
    this.log({ type: 'op-resume', token, op: op.type });
    return true;
  }

  _restorePropToGiver(op, reason) {
    const prop = this.prop(op.prop);
    if (prop.holder !== op.giver || prop.state !== 'held') {
      prop.holder = op.giver;
      prop.state = 'held';
      this.log({ type: 'prop-restored', prop: op.prop, holder: op.giver, reason });
    }
  }

  // —— 回执注入（UI / 测试都走这个正式通道） ——

  injectReceipt(token, kind = 'confirm', source = 'external', atTick = null) {
    this.receipts.push({ atTick: atTick === null ? this.tick : atTick, token, kind, source });
  }

  // —— 主推进 ——

  update(dt) {
    this.tick += 1;
    this.time += dt;

    // 1) 处理到期回执
    const due = this.receipts.filter((r) => r.atTick <= this.tick);
    this.receipts = this.receipts.filter((r) => r.atTick > this.tick);
    for (const r of due) this._processReceipt(r);

    // 2) 推进活跃操作
    for (const op of this.ops.values()) {
      if (op.status !== OpStatus.ACTIVE) continue;
      switch (op.type) {
        case 'move': this._updateMove(op, dt); break;
        case 'face': this._updateFace(op, dt); break;
        case 'anim': this._updateAnim(op, dt); break;
        case 'handover': this._updateHandover(op, dt); break;
      }
    }

    // 3) 道具跟随持有人
    for (const p of this.props.values()) {
      if (p.state === 'held') {
        const a = this.actor(p.holder);
        p.pos = { x: a.pos.x + Math.sin(a.yaw) * 0.45, z: a.pos.z + Math.cos(a.yaw) * 0.45 };
      }
    }
  }

  _processReceipt(r) {
    const op = this.ops.get(r.token);
    if (!op || op.status === OpStatus.CANCELLED || op.status === OpStatus.DONE || op.status === OpStatus.FAILED) {
      const drop = { tick: this.tick, token: r.token, kind: r.kind, source: r.source, reason: !op ? 'unknown-token' : `op-${op.status}` };
      this.droppedReceipts.push(drop);
      this.log({ type: 'receipt-drop', ...drop });
      return;
    }
    if (op.status === OpStatus.SUSPENDED) {
      this.heldReceipts.push(r);
      this.log({ type: 'receipt-held', tick: this.tick, token: r.token, kind: r.kind, source: r.source });
      return;
    }
    if (op.type === 'handover' && r.kind === 'confirm') {
      const prop = this.prop(op.prop);
      prop.holder = op.receiver;
      prop.state = 'held';
      prop.pos = { ...this.actor(op.receiver).pos };
      this.transferCount += 1;
      op.status = OpStatus.DONE;
      this.log({ type: 'receipt-accept', tick: this.tick, token: r.token, kind: r.kind, source: r.source, holder: op.receiver });
      return;
    }
    // 其它类型操作不认识该回执
    this.droppedReceipts.push({ tick: this.tick, token: r.token, kind: r.kind, source: r.source, reason: 'unhandled-kind' });
    this.log({ type: 'receipt-drop', tick: this.tick, token: r.token, kind: r.kind, source: r.source, reason: 'unhandled-kind' });
  }

  _updateMove(op, dt) {
    const a = this.actor(op.actor);
    if (this.pathBlocked) {
      op.status = OpStatus.FAILED;
      op.failReason = 'path-blocked';
      this.log({ type: 'op-fail', token: op.token, op: 'move', actor: op.actor, reason: 'path-blocked' });
      return;
    }
    const d = dist2d(a.pos, op.target);
    const step = a.speed * dt;
    if (d <= step) {
      a.pos = { ...op.target };
      op.status = OpStatus.DONE;
      this.log({ type: 'op-done', token: op.token, op: 'move', actor: op.actor, pos: { ...a.pos } });
      return;
    }
    const nx = (op.target.x - a.pos.x) / d;
    const nz = (op.target.z - a.pos.z) / d;
    a.pos.x += nx * step;
    a.pos.z += nz * step;
    a.yaw = Math.atan2(nx, nz);
  }

  _updateFace(op, dt) {
    const a = this.actor(op.actor);
    const t = this.actor(op.targetActor);
    const want = Math.atan2(t.pos.x - a.pos.x, t.pos.z - a.pos.z);
    let diff = want - a.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = a.turnSpeed * dt;
    if (Math.abs(diff) <= step) {
      a.yaw = want;
      op.status = OpStatus.DONE;
      this.log({ type: 'op-done', token: op.token, op: 'face', actor: op.actor });
      return;
    }
    a.yaw += Math.sign(diff) * step;
  }

  _updateAnim(op, dt) {
    const a = this.actor(op.actor);
    a.anim = op.clip;
    op.t += dt;
    if (op.t >= op.duration) {
      op.status = OpStatus.DONE;
      a.anim = null;
      this.log({ type: 'op-done', token: op.token, op: 'anim', actor: op.actor, clip: op.clip });
    }
  }

  _updateHandover(op, dt) {
    const prop = this.prop(op.prop);
    if (op.phase === 'passing') {
      op.passT += dt;
      const g = this.actor(op.giver).pos;
      const r = this.actor(op.receiver).pos;
      const k = Math.min(1, op.passT / op.passDuration);
      prop.pos = { x: g.x + (r.x - g.x) * k, z: g.z + (r.z - g.z) * k };
      if (k >= 1) op.phase = 'awaitingConfirm';
    }
    // awaitingConfirm：等待回执，世界不擅自改变占用
  }
}
