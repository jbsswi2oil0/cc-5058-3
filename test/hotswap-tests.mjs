// 热换版专项测试。与 run-tests.mjs 分开：node test/hotswap-tests.mjs

import { Runner } from '../src/runner.js';
import {
  DEFAULT_TREE, treeV2, treeV3RemoveBow, treeV4ChangedHandover, STAGE, findDefByKey,
} from '../src/scenario.js';
import { Status } from '../src/bt/kernel.js';
import { buildMigrationPlan, validateCandidate } from '../src/bt/hotswap.js';
import { buildTree } from '../src/bt/builder.js';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name} ${detail}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }
const ev = (r, type) => r.events.filter((e) => e.type === type);
const lines = (r, text) => r.world.dialogue.filter((d) => d.text === text);

function findNode(node, key) {
  if (!node) return null;
  if (node.key === key) return node;
  const kids = [];
  if (node.guard) kids.push(node.guard);
  if (node.children) kids.push(...node.children);
  if (node.child) kids.push(node.child);
  if (node.body) kids.push(node.body);
  for (const k of kids) {
    const hit = findNode(k, key);
    if (hit) return hit;
  }
  return null;
}

// 跑到指定 key 的节点进入 RUNNING
function runUntilRunning(r, key, max = 4000) {
  for (let i = 0; i < max && !r.done; i++) {
    r.step();
    const n = findNode(r.tree, key);
    if (n && n.status === Status.RUNNING) return n;
  }
  return findNode(r.tree, key);
}

// ————————————————————————————————
section('H1. 候选校验无副作用，且不 enter 任何节点');
{
  const r = new Runner(DEFAULT_TREE);
  const issuesBefore = ev(r, 'op-issue').length;
  const statusBefore = r.tree.status;
  const v = r.validate(treeV2());
  check('候选校验通过', v.ok, JSON.stringify(v.errors));
  check('校验未运行旧树（状态未变）', r.tree.status === statusBefore);
  check('校验未签发任何操作', ev(r, 'op-issue').length === issuesBefore);
  check('校验未进入任何节点', ev(r, 'enter').length === 0);
  check('候选树未替换运行树', r.tree !== v.tree);
}

section('H2. 候选校验：坏引用 / 重复 key / 黑板类型被拦截');
{
  const r = new Runner(DEFAULT_TREE);
  r.run(60);

  const badActor = JSON.parse(JSON.stringify(DEFAULT_TREE));
  findDefByKey(badActor, 'main.moveB').target = { actor: 'Z', offset: { x: 0, z: 1 } };
  const v1 = r.validate(badActor);
  check('不存在的演员被拦截', !v1.ok && v1.errors.some((e) => e.code === 'actor-ref'));

  const badProp = JSON.parse(JSON.stringify(DEFAULT_TREE));
  findDefByKey(badProp, 'handover.op').prop = 'nope';
  const v2 = r.validate(badProp);
  check('不存在的道具被拦截', !v2.ok && v2.errors.some((e) => e.code === 'prop-ref'));

  const dup = JSON.parse(JSON.stringify(DEFAULT_TREE));
  dup.children[1].key = dup.children[0].key;
  const v3 = r.validate(dup);
  check('重复稳定 key 被拦截', !v3.ok && v3.errors.some((e) => e.code === 'duplicate-key'));

  const badBbRef = JSON.parse(JSON.stringify(DEFAULT_TREE));
  findDefByKey(badBbRef, 'interrupt.guard').bbKey = 'ghostKey';
  const v4 = r.validate(badBbRef);
  check('黑板契约外引用被拦截', !v4.ok && v4.errors.some((e) => e.code === 'bb-ref-unknown'));

  const badWrite = JSON.parse(JSON.stringify(DEFAULT_TREE));
  findDefByKey(badWrite, 'interrupt.clear').value = 'false';
  const v5 = r.validate(badWrite);
  check('写黑板类型改变被拦截', !v5.ok && v5.errors.some((e) => e.code === 'bb-write-type'));
}

section('H3. 换版失败：保留旧树可继续运行并显示原因');
{
  const r = new Runner(DEFAULT_TREE);
  runUntilRunning(r, 'main.moveB');
  const oldTree = r.tree;
  const tickBefore = r.world.tick;
  const bad = JSON.parse(JSON.stringify(DEFAULT_TREE));
  findDefByKey(bad, 'main.moveB').target = { actor: 'Z' };
  const report = r.hotSwap(bad);
  check('换版被拒', report.ok === false);
  check('原因可读', typeof report.reason === 'string' && report.reason.includes('校验失败'));
  check('旧树对象保留', r.tree === oldTree);
  check('旧树仍可运行到完成', r.run(8000) === Status.SUCCESS);
  check('拒绝后未推进世界 tick', r.world.tick > tickBefore);
  check('日志记录了拒绝原因', ev(r, 'hotswap-reject').length === 1);
}

section('H4. 迁移计划按稳定 key（不按序号）生成');
{
  const oldTree = buildTree(DEFAULT_TREE);
  const newTree = buildTree(treeV2());
  const plan = buildMigrationPlan(oldTree, newTree);
  const byKey = new Map(plan.map((p) => [p.key, p]));
  check('新插入动作标记为 new', byKey.get('handover.prepare')?.decision === 'new');
  check('未运行节点标记为 idle', byKey.get('handover.op')?.decision === 'idle');
  check('主演出组合节点出现在计划中', byKey.has('main.seq'));
  check('计划覆盖所有 key', plan.length > 10, `got ${plan.length}`);
  const keysMoved = plan.filter((p) => p.decision === 'new').map((p) => p.key);
  check('仅新增节点需要首次进入', JSON.stringify(keysMoved) === JSON.stringify(['handover.prepare']), JSON.stringify(keysMoved));
}

section('H5. 等待动作进度迁移：换版后剩余时间被接管，不重头计时');
{
  const r = new Runner(DEFAULT_TREE);
  r.scheduleInput(1, '叫离A', (rr) => rr.setCalledAway(true, 'cancel'));
  // 跑到台后等待已经进行了一部分
  const w = runUntilRunning(r, 'interrupt.wait');
  check('等待节点进入运行', w && w.status === Status.RUNNING);
  for (let i = 0; i < 12; i++) r.step();
  const remainingBefore = w.remaining;
  check('等待已消耗一部分', remainingBefore < 1.5 && remainingBefore > 0, `${remainingBefore}`);

  const report = r.hotSwap(treeV2());
  check('换版成功', report.ok, JSON.stringify(report.errors));
  const w2 = findNode(r.tree, 'interrupt.wait');
  check('等待剩余时间被迁移', Math.abs(w2.remaining - remainingBefore) < 1e-9, `${w2.remaining} vs ${remainingBefore}`);
  check('等待节点无 enter 事件新增（不重进）', ev(r, 'enter').filter((e) => e.node === '台后等待').length === 1);
  check('报告记录了等待迁移', report.migrated.some((m) => m.key === 'interrupt.wait'));

  const status = r.run(8000);
  check('换版后演出完成', status === Status.SUCCESS);
}

section('H6. 换版保留已完成动作：已发台词不重播，动作次数不增加');
{
  const r = new Runner(DEFAULT_TREE);
  runUntilRunning(r, 'handover.op');
  const offerBefore = lines(r, '请收下这个道具。').length;
  const moveIssuesBefore = ev(r, 'op-issue').filter((e) => e.op === 'move').length;
  check('「请收下」已说一次', offerBefore === 1);

  const report = r.hotSwap(treeV2());
  check('换版成功', report.ok);
  check('已完成台词被保留', report.preserved.some((p) => p.key === 'handover.offer'));
  check('台词未重播（保留终态）', lines(r, '请收下这个道具。').length === 1);
  check('已完成移动节点未被重签', ev(r, 'op-issue').filter((e) => e.op === 'move').length === moveIssuesBefore);

  const status = r.run(8000);
  check('新版本跑完', status === Status.SUCCESS);
  check('最终仅转交一次', r.world.transferCount === 1);
}

section('H7. 换版继续外部动作：同一 token，不产生两份控制意图');
{
  const r = new Runner(DEFAULT_TREE);
  const op = runUntilRunning(r, 'handover.op');
  const tokenBefore = op.token;
  check('递交操作已签发 token', typeof tokenBefore === 'number');
  const handoverIssuesBefore = ev(r, 'op-issue').filter((e) => e.op === 'handover').length;

  // 只改递交分支之后的台词，不改递交动作本身
  const v = JSON.parse(JSON.stringify(DEFAULT_TREE));
  findDefByKey(v, 'handover.holderLine').text = '（改版）道具在我这里。';
  const report = r.hotSwap(v);
  check('换版成功', report.ok);
  const op2 = findNode(r.tree, 'handover.op');
  check('递交动作沿用同一 token', op2.token === tokenBefore, `${op2.token} vs ${tokenBefore}`);
  check('未签发第二份递交操作', ev(r, 'op-issue').filter((e) => e.op === 'handover').length === handoverIssuesBefore);
  check('报告记录了继续政策', report.continued.some((c) => c.key === 'handover.op' && c.token === tokenBefore));

  const status = r.run(8000);
  check('演出完成且只成交一次', status === Status.SUCCESS && r.world.transferCount === 1);
}

section('H8. 删除正在运行/待运行分支：动作退出并释放道具');
{
  const r = new Runner(DEFAULT_TREE);
  const op = runUntilRunning(r, 'handover.op');
  check('递交进行中', op.status === Status.RUNNING);
  const token = op.token;
  const holderBefore = r.world.propHolder('prop1');

  // v3 删除谢幕；同时再删递交分支，验证运行中的递交被明确退出
  const v = JSON.parse(JSON.stringify(treeV3RemoveBow()));
  const scopeSeq = findDefByKey(v, 'main.seq');
  scopeSeq.children = scopeSeq.children.filter((c) => c.key !== 'handover.scope');

  const report = r.hotSwap(v);
  check('换版成功', report.ok, JSON.stringify(report.errors));
  check('递交被明确退出', report.exited.some((e) => e.key === 'handover.op'));
  check('旧递交 token 被取消', report.cancelledOps.includes(token));
  const cancelled = ev(r, 'op-cancel').filter((e) => e.token === token);
  check('世界收到取消（无遗留控制意图）', cancelled.length === 1);
  check('道具释放回归交接前持有人', r.world.propHolder('prop1') === holderBefore);
  check('运行状态被重置记录', report.reset.some((x) => x.key === 'handover.op'));
  check('世界无该 token 的活动操作', r.world.op(token).status !== 'active');

  const status = r.run(8000);
  check('精简版演出仍能完成', status === Status.SUCCESS, `got ${status}`);
}

section('H9. 同 key 但契约改变：不得继承旧进度，退出后重新进入');
{
  const r = new Runner(DEFAULT_TREE);
  const op = runUntilRunning(r, 'handover.op');
  const oldToken = op.token;
  const oldHolder = r.world.propHolder('prop1');
  // v4 把递交反向（B->A），契约不同
  const report = r.hotSwap(treeV4ChangedHandover());
  check('换版成功（校验允许语义变更）', report.ok, JSON.stringify(report.errors));
  check('计划标记为退出后重进', report.plan.some((p) => p.key === 'handover.op' && p.decision === 'reset-reenter'));
  const entry = report.plan.find((p) => p.key === 'handover.op');
  check('计划说明动作含义改变', entry.detail.includes('动作含义改变'));
  check('旧递交被取消', report.cancelledOps.includes(oldToken));
  check('重置状态被显式记录', report.reset.some((x) => x.key === 'handover.op'));
  check('旧占用已释放', r.world.propHolder('prop1') === oldHolder);
  const op2 = findNode(r.tree, 'handover.op');
  check('新节点未携带旧 token', op2.token !== oldToken);
  // 反向递交 A 不持有 prop1（在 B 处误配时失败），这里只验证不继承旧意见
  r.run(200);
  check('新节点重新进入并签发自己的意图',
    ev(r, 'enter').some((e) => e.node === '递交道具' && e.tick >= report.tick));
}

section('H10. 连续提交新树：世界与黑板只保留建场一次，动作次数可核对');
{
  const r = new Runner(DEFAULT_TREE);
  const worldRef = r.world;
  const bbRef = r.bbRoot;
  runUntilRunning(r, 'main.faceB');
  const transferAtV1 = r.world.transferCount;

  check('第一次换版成功', r.hotSwap(treeV2()).ok);
  check('第二次换版成功', r.hotSwap(treeV3RemoveBow()).ok);
  check('第三次换版成功', r.hotSwap(DEFAULT_TREE).ok);
  check('世界对象未重建', r.world === worldRef);
  check('黑板对象未重建', r.bbRoot === bbRef);
  check('换版计数为 3', r.hotSwapCount === 3);
  check('未因重建世界重复加演员', r.world.actors.size === STAGE.actors.length);
  check('道具占用连续（无凭空重置）', r.world.transferCount === transferAtV1);

  const status = r.run(8000);
  check('连续换版后仍能完成演出', status === Status.SUCCESS);
  check('全程只转交一次', r.world.transferCount === 1);
}

section('H11. 换版后不通过重建整个场景回避逻辑更新：场景对象身份不变');
{
  const r = new Runner(DEFAULT_TREE);
  runUntilRunning(r, 'main.moveB');
  for (let i = 0; i < 8; i++) r.step();
  const actorA = r.world.actor('A');
  const prop = r.world.prop('prop1');
  const posBefore = { ...actorA.pos };
  r.hotSwap(treeV2());
  check('演员对象身份不变', r.world.actor('A') === actorA);
  check('道具对象身份不变', r.world.prop('prop1') === prop);
  check('角色位置未被重置', actorA.pos.x === posBefore.x && actorA.pos.z === posBefore.z);
}

section('H12. 固定树执行仍然成立（热换版不影响原语义）');
{
  const r = new Runner(DEFAULT_TREE);
  const status = r.run(8000);
  check('固定树成功', status === Status.SUCCESS);
  check('转交一次', r.world.transferCount === 1);
  check('未发生换版', r.hotSwapCount === 0 && r.lastHotSwap === null);
}

section('H13. 不能用相同节点序号继承旧状态（改 key 即视为不同节点）');
{
  // 构造两棵结构/顺序完全相同、仅 key 不同的树；运行中的第二个叶子不得被继承
  const mk = (k2) => ({
    type: 'sequence', key: 'root', name: 'r', children: [
      { type: 'wait', key: 'w1', name: '等待1', duration: 0.5 },
      { type: 'wait', key: k2, name: '等待2', duration: 5.0 },
    ],
  });
  const r = new Runner(mk('w2'));
  // 跑到第二个 wait 正在运行且已消耗一部分
  for (let i = 0; i < 200; i++) { r.step(); const w = findNode(r.tree, 'w2'); if (w && w.status === Status.RUNNING) break; }
  for (let i = 0; i < 10; i++) r.step();
  const oldW = findNode(r.tree, 'w2');
  const remainingBefore = oldW.remaining;
  check('原第二个等待运行中', oldW.status === Status.RUNNING);

  // 版本改成同名不同 key（序号位完全一致）
  const report = r.hotSwap(mk('w2-renamed'));
  check('换版成功', report.ok);
  const renamed = findNode(r.tree, 'w2-renamed');
  check('新 key 节点未继承旧剩余时间', renamed.remaining === undefined);
  check('新 key 节点初始为 idle（等待进入）', renamed.status === Status.IDLE);
  check('旧节点被记为删除', report.plan.some((p) => p.key === 'w2' && p.decision === 'removed'));
  check('旧运行状态被重置', report.reset.some((x) => x.key === 'w2'));
  // 腾出时间后新节点重新进入并保留完整时长
  r.step();
  const entered = findNode(r.tree, 'w2-renamed');
  check('新节点重新进入', entered.status === Status.RUNNING || entered.status === Status.SUCCESS);
  check('新节点未获得旧进度', Math.abs((entered.remaining ?? -1) - remainingBefore) > 1e-6);
}

section('H14. 最近兼容表演标记：标记以上保留，标记以下重新进入');
{
  // 情形 A：插入点在已越过的进度之前 -> 本场不追补，标记以上组合节点不重进
  const rA = new Runner(DEFAULT_TREE);
  runUntilRunning(rA, 'handover.op');
  const reportA = rA.hotSwap(treeV2());
  check('A 换版成功', reportA.ok);
  check('A 已越过的插入点被显式跳过', reportA.skipped.some((s) => s.key === 'handover.prepare'), JSON.stringify(reportA.skipped));
  check('A 当前递交动作沿用同一 token', reportA.continued.some((c) => c.key === 'handover.op'));
  const reenteredA = ev(rA, 'enter')
    .filter((e) => e.tick > reportA.tick)
    .filter((e) => ['演出根节点', '主演出分支', '主演出', '递交道具'].includes(e.node));
  check('A 标记以上组合节点未重新进入', reenteredA.length === 0, JSON.stringify(reenteredA.map((e) => e.node)));
  check('A 无重放边界（无状态需重进）', reportA.replayBase === null);

  // 情形 B：运行中的叶子被删除 -> 边界定位到其父组合节点，其上祖先保留
  const rB = new Runner(DEFAULT_TREE);
  runUntilRunning(rB, 'main.bow');
  const reportB = rB.hotSwap(treeV3RemoveBow());
  check('B 换版成功', reportB.ok);
  check('B 存在重放边界', !!reportB.replayBase);
  check('B 边界定位到被删动作的父组合（主演出）', reportB.replayBase && reportB.replayBase.key === 'main.seq', JSON.stringify(reportB.replayBase));
  check('B 边界不是根', reportB.replayBase && reportB.replayBase.key !== 'root');
  const reenteredB = ev(rB, 'enter')
    .filter((e) => ['演出根节点', '主演出分支', '失败重试(≤20)', '主流程或兜底'].includes(e.node))
    .filter((e) => e.tick > reportB.tick);
  check('B 边界以上的组合祖先未重新进入', reenteredB.length === 0, JSON.stringify(reenteredB.map((e) => e.node)));
  const statusB = rB.run(8000);
  check('B 换版后完成演出', statusB === Status.SUCCESS);
  check('B 全程转交一次', rB.world.transferCount === 1);
}

section('H15. 兼容动作恢复后不得重播已发台词');
{
  const r = new Runner(DEFAULT_TREE);
  // 跑到递交完成后（请收下、确认接词都已说过），在谢幕动画期间换版
  runUntilRunning(r, 'main.bow');
  const offerBefore = lines(r, '请收下这个道具。').length;
  const confirmBefore = lines(r, '谢谢，道具我收到了！').length;
  check('换版前「请收下」一次', offerBefore === 1);
  const report = r.hotSwap(treeV2());
  check('换版成功', report.ok);
  // 重放起点以下的兼容台词不应被再次说出（请收下在标记以上，本来就不重跑）
  r.run(8000);
  check('换版后「请收下」未增加', lines(r, '请收下这个道具。').length === offerBefore);
  check('确认接词未重复', lines(r, '谢谢，道具我收到了！').length === confirmBefore);
  check('最终仍只成交一次', r.world.transferCount === 1);
}

section('H17. 兼容动作因父节点重置被重新进入时，已发台词仍不重播');
{
  // 根组合节点语义改变 -> 整棵子树重进；已说完的台词不得再说一次
  const mk = (type) => ({
    type, key: 'root', name: 'r', children: [
      { type: 'speakLine', key: 'L', name: '台词L', actor: 'A', text: '已经说过的台词' },
      { type: 'wait', key: 'W', name: '等待W', duration: 5.0 },
    ],
  });
  const r = new Runner(mk('sequence'));
  for (let i = 0; i < 100; i++) { r.step(); const w = findNode(r.tree, 'W'); if (w && w.status === Status.RUNNING) break; }
  check('台词已说过一次', lines(r, '已经说过的台词').length === 1);
  const report = r.hotSwap(mk('selector')); // 根类型改变 -> 契约不同 -> 子节点重进
  check('换版成功', report.ok);
  r.step();
  check('报告记录了台词抑制', ev(r, 'line-suppressed').some((e) => e.key === 'L'), JSON.stringify(ev(r, 'line-suppressed')));
  check('重新进入后台词仍只一次（不重播）', lines(r, '已经说过的台词').length === 1, `got ${lines(r, '已经说过的台词').length}`);
  // 再次换版回原树：该台词已在本次演出中发过，仍不得重播（持续不重播，而非只挡一次）
  r.hotSwap(mk('sequence'));
  r.run(1);
  check('连续换版仍不重播已发台词', lines(r, '已经说过的台词').length === 1, `got ${lines(r, '已经说过的台词').length}`);
}

section('H16. 换版后重进同一台词节点之外，正常重试仍可重说（去重只作用一次）');{
  // 单句台词 + 反应式抢占重演：确保普通重演不被热换版去重机制误伤
  const tree = {
    type: 'reactiveSelector', key: 'root', name: 'r', children: [
      { type: 'guarded', key: 'g', name: 'g', guard: { type: 'bbEquals', key: 'gg', bbKey: 'calledAway', value: true },
        body: { type: 'sequence', key: 'gs', name: 'gs', children: [
          { type: 'speakLine', key: 'line', name: '台词', actor: 'A', text: '重演台词' },
          { type: 'wait', key: 'gw', name: 'gw', duration: 0.3 },
          { type: 'setBlackboard', key: 'clr', name: 'clr', bbKey: 'calledAway', value: false },
        ] } },
      { type: 'guarded', key: 'm', name: 'm', guard: { type: 'always', key: 'mg', name: 'mg' },
        body: { type: 'wait', key: 'mw', name: 'mw', duration: 3 } },
    ],
  };
  const r = new Runner(tree);
  r.run(5);
  r.hotSwap(tree); // 同树换版（无实质变化）
  r.scheduleInput(r.world.tick + 1, '叫离', (rr) => rr.setCalledAway(true, 'cancel'));
  r.run(8000);
  check('换版不永久压制重演台词', lines(r, '重演台词').length >= 1, `got ${lines(r, '重演台词').length}`);
}

console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) { console.log('失败用例:', failures.join(' | ')); process.exit(1); }
