// 演出中的逻辑换版（行为树热换版）。
//
// 流程：
//   1. validateCandidate：只构建候选树并做静态检查（节点引用、key 唯一、黑板契约），
//      绝不 enter/签发操作，因此不会提前触发场景副作用。
//   2. plan + apply：按稳定 key + 语义契约（contractOf）匹配新旧节点；
//      只有「同 key 且契约相同」的 running 节点才迁移运行状态。
//      同 key 但契约改变 -> 旧动作明确取消/退出，新节点重新 enter；
//      key 在新版消失 -> 旧动作取消并释放资源（道具归还）。
//   3. 迁移以「最近兼容表演标记」为基准：最深一层仍可迁移的公共祖先保留，
//      其下发生变化的子树重新进入；已完成且兼容的兄弟动作保留终态，不重播。

import { buildTree } from './builder.js';
import { Status, adoptState } from './kernel.js';
import { contractOf, collectNodes, lineSignature } from './identity.js';
import { migrationSpec } from './migration-table.js';
import {
  Sequence, Selector, Parallel, GuardedBranch, ReactiveSelector,
  Inverter, Scope, RetryUntilSuccess,
} from './nodes.js';
import { AsyncOpAction, Wait, SpeakLine, SetBlackboard, BlackboardEquals } from '../world/actions.js';
import { BLACKBOARD_CONTRACT } from '../scenario.js';

const isLeafAction = (n) => n instanceof AsyncOpAction || n instanceof Wait;

// —————————— 候选校验（无副作用） ——————————

function checkActorRef(value, node, runner, errors) {
  if (typeof value !== 'string') return;
  if (value.startsWith('bb:')) {
    const key = value.slice(3);
    if (!(key in BLACKBOARD_CONTRACT)) {
      errors.push({ code: 'bb-ref-unknown', node: node.name, key, message: `引用了黑板契约外的键 ${key}` });
    }
    return;
  }
  if (!runner.world.actors.has(value)) {
    errors.push({ code: 'actor-ref', node: node.name, actor: value, message: `引用了不存在的演员 ${value}` });
  }
}

function checkBlackboardTypes(runner, errors) {
  for (const [key, type] of Object.entries(BLACKBOARD_CONTRACT)) {
    if (!runner.bbRoot.has(key)) {
      errors.push({ code: 'bb-missing', key, message: `黑板缺少契约键 ${key}` });
      continue;
    }
    const value = runner.bbRoot.get(key);
    if (typeof value !== type) {
      errors.push({
        code: 'bb-type',
        key,
        expected: type,
        actual: typeof value,
        message: `黑板键 ${key} 类型改变：契约 ${type}，实际 ${typeof value}`,
      });
    }
  }
}

export function validateCandidate(def, runner) {
  const errors = [];
  const warnings = [];
  let tree = null;
  try {
    tree = buildTree(def);
  } catch (e) {
    errors.push({ code: 'build', message: e.message });
    return { ok: false, errors, warnings, tree: null };
  }

  const all = collectNodes(tree);
  const keyOwner = new Map();
  for (const n of all) {
    if (!n.key) {
      warnings.push({ code: 'no-key', node: n.name, message: `${n.name} 无稳定 key，热换版不会迁移其运行状态` });
      continue;
    }
    if (keyOwner.has(n.key)) {
      errors.push({ code: 'duplicate-key', key: n.key, message: `key「${n.key}」重复：${keyOwner.get(n.key).name} / ${n.name}` });
    } else {
      keyOwner.set(n.key, n);
    }
  }

  for (const n of all) {
    const p = n.params || {};
    checkActorRef(p.actor, n, runner, errors);
    checkActorRef(p.giver, n, runner, errors);
    checkActorRef(p.receiver, n, runner, errors);
    if (p.target && p.target.actor !== undefined) checkActorRef(p.target.actor, n, runner, errors);
    if (p.prop !== undefined && !runner.world.props.has(p.prop)) {
      errors.push({ code: 'prop-ref', node: n.name, prop: p.prop, message: `引用了不存在的道具 ${p.prop}` });
    }
    if (n instanceof BlackboardEquals) {
      const k = p.bbKey ?? p.key;
      if (!(k in BLACKBOARD_CONTRACT)) {
        errors.push({ code: 'bb-ref-unknown', node: n.name, key: k, message: `条件引用黑板契约外的键 ${k}` });
      }
    }
    if (n instanceof SetBlackboard && p.scope !== 'local') {
      const k = p.bbKey ?? p.key;
      const declared = BLACKBOARD_CONTRACT[k];
      if (declared === undefined) {
        warnings.push({ code: 'bb-new-key', node: n.name, key: k, message: `向黑板写入契约外的新键 ${k}` });
      } else if (typeof p.value !== declared) {
        errors.push({
          code: 'bb-write-type',
          node: n.name,
          key: k,
          expected: declared,
          actual: typeof p.value,
          message: `写黑板 ${k} 的类型与契约不符：期望 ${declared}，写入 ${typeof p.value}`,
        });
      }
    }
  }

  checkBlackboardTypes(runner, errors);
  return { ok: errors.length === 0, errors, warnings, tree };
}

// —————————— 迁移规划 ——————————

// 逐 key 对比新旧两版，产出迁移计划：谁迁移、谁重进、谁退出。
// 计划只依赖稳定 key + 语义契约，完全不看节点序号。
export function buildMigrationPlan(oldTree, newTree) {
  const oldByKey = new Map();
  for (const n of collectNodes(oldTree)) if (n.key && !oldByKey.has(n.key)) oldByKey.set(n.key, n);
  const newByKey = new Map();
  for (const n of collectNodes(newTree)) if (n.key && !newByKey.has(n.key)) newByKey.set(n.key, n);

  const plan = [];
  for (const [key, next] of newByKey) {
    const prev = oldByKey.get(key);
    const spec = migrationSpec(next);
    if (!prev) {
      plan.push({ key, name: next.name, type: next.constructor.name, decision: 'new', detail: '新节点，首次进入' });
      continue;
    }
    if (contractOf(prev) !== contractOf(next)) {
      plan.push({ key, name: next.name, type: next.constructor.name, decision: 'reset-reenter', detail: '同 key 但动作含义改变，旧状态退出后重新进入' });
      continue;
    }
    const terminal = prev.status === Status.SUCCESS || prev.status === Status.FAILURE;
    if (terminal) {
      plan.push({ key, name: next.name, type: next.constructor.name, decision: 'preserve-terminal', detail: `兼容且已完成（${prev.status}），不重播` });
      continue;
    }
    if (prev.status !== Status.RUNNING) {
      plan.push({ key, name: next.name, type: next.constructor.name, decision: 'idle', detail: '旧版未启动，新版按原位置进入' });
      continue;
    }
    const decision = spec ? spec.decision : 'reset-reenter';
    plan.push({ key, name: next.name, type: next.constructor.name, decision, detail: spec ? '按迁移表交接运行进度' : '类型未知，保守退出后重进' });
  }
  for (const [key, prev] of oldByKey) {
    if (newByKey.has(key)) continue;
    plan.push({ key, name: prev.name, type: prev.constructor.name, decision: 'removed', detail: `节点已删除（原状态 ${prev.status}）` });
  }
  return plan;
}

function childByKey(children, key) {
  if (!key) return null;
  let hit = null;
  for (const c of children || []) {
    if (c.key === key) {
      if (hit) return null; // duplicate handled at validation; 重复时不猜
      hit = c;
    }
  }
  return hit;
}

function sameIdentity(oldN, newN) {
  return !!oldN.key && oldN.key === newN.key && contractOf(oldN) === contractOf(newN);
}

function carryTerminal(oldN, newN, report) {
  newN.status = oldN.status;
  newN.enterCount = oldN.enterCount;
  newN.exitCount = oldN.exitCount;
  newN.lastExitStatus = oldN.lastExitStatus;
  newN.migrated = true;
  report.preserved.push({ key: oldN.key, name: newN.name, status: oldN.status });
}

// 返回是否成功接管（running）；失败时调用方负责取消旧子树。
// depth 用于定位「最近兼容表演标记」：迁移得最深、且其下有节点未能接管的组合节点，
// 就是重放起点——它以上保留运行/终态，它以下重新进入。
function adoptRunning(oldN, newN, ctx, report, adopted, depth = 0) {
  const spec = migrationSpec(oldN);
  if (spec && spec.decision === 'continue-op') {
    // 明确继续政策：契约相同 -> 沿用同一 token，不签发第二份控制意图。
    newN.token = oldN.token;
    newN.immediateResult = oldN.immediateResult;
    newN.resolved = oldN.resolved;
    adoptState(newN, Status.RUNNING, spec.progress ? spec.progress(oldN) : null, oldN.suspended);
    report.continued.push({ key: oldN.key, name: newN.name, token: oldN.token, action: 'continue', depth });
    adopted.add(oldN);
    return true;
  }
  if (spec && spec.decision === 'resume-progress' && spec.resumable) {
    const progress = spec.progress(oldN);
    spec.apply(newN, progress);
    adoptState(newN, Status.RUNNING, progress, oldN.suspended);
    report.migrated.push({ key: oldN.key, name: newN.name, kind: newN.constructor.name, depth, ...progress });
    adopted.add(oldN);
    return true;
  }
  if (oldN instanceof Sequence || oldN instanceof Selector) {
    return adoptIndexedComposite(oldN, newN, ctx, report, adopted, depth);
  }
  if (oldN instanceof Parallel) {
    let boundary = false;
    for (const oc of oldN.children) {
      const nc = childByKey(newN.children, oc.key);
      if (!nc) { boundary = true; continue; }
      if (oc.status === Status.RUNNING && sameIdentity(oc, nc)) {
        if (!adoptRunning(oc, nc, ctx, report, adopted, depth + 1)) boundary = true;
      } else if (oc.status === Status.SUCCESS || oc.status === Status.FAILURE) {
        if (contractOf(oc) === contractOf(nc)) carryTerminal(oc, nc, report);
      } else {
        boundary = true;
      }
    }
    adoptState(newN, Status.RUNNING, null, oldN.suspended);
    adopted.add(oldN);
    if (boundary) noteMarker(report, oldN.key, newN.name, depth);
    return true;
  }
  if (oldN instanceof GuardedBranch) {
    const nc = childByKey([newN.body], oldN.body.key);
    let ok = false;
    if (nc && sameIdentity(oldN.body, nc)) ok = adoptRunning(oldN.body, nc, ctx, report, adopted, depth + 1);
    adoptState(newN, Status.RUNNING, null, oldN.suspended);
    adopted.add(oldN);
    if (!ok) noteMarker(report, oldN.key, newN.name, depth);
    return true;
  }
  if (oldN instanceof Scope) {
    const nc = childByKey([newN.child], oldN.child.key);
    newN.scopeBB = ctx.bb.createScope(newN.scopeName);
    let ok = false;
    if (nc && sameIdentity(oldN.child, nc)) ok = adoptRunning(oldN.child, nc, ctx, report, adopted, depth + 1);
    adoptState(newN, Status.RUNNING, null, oldN.suspended);
    adopted.add(oldN);
    if (!ok) noteMarker(report, oldN.key, newN.name, depth);
    return true;
  }
  if (oldN instanceof RetryUntilSuccess) {
    const nc = childByKey([newN.child], oldN.child.key);
    newN.attempts = oldN.attempts;
    let ok = false;
    if (nc && sameIdentity(oldN.child, nc)) ok = adoptRunning(oldN.child, nc, ctx, report, adopted, depth + 1);
    adoptState(newN, Status.RUNNING, null, oldN.suspended);
    adopted.add(oldN);
    if (!ok) noteMarker(report, oldN.key, newN.name, depth);
    return true;
  }
  if (oldN instanceof Inverter) {
    const nc = childByKey([newN.child], oldN.child.key);
    let ok = false;
    if (nc && sameIdentity(oldN.child, nc)) ok = adoptRunning(oldN.child, nc, ctx, report, adopted, depth + 1);
    adoptState(newN, Status.RUNNING, null, oldN.suspended);
    adopted.add(oldN);
    if (!ok) noteMarker(report, oldN.key, newN.name, depth);
    return true;
  }
  if (oldN instanceof ReactiveSelector) {
    return adoptReactive(oldN, newN, ctx, report, adopted, depth);
  }
  // 未知节点类型：保守地不迁移
  return false;
}

function noteMarker(report, key, name, depth) {
  if (!report.replayBase || depth >= report.replayBase.depth) {
    report.replayBase = { key, name, depth };
  }
}

function adoptIndexedComposite(oldN, newN, ctx, report, adopted, depth) {
  const oldIdx = oldN.index;
  const oc = oldN.children[oldIdx];
  if (!oc) return false;

  // 先保留位于当前进度之前、契约未变的已完成兄弟（不重播、不重跑）
  for (let i = 0; i < oldIdx; i++) {
    const prev = oldN.children[i];
    const nc = childByKey(newN.children, prev.key);
    if (!nc) continue;
    if (contractOf(prev) === contractOf(nc) && prev.status !== Status.RUNNING) {
      carryTerminal(prev, nc, report);
    }
  }

  let newIdx;
  let boundary = false;
  const nextNew = childByKey(newN.children, oc.key);
  if (nextNew) {
    newIdx = newN.children.indexOf(nextNew);
    if (sameIdentity(oc, nextNew)) {
      if (!adoptRunning(oc, nextNew, ctx, report, adopted, depth + 1)) boundary = true;
    } else {
      boundary = true; // 同 key 契约改变：旧动作退出，新节点下一次 tick 重新 enter
    }
  } else {
    // 正在运行的分支在新版被删除：跳过它，父节点从同一位置继续
    newIdx = Math.min(oldIdx, newN.children.length);
    boundary = true;
  }

  // 插入在当前进度之前的全新节点：演出已越过该点，本场不追补（显式记录，不静默）
  const oldChildKeys = new Set(oldN.children.map((c) => c.key).filter(Boolean));
  for (let i = 0; i < newIdx; i++) {
    const c = newN.children[i];
    if (c.key && !oldChildKeys.has(c.key)) {
      report.skipped.push({ key: c.key, name: c.name, reason: '插入点在当前进度之前，本场不追补' });
    }
  }

  newN.index = newIdx;
  adoptState(newN, Status.RUNNING, { index: newIdx }, oldN.suspended);
  adopted.add(oldN);
  if (boundary) noteMarker(report, oldN.key, newN.name, depth);
  return true;
}

function adoptReactive(oldN, newN, ctx, report, adopted, depth) {
  let newRunning = -1;
  let newSuspended = -1;
  let boundary = false;
  const oc = oldN.runningIndex >= 0 ? oldN.children[oldN.runningIndex] : null;
  if (oc) {
    const nc = childByKey(newN.children, oc.key);
    if (nc) {
      newRunning = newN.children.indexOf(nc);
      if (sameIdentity(oc, nc)) {
        if (!adoptRunning(oc, nc, ctx, report, adopted, depth + 1)) boundary = true;
      } else {
        boundary = true;
      }
    } else {
      boundary = true;
    }
  }
  const sc = oldN.suspendedIndex >= 0 ? oldN.children[oldN.suspendedIndex] : null;
  if (sc) {
    const nc = childByKey(newN.children, sc.key);
    if (nc && sameIdentity(sc, nc)) {
      newSuspended = newN.children.indexOf(nc);
      adoptRunning(sc, nc, ctx, report, adopted, depth + 1);
      newN.children[newSuspended].suspended = true;
    } else {
      boundary = true;
    }
  }
  newN.runningIndex = newRunning;
  newN.suspendedIndex = newSuspended;
  adoptState(newN, Status.RUNNING, { runningIndex: newRunning }, oldN.suspended);
  adopted.add(oldN);
  if (boundary) noteMarker(report, oldN.key, newN.name, depth);
  return true;
}

function collectOldRunningLeaves(root) {
  return collectNodes(root).filter((n) => isLeafAction(n) && n.status === Status.RUNNING);
}

// 旧树中已经成功执行过的台词：换版后再次进入同 key + 同契约的台词时抑制重播。
// 与运行器已有记录合并，保证连续多次换版也不重播本场已发台词。
function collectSpokenSignatures(root, previous = new Set()) {
  const out = new Set(previous);
  for (const n of collectNodes(root)) {
    if (n instanceof SpeakLine && n.status === Status.SUCCESS) {
      const sig = lineSignature(n);
      if (sig) out.add(sig);
    }
  }
  return out;
}

// —————————— 应用换版 ——————————

export function performHotSwap(runner, def) {
  const validation = validateCandidate(def, runner);
  const report = {
    tick: runner.world.tick,
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    migrated: [],
    continued: [],
    preserved: [],
    reset: [],
    exited: [],
    skipped: [],
    cancelledOps: [],
    replayBase: null,
    plan: [],
  };
  if (!validation.ok) {
    report.reason = `候选树校验失败：${validation.errors[0]?.message || '未知错误'}`;
    runner.logEvent({ type: 'hotswap-reject', reason: report.reason, errors: validation.errors });
    return report;
  }

  const oldTree = runner.tree;
  const newTree = validation.tree;
  const ctx = runner.makeContext();
  report.plan = buildMigrationPlan(oldTree, newTree);

  // 根节点语义也必须是同一身份，否则整棵树重置（不迁移任何进度）
  let rootSame = true;
  if (newTree.key && oldTree.key) rootSame = sameIdentity(oldTree, newTree);
  else if (oldTree.key && !newTree.key) rootSame = false;
  else if (!oldTree.key && newTree.key) rootSame = false;
  else rootSame = contractOf(oldTree) === contractOf(newTree);

  const adopted = new Set();
  if (rootSame) {
    const rootWasRunning = oldTree.status === Status.RUNNING;
    if (rootWasRunning) {
      adoptRunning(oldTree, newTree, ctx, report, adopted);
    } else if (oldTree.status === Status.SUCCESS || oldTree.status === Status.FAILURE) {
      // 旧树已终结：新树从 idle 开始，不继承终态（否则整场立刻结束）
    }
  }

  // 运行中、但因语义改变/删除而无法接管的节点：重置记录必须早于 abort（abort 会清状态）
  const planByKey = new Map(report.plan.map((p) => [p.key, p]));
  const oldByKey = new Map();
  for (const n of collectNodes(oldTree)) if (n.key && !oldByKey.has(n.key)) oldByKey.set(n.key, n);
  for (const [key, prev] of oldByKey) {
    const decide = planByKey.get(key);
    if (!decide || adopted.has(prev)) continue;
    const wasLive = prev.status === Status.RUNNING || prev.suspended;
    if (decide.decision === 'reset-reenter' && wasLive) {
      report.reset.push({ key, name: decide.name, reason: '语义契约改变，旧运行状态不可迁移' });
    }
    if (decide.decision === 'removed' && wasLive) {
      report.reset.push({ key, name: prev.name, reason: '节点在新版删除，运行状态被重置' });
    }
  }

  // 任何未被接管的运行中动作：明确取消，释放道具 / 停止导航动画
  for (const leaf of collectOldRunningLeaves(oldTree)) {
    if (adopted.has(leaf)) continue;
    const before = leaf.token !== null && leaf.token !== undefined ? leaf.token : null;
    leaf.abort(ctx, 'hotswap-exit');
    const entry = {
      key: leaf.key,
      name: leaf.name,
      action: 'exit',
      token: before,
      reason: 'hotswap-exit',
    };
    report.exited.push(entry);
    if (before !== null) report.cancelledOps.push(before);
  }

  // 运行器交接：世界、黑板、事件流、输入队列全部保留
  runner.tree = newTree;
  runner.done = false;
  runner.carriedLineSignatures = collectSpokenSignatures(oldTree, runner.carriedLineSignatures);
  runner.hotSwapCount += 1;
  runner.lastHotSwap = report;

  runner.logEvent({
    type: 'hotswap-ok',
    from: oldTree.name,
    to: newTree.name,
    migrated: report.migrated.length + report.continued.length,
    preserved: report.preserved.length,
    reset: report.reset.length,
    exited: report.exited.length,
    replayBase: report.replayBase ? report.replayBase.name : null,
  });
  for (const m of report.migrated) runner.logEvent({ type: 'hotswap-adopt', key: m.key, node: m.name, kind: m.kind });
  for (const c of report.continued) runner.logEvent({ type: 'hotswap-continue', key: c.key, node: c.name, token: c.token });
  for (const p of report.preserved) runner.logEvent({ type: 'hotswap-preserve', key: p.key, node: p.name, status: p.status });
  for (const r of report.reset) runner.logEvent({ type: 'hotswap-reset', key: r.key, node: r.name, reason: r.reason });
  for (const s of report.skipped) runner.logEvent({ type: 'hotswap-skip', key: s.key, node: s.name, reason: s.reason });
  for (const e of report.exited) runner.logEvent({ type: 'hotswap-exit', key: e.key, node: e.name, token: e.token });

  return report;
}
