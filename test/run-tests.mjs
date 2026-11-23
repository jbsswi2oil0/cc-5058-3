// 无头语义测试：node test/run-tests.mjs
// 逐步核对节点状态与角色真实位置，验证：
//  1. 基线演出            6. 手动注入两份迟到回执
//  2. 生命周期/不重复启动  7. 黑板缺失键不静默放行
//  3. 确认前叫离(取消)     8. 动作失败反馈回行为树
//  4. 确认后叫离           9. 黑板作用域与版本
//  5. 暂挂/恢复           10. 等待节点不提前完成

import { Runner, DT } from '../src/runner.js';
import { DEFAULT_TREE } from '../src/scenario.js';
import { Status } from '../src/bt/kernel.js';
import { Blackboard, MissingKeyError } from '../src/bt/blackboard.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name} ${detail}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
const posNear = (p, x, z, eps = 0.05) => near(p.x, x, eps) && near(p.z, z, eps);

function findNode(node, name) {
  if (node.name === name) return node;
  const kids = [];
  if (node.children) kids.push(...node.children);
  if (node.child) kids.push(node.child);
  if (node.body) kids.push(node.body);
  if (node.guard) kids.push(node.guard);
  for (const k of kids) {
    const hit = findNode(k, name);
    if (hit) return hit;
  }
  return null;
}

const ev = (r, type) => r.events.filter((e) => e.type === type);
const lines = (r, text) => r.world.dialogue.filter((d) => d.text === text);
const runUntil = (r, pred, max = 4000) => { let n = 0; while (!pred(r) && n++ < max && !r.done) r.step(); };

// 探针：找出无打断时递交开始/成交的 tick，供各用例对齐抢占时刻
function probeTicks() {
  const r = new Runner(DEFAULT_TREE);
  r.run(4000);
  const issue = ev(r, 'op-issue').find((e) => e.op === 'handover');
  const accept = ev(r, 'receipt-accept')[0];
  return { handoverStart: issue.tick, transfer: accept.tick };
}
const PROBE = probeTicks();

// ————————————————————————————————
section('1. 基线演出（无打断）');
{
  const r = new Runner(DEFAULT_TREE);
  const status = r.run(4000);
  check('树最终成功', status === Status.SUCCESS, `got ${status}`);
  check('道具恰好转交一次', r.world.transferCount === 1, `got ${r.world.transferCount}`);
  check('最终持有人是 B', r.world.propHolder('prop1') === 'B');
  check('A 的「请收下」说了一次', lines(r, '请收下这个道具。').length === 1);
  check('B 的确认接词说了一次', lines(r, '谢谢，道具我收到了！').length === 1);
  const holderLine = r.world.dialogue.filter((d) => d.text === '道具在我这里，演出继续。');
  check('持有人接词由 B 说出', holderLine.length === 1 && holderLine[0].actor === 'B');
  check('B 的重复回执被丢弃(幂等)', r.world.droppedReceipts.length === 1 && r.world.droppedReceipts[0].reason === 'op-done');
  const a = r.world.actor('A');
  check('A 真实位置在 B 身旁', posNear(a.pos, 3, 0.4, 0.01), `got ${JSON.stringify(a.pos)}`);
  check('道具位置跟随 B', posNear(r.world.prop('prop1').pos, r.world.actor('B').pos.x, r.world.actor('B').pos.z, 0.6));
}

// ————————————————————————————————
section('2. 生命周期：持续多步的动作不重复启动');
{
  const r = new Runner(DEFAULT_TREE);
  const move = findNode(r.tree, '走向B');
  let maxEnterWhileRunning = 0;
  let runningStreak = 0;
  for (let i = 0; i < 4000 && !r.done; i++) {
    r.step();
    if (move.status === Status.RUNNING) {
      runningStreak += 1;
      maxEnterWhileRunning = Math.max(maxEnterWhileRunning, move.enterCount);
    }
  }
  check('移动持续多个更新步', runningStreak > 30, `streak=${runningStreak}`);
  check('running 期间 enter 只发生一次', maxEnterWhileRunning === 1, `enter=${maxEnterWhileRunning}`);
  const moveIssues = ev(r, 'op-issue').filter((e) => e.op === 'move' && e.actor === 'A');
  check('导航意图只签发一次', moveIssues.length === 1, `got ${moveIssues.length}`);
  check('节点成功退出一次', move.exitCount === 1 && move.lastExitStatus === 'success');
}

// ————————————————————————————————
section('3. 确认前叫离（取消语义）：收回道具重演，两份迟到回执不再转交');
{
  const r = new Runner(DEFAULT_TREE);
  const interruptAt = PROBE.handoverStart + 10; // 递交传递途中
  r.scheduleInput(interruptAt, '叫离A(cancel)', (rr) => rr.setCalledAway(true, 'cancel'));
  // 跑到打断发生后
  runUntil(r, (rr) => ev(rr, 'preempt').length > 0, PROBE.handoverStart + 30);
  check('发生高优先级抢占(cancel)', ev(r, 'preempt').some((e) => e.mode === 'cancel'));
  check('递交操作被取消', ev(r, 'op-cancel').some((e) => e.op === 'handover'));
  check('道具归还 A', r.world.propHolder('prop1') === 'A');
  check('黑板 propHolder 同步为 A', r.bbRoot.get('propHolder') === 'A');
  const holderVersionAfterCancel = r.bbRoot.versionOf('propHolder');

  // 叫离期间：A 真实走到侧台
  runUntil(r, (rr) => findNode(rr.tree, '台后等待').status === Status.RUNNING);
  check('A 真实到达侧台', posNear(r.world.actor('A').pos, -7, -4, 0.01), JSON.stringify(r.world.actor('A').pos));
  check('叫离期间道具仍在 A 处', r.world.propHolder('prop1') === 'A');

  // 等两份迟到回执（自动确认+重复）都被处理
  runUntil(r, (rr) => rr.world.droppedReceipts.filter((d) => d.reason === 'op-cancelled').length >= 2);
  check('收到并丢弃两份迟到回执', r.world.droppedReceipts.filter((d) => d.reason === 'op-cancelled').length === 2);
  check('迟到回执未改变占用', r.world.propHolder('prop1') === 'A');
  check('迟到回执未推进 propHolder 版本', r.bbRoot.versionOf('propHolder') === holderVersionAfterCancel);
  check('此刻仍未发生转交', r.world.transferCount === 0);

  // 跑完全场
  const status = r.run(6000);
  check('返场后演出完成', status === Status.SUCCESS);
  check('全程只转交一次（重演后成交）', r.world.transferCount === 1);
  check('最终持有人 B', r.world.propHolder('prop1') === 'B');
  check('「请收下」说了两次（重演）', lines(r, '请收下这个道具。').length === 2);
  check('B 确认接词只在真实成交后出现一次', lines(r, '谢谢，道具我收到了！').length === 1);
  const confirmTick = lines(r, '谢谢，道具我收到了！')[0].tick;
  const acceptTick = ev(r, 'receipt-accept')[0].tick;
  check('确认接词在真实成交之后', confirmTick >= acceptTick);
  const handoverIssues = ev(r, 'op-issue').filter((e) => e.op === 'handover');
  check('重演签发了新 token', handoverIssues.length === 2 && handoverIssues[1].token > handoverIssues[0].token);
}

// ————————————————————————————————
section('4. 确认后叫离：沿新持有人继续演');
{
  const r = new Runner(DEFAULT_TREE);
  const interruptAt = PROBE.transfer + 10; // 成交之后
  r.scheduleInput(interruptAt, '叫离A(cancel)', (rr) => rr.setCalledAway(true, 'cancel'));
  runUntil(r, (rr) => findNode(rr.tree, '台后等待').status === Status.RUNNING, PROBE.transfer + 600);
  check('A 被叫离到侧台', posNear(r.world.actor('A').pos, -7, -4, 0.01));
  check('A 离场期间道具仍归 B', r.world.propHolder('prop1') === 'B');
  const prop = r.world.prop('prop1');
  const b = r.world.actor('B');
  check('道具跟随 B 而非离场的 A', posNear(prop.pos, b.pos.x, b.pos.z, 0.6));

  const status = r.run(6000);
  check('演出完成', status === Status.SUCCESS);
  check('全程只转交一次', r.world.transferCount === 1);
  const handoverIssues = ev(r, 'op-issue').filter((e) => e.op === 'handover');
  check('未签发第二次递交操作（幂等成功）', handoverIssues.length === 1, `got ${handoverIssues.length}`);
  check('记录了幂等成功事件', ev(r, 'handover-idempotent').length === 1);
  check('B 确认接词仅一次', lines(r, '谢谢，道具我收到了！').length === 1);
  const holderLine = r.world.dialogue.filter((d) => d.text === '道具在我这里，演出继续。');
  check('持有人接词两次（打断前+重演）且都由 B 触发',
    holderLine.length === 2 && holderLine.every((d) => d.actor === 'B'),
    JSON.stringify(holderLine));
}

// ————————————————————————————————
section('5. 暂挂语义：打断期间保留现场，恢复后继续同一操作');
{
  const r = new Runner(DEFAULT_TREE);
  const interruptAt = PROBE.handoverStart + 40; // 传递完成、等待确认期间
  r.scheduleInput(interruptAt, '叫离A(suspend)', (rr) => rr.setCalledAway(true, 'suspend'));
  runUntil(r, (rr) => ev(rr, 'op-suspend').length > 0, interruptAt + 30);
  check('递交操作被暂挂', ev(r, 'op-suspend').some((e) => e.op === 'handover'));
  check('暂挂期间占用归递交人 A', r.world.propHolder('prop1') === 'A');

  // 确认回执在暂挂期间到达 -> 被扣留而不是丢弃
  runUntil(r, (rr) => ev(rr, 'receipt-held').length >= 2, interruptAt + 200);
  check('暂挂期间两份回执被扣留', ev(r, 'receipt-held').length === 2);
  check('扣留期间未成交', r.world.transferCount === 0);

  const status = r.run(8000);
  check('演出完成', status === Status.SUCCESS);
  const handoverIssues = ev(r, 'op-issue').filter((e) => e.op === 'handover');
  check('同一 token 恢复（未重发操作）', handoverIssues.length === 1);
  check('恢复后恰好成交一次', r.world.transferCount === 1);
  check('恢复后持有人为 B', r.world.propHolder('prop1') === 'B');
  check('「请收下」只说一次（未重演）', lines(r, '请收下这个道具。').length === 1);
  check('恢复后重复回执被丢弃', r.world.droppedReceipts.some((d) => d.reason === 'op-done'));
}

// ————————————————————————————————
section('6. 手动再注入两份迟到回执：依然幂等');
{
  const r = new Runner(DEFAULT_TREE);
  const interruptAt = PROBE.handoverStart + 10;
  let cancelledToken = null;
  r.scheduleInput(interruptAt, '叫离A(cancel)', (rr) => rr.setCalledAway(true, 'cancel'));
  runUntil(r, (rr) => ev(rr, 'op-cancel').some((e) => e.op === 'handover'), interruptAt + 30);
  cancelledToken = ev(r, 'op-cancel').find((e) => e.op === 'handover').token;
  r.scheduleInput(r.world.tick + 5, '迟到回执x2', (rr) => rr.injectLateReceipts(cancelledToken, 2));
  r.run(6000);
  const drops = r.world.droppedReceipts.filter((d) => d.token === cancelledToken);
  check('该 token 的迟到回执共 4 份全部被丢弃', drops.length === 4, `got ${drops.length}`);
  check('仍然只成交一次', r.world.transferCount === 1);
  check('最终持有人 B', r.world.propHolder('prop1') === 'B');
}

// ————————————————————————————————
section('7. 黑板缺失键：不默认真值放行');
{
  const bb = new Blackboard('t');
  let threw = false;
  try { bb.require('nope'); } catch (e) { threw = e instanceof MissingKeyError; }
  check('require 缺失键抛 MissingKeyError', threw);

  const treeMissingLine = {
    type: 'sequence', name: 't', children: [
      { type: 'speakLine', name: '缺键台词', actor: 'bb:ghost', text: '不该出现' },
    ],
  };
  const r1 = new Runner(treeMissingLine);
  const s1 = r1.run(100);
  check('缺键台词导致失败而非放行', s1 === Status.FAILURE);
  check('缺键台词未说出', r1.world.dialogue.length === 0);

  const treeMissingCond = {
    type: 'reactiveSelector', name: 't', children: [
      { type: 'guarded', name: 'g', guard: { type: 'bbEquals', name: 'c', key: 'ghost', value: true },
        body: { type: 'always', name: 'a' } },
    ],
  };
  const r2 = new Runner(treeMissingCond);
  const s2 = r2.run(100);
  check('缺键条件判失败', s2 === Status.FAILURE);
  check('记录了 missing-key 证据', ev(r2, 'cond-missing-key').some((e) => e.key === 'ghost'));
}

// ————————————————————————————————
section('8. 动作失败反馈回行为树（通道被堵 -> 兜底 -> 重试）');
{
  const r = new Runner(DEFAULT_TREE);
  r.setPathBlocked(true);
  r.scheduleInput(200, '疏通通道', (rr) => rr.setPathBlocked(false));
  const status = r.run(6000);
  check('移动操作失败有明确原因', ev(r, 'op-fail').some((e) => e.reason === 'path-blocked'));
  check('失败反馈触发兜底台词', lines(r, '通道被堵住了，稍等……').length >= 1);
  check('重试发生', ev(r, 'retry').length >= 1);
  check('疏通后演出完成', status === Status.SUCCESS);
  check('最终成交一次', r.world.transferCount === 1);
}

// ————————————————————————————————
section('9. 黑板作用域与版本');
{
  const root = new Blackboard('root');
  root.set('g', 1);
  const scope = root.createScope('inner');
  scope.setLocal('x', 42);
  check('局部键不泄漏到外层', !root.has('x') && scope.has('x'));
  check('内层可读外层键', scope.require('g') === 1);
  const v0 = root.versionOf('g');
  scope.set('g', 2); // 写到声明层（root）
  check('内层写落到声明层', root.require('g') === 2);
  check('写入推进版本', root.versionOf('g') > v0);

  const tree = {
    type: 'scope', name: 's', scopeName: 'inner', child: {
      type: 'sequence', name: 'seq', children: [
        { type: 'setBlackboard', name: 'w1', key: 'localVar', value: 42, scope: 'local' },
        { type: 'setBlackboard', name: 'w2', key: 'globalVar', value: 7 },
      ],
    },
  };
  const r = new Runner(tree);
  r.run(100);
  check('树内 local 写入不进根黑板', !r.bbRoot.has('localVar'));
  check('树内 root 写入进根黑板', r.bbRoot.get('globalVar') === 7);
  const scopeNode = findNode(r.tree, 's');
  check('作用域黑板持有局部键', scopeNode.scopeBB.has('localVar') && scopeNode.scopeBB.get('localVar') === 42);
}

// ————————————————————————————————
section('10. 等待节点：不到时间不完成');
{
  const tree = { type: 'sequence', name: 't', children: [{ type: 'wait', name: 'w', duration: 1.0 }] };
  const r = new Runner(tree);
  const w = findNode(r.tree, 'w');
  for (let i = 0; i < 20; i++) r.step(); // 0.67s
  check('等待中保持 RUNNING', w.status === Status.RUNNING && !r.done);
  for (let i = 0; i < 15; i++) r.step(); // +0.5s
  check('到时后成功', w.status === Status.SUCCESS && r.done);
}

// ————————————————————————————————
section('11. 导航途中被抢占：取消旧导航意图');
{
  const r = new Runner(DEFAULT_TREE);
  const interruptAt = PROBE.handoverStart - 25; // A 还在走向 B
  r.scheduleInput(interruptAt, '叫离A(cancel)', (rr) => rr.setCalledAway(true, 'cancel'));
  runUntil(r, (rr) => ev(rr, 'op-cancel').length > 0, interruptAt + 30);
  const cancels = ev(r, 'op-cancel');
  check('旧导航操作被取消', cancels.some((e) => e.op === 'move'));
  const move = findNode(r.tree, '走向B');
  check('移动节点以 aborted 退出', move.lastExitStatus === 'aborted');
  const status = r.run(8000);
  check('返场后重新走位并完成演出', status === Status.SUCCESS);
  check('最终持有人 B', r.world.propHolder('prop1') === 'B');
  const moveIssues = ev(r, 'op-issue').filter((e) => e.op === 'move' && e.actor === 'A');
  check('导航意图重新签发（重进重发）', moveIssues.length >= 2, `got ${moveIssues.length}`);
}

// ————————————————————————————————
console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) { console.log('失败用例:', failures.join(' | ')); process.exit(1); }
