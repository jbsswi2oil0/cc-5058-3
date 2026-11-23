// 运行器：固定步长驱动 输入 -> 世界推进 -> 行为树求值。
// UI 与无头测试共用，保证同一棵树、同一份输入序列产生完全相同的结果（可重放）。

import { Blackboard } from './bt/blackboard.js';
import { buildTree } from './bt/builder.js';
import { Status } from './bt/kernel.js';
import { World } from './world/world.js';
import { STAGE, initialBlackboardEntries } from './scenario.js';
import { performHotSwap, validateCandidate } from './bt/hotswap.js';

export const DT = 1 / 30;

export class Runner {
  constructor(treeDef, options = {}) {
    this.treeDef = treeDef;
    this.events = [];
    this.world = new World((e) => this._log(e));
    for (const a of STAGE.actors) this.world.addActor(a.id, a.x, a.z, a.color);
    for (const p of STAGE.props) this.world.addProp(p.id, p.holder);
    this.bbRoot = new Blackboard('root');
    for (const [k, v] of Object.entries(initialBlackboardEntries())) {
      this.bbRoot.set(k, v, 0);
    }
    this.tree = buildTree(treeDef);
    this.inputs = []; // { tick, label, apply(runner) }
    this.cursor = 0;
    this.done = false;
    this.hotSwapCount = 0;
    this.lastHotSwap = null;
    this.carriedLineSignatures = new Set();
    if (options.inputs) for (const i of options.inputs) this.scheduleInput(i.tick, i.label, i.apply);
  }

  _log(e) {
    this.events.push({ tick: this.world.tick, ...e });
  }

  // 供热换版等内部机制追加一条事件（与普通日志同一时间线）
  logEvent(e) {
    this._log(e);
  }

  // 构造一次求值上下文：热换版与正常 tick 共用同一份世界/黑板引用
  makeContext() {
    return {
      tick: this.world.tick,
      dt: DT,
      time: this.world.time,
      world: this.world,
      bb: this.bbRoot,
      bbRoot: this.bbRoot,
      log: (e) => this._log(e),
      carriedLines: this.carriedLineSignatures,
    };
  }

  // 所有外部输入（按钮、定时注入）都经此进入内核，按 tick 排序应用
  scheduleInput(tick, label, apply) {
    this.inputs.push({ tick, label, apply });
    this.inputs.sort((a, b) => a.tick - b.tick);
  }

  step() {
    if (this.done) return;
    // 1) 应用到期输入（同一 tick 按入队顺序）
    while (this.cursor < this.inputs.length && this.inputs[this.cursor].tick <= this.world.tick + 1) {
      const input = this.inputs[this.cursor++];
      input.apply(this);
      this._log({ type: 'input', label: input.label });
    }
    // 2) 世界推进（异步操作、回执）
    this.world.update(DT);
    // 3) 行为树求值
    if (this.tree.status !== Status.SUCCESS && this.tree.status !== Status.FAILURE) {
      const ctx = this.makeContext();
      this.tree.run(ctx);
    }
    if (this.tree.status === Status.SUCCESS || this.tree.status === Status.FAILURE) {
      this.done = true;
      this._log({ type: 'tree-done', status: this.tree.status });
    }
  }

  // —— 演出中的逻辑换版 ——
  // 候选校验无副作用；校验失败时保留当前可运行旧树并返回原因。
  validate(def) { return validateCandidate(def, this); }

  hotSwap(def) {
    const report = performHotSwap(this, def);
    if (report.ok) this.treeDef = def;
    return report;
  }

  run(maxTicks = 3000) {
    while (!this.done && this.world.tick < maxTicks) this.step();
    return this.tree.status;
  }

  // —— 常用输入动作（UI 按钮也走这些，保证可记录重放） ——

  setCalledAway(value, mode) {
    if (mode) this.bbRoot.set('interrupt.mode', mode, this.world.tick);
    this.bbRoot.set('calledAway', value, this.world.tick);
  }

  injectLateReceipts(token, count = 2) {
    for (let i = 0; i < count; i++) {
      this.world.injectReceipt(token, 'confirm', `manual-late-${i + 1}`, this.world.tick + i);
    }
  }

  setPathBlocked(v) {
    this.world.pathBlocked = v;
  }
}

// 探针：无界面地快速跑一遍，找出关键事件发生的 tick（用于 UI 预设抢占时刻）
export function probe(treeDef, maxTicks = 3000) {
  const r = new Runner(treeDef);
  let handoverEnter = null;
  let transfer = null;
  let done = null;
  const origLog = r._log.bind(r);
  r._log = (e) => {
    if (e.type === 'op-issue' && e.op === 'handover' && handoverEnter === null) handoverEnter = r.world.tick;
    if (e.type === 'receipt-accept' && transfer === null) transfer = r.world.tick;
    origLog(e);
  };
  r.run(maxTicks);
  done = r.world.tick;
  return { handoverEnter, transfer, done, status: r.tree.status };
}
