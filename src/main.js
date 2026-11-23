// 入口：装配 3D 舞台、行为树视图、面板与控制器。
// 所有控件都通过「输入队列 -> 内核」生效（不直接改世界），
// 输入被记录下来，可随时重放（同一棵树、同一批输入 -> 同样的结果）。

import { Runner, DT, probe } from './runner.js';
import { DEFAULT_TREE } from './scenario.js';
import { Stage3D } from './ui/stage3d.js';
import { TreeView } from './ui/treeview.js';
import { LogView, BlackboardView, ResultView } from './ui/panel.js';
import { Scope } from './bt/nodes.js';

const $ = (id) => document.getElementById(id);

const stage = new Stage3D($('stage'));
const treeView = new TreeView($('tree-view'));
const logView = new LogView($('log-view'));
const bbView = new BlackboardView($('bb-view'));
const resultView = new ResultView($('result-body'));

const editor = $('tree-editor');
editor.value = JSON.stringify(DEFAULT_TREE, null, 2);

let runner = null;
let paused = true;
let speed = 1;
let recording = []; // { atTick, kind, args, label }
let bubbleCursor = 0;

// —— 输入规格 -> 应用到运行器（录制与重放共用） ——
function applySpec(r, spec) {
  switch (spec.kind) {
    case 'calledAway':
      r.scheduleInput(spec.atTick, spec.label, (rr) => rr.setCalledAway(true, spec.mode));
      break;
    case 'confirmB':
      r.scheduleInput(spec.atTick, spec.label, (rr) => {
        const op = [...rr.world.ops.values()].find((o) => o.type === 'handover' && o.status === 'active');
        if (op) rr.world.injectReceipt(op.token, 'confirm', 'B-manual');
      });
      break;
    case 'lateReceipts':
      r.scheduleInput(spec.atTick, spec.label, (rr) => {
        const op = [...rr.world.ops.values()].filter((o) => o.type === 'handover' && o.status === 'cancelled').pop();
        if (op) rr.injectLateReceipts(op.token, 2);
      });
      break;
    case 'blockPath':
      r.scheduleInput(spec.atTick, spec.label, (rr) => rr.setPathBlocked(spec.value));
      break;
    default:
      throw new Error(`unknown spec ${spec.kind}`);
  }
}

function recordAndApply(spec) {
  recording.push(spec);
  applySpec(runner, spec);
}

function parseEditor() {
  try {
    const def = JSON.parse(editor.value);
    $('editor-error').textContent = '';
    return def;
  } catch (e) {
    $('editor-error').textContent = `JSON 错误：${e.message}`;
    return null;
  }
}

function launch(treeDef, { keepRecording = false } = {}) {
  try {
    runner = new Runner(treeDef, {});
  } catch (e) {
    $('editor-error').textContent = `构建失败：${e.message}`;
    runner = null;
    return;
  }
  if (!keepRecording) recording = [];
  for (const spec of recording) applySpec(runner, spec);
  bubbleCursor = 0;
  $('bubbles').innerHTML = '';
  logView.reset();
  treeView.build(runner.tree);
  paused = false;
  updateButtons();
  $('btn-pause').textContent = '⏸ 暂停';
}

function updateButtons() {
  const has = !!runner;
  for (const id of ['btn-pause', 'btn-step', 'btn-replay', 'btn-call-cancel', 'btn-call-suspend', 'btn-confirm', 'btn-late', 'chk-block', 'sel-preset', 'btn-schedule']) {
    $(id).disabled = !has;
  }
}

// —— 控件 ——

$('btn-launch').onclick = () => {
  const def = parseEditor();
  if (def) launch(def);
};
$('btn-apply').onclick = () => {
  const def = parseEditor();
  if (def) launch(def);
};
$('btn-reset-tree').onclick = () => {
  editor.value = JSON.stringify(DEFAULT_TREE, null, 2);
  $('editor-error').textContent = '';
};
$('btn-pause').onclick = () => {
  paused = !paused;
  $('btn-pause').textContent = paused ? '▶ 继续' : '⏸ 暂停';
};
$('btn-step').onclick = () => {
  if (!runner) return;
  paused = true;
  $('btn-pause').textContent = '▶ 继续';
  runner.step();
};
$('btn-replay').onclick = () => {
  const def = parseEditor();
  if (def) launch(def, { keepRecording: true });
};
$('sel-speed').onchange = (e) => { speed = Number(e.target.value); };

$('btn-call-cancel').onclick = () => {
  if (!runner) return;
  recordAndApply({ atTick: runner.world.tick + 1, kind: 'calledAway', mode: 'cancel', label: '叫离A(取消)' });
};
$('btn-call-suspend').onclick = () => {
  if (!runner) return;
  recordAndApply({ atTick: runner.world.tick + 1, kind: 'calledAway', mode: 'suspend', label: '叫离A(暂挂)' });
};
$('btn-schedule').onclick = () => {
  const def = parseEditor();
  if (!def || !runner) return;
  const p = probe(def);
  if (p.handoverEnter === null || p.transfer === null) {
    $('editor-error').textContent = '探针失败：当前树中递交/成交未发生，无法设定抢占时刻';
    return;
  }
  const preset = $('sel-preset').value;
  const offsets = { before: -25, during: 10, awaiting: 40, after: null };
  const atTick = preset === 'after' ? p.transfer + 10 : Math.max(1, p.handoverEnter + offsets[preset]);
  const mode = 'cancel';
  recordAndApply({ atTick, kind: 'calledAway', mode, label: `定时叫离@${atTick}(${preset})` });
  $('editor-error').textContent = `已设定：tick ${atTick} 叫离 A（探针：递交@${p.handoverEnter} 成交@${p.transfer}）`;
};
$('btn-confirm').onclick = () => {
  if (!runner) return;
  recordAndApply({ atTick: runner.world.tick + 1, kind: 'confirmB', label: 'B手动确认' });
};
$('btn-late').onclick = () => {
  if (!runner) return;
  recordAndApply({ atTick: runner.world.tick + 1, kind: 'lateReceipts', label: '注入迟到回执×2' });
};
$('chk-block').onchange = (e) => {
  if (!runner) return;
  recordAndApply({ atTick: runner.world.tick + 1, kind: 'blockPath', value: e.target.checked, label: e.target.checked ? '封锁通道' : '疏通通道' });
};

// —— 气泡台词 ——

function updateBubbles() {
  if (!runner) return;
  const dlg = runner.world.dialogue;
  for (; bubbleCursor < dlg.length; bubbleCursor++) {
    const d = dlg[bubbleCursor];
    const div = document.createElement('div');
    div.className = 'bubble';
    div.textContent = `${d.actor}：${d.text}`;
    $('bubbles').appendChild(div);
    const actor = runner.world.actor(d.actor);
    const place = () => {
      const p = stage.projectToScreen(actor.pos.x, 2.1, actor.pos.z);
      div.style.left = `${p.x}px`;
      div.style.top = `${p.y}px`;
    };
    place();
    setTimeout(() => { div.style.opacity = '0'; }, 2200);
    setTimeout(() => div.remove(), 2700);
  }
}

// —— 黑板附加作用域（Scope 节点） ——

function collectScopes(node, out = []) {
  if (node instanceof Scope && node.scopeBB) out.push(node.scopeBB);
  const kids = [];
  if (node.children) kids.push(...node.children);
  if (node.child) kids.push(node.child);
  if (node.body) kids.push(node.body);
  for (const k of kids) collectScopes(k, out);
  return out;
}

// —— 主循环 ——

let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (runner && !paused && !runner.done) {
    acc += realDt * speed;
    let steps = 0;
    while (acc >= DT && steps < 400) {
      runner.step();
      acc -= DT;
      steps += 1;
      if (runner.done) break;
    }
  }
  if (runner) {
    stage.syncFromWorld(runner.world);
    treeView.update();
    logView.update(runner.events);
    bbView.update(runner.bbRoot, collectScopes(runner.tree));
    resultView.update(runner);
    updateBubbles();
    const t = runner.world;
    $('clock').textContent = `tick ${t.tick} · ${t.time.toFixed(2)}s · ${runner.done ? `结束(${runner.tree.status})` : paused ? '已暂停' : '运行中'}`;
  } else {
    resultView.update(null);
  }
  stage.render();
}

// 初始：预建一棵未启动的树供检查
launch(parseEditor());
paused = true;
$('btn-pause').textContent = '▶ 继续';
$('clock').textContent = 'tick 0 · 0.00s · 未启动（点「▶ 启动 / 重启」开演）';
requestAnimationFrame(frame);
