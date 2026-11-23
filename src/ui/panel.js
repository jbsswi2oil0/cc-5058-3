// 侧面板：黑板视图（作用域+版本）、事件日志、结果区校验。

const LOG_CLASS = {
  enter: 'log-enter', exit: 'log-dim', preempt: 'log-warn', suspend: 'log-warn', resume: 'log-warn',
  'op-issue': 'log-dim', 'op-done': 'log-ok', 'op-cancel': 'log-warn', 'op-fail': 'log-err',
  'op-suspend': 'log-warn', 'op-resume': 'log-warn',
  'receipt-accept': 'log-ok', 'receipt-drop': 'log-err', 'receipt-held': 'log-warn',
  'prop-restored': 'log-warn', line: 'log-line', 'bb-set': 'log-dim', retry: 'log-warn',
  'action-issue': 'log-dim', 'action-failed': 'log-err', 'cond-missing-key': 'log-err',
  'handover-idempotent': 'log-ok', 'tree-done': 'log-ok', input: 'log-enter', 'scope-enter': 'log-dim',
};

function fmtVal(v) {
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function describeEvent(e) {
  switch (e.type) {
    case 'enter': return `进入 ${e.node}`;
    case 'exit': return `退出 ${e.node} -> ${e.status}${e.reason ? ` (${e.reason})` : ''}`;
    case 'preempt': return `抢占 ${e.from} ⇒ ${e.to} [${e.mode}]`;
    case 'suspend': return `暂挂 ${e.node}`;
    case 'resume': return `恢复 ${e.node}`;
    case 'op-issue': return `签发操作#${e.token} ${e.op}${e.actor ? ` ${e.actor}` : ''}${e.giver ? ` ${e.giver}->${e.receiver}` : ''}`;
    case 'op-done': return `完成操作#${e.token} ${e.op}`;
    case 'op-cancel': return `取消操作#${e.token} ${e.op} (${e.reason})`;
    case 'op-fail': return `失败操作#${e.token} ${e.op} (${e.reason})`;
    case 'op-suspend': return `暂挂操作#${e.token} ${e.op}${e.occupancy ? ` 占用:${e.occupancy}` : ''}`;
    case 'op-resume': return `恢复操作#${e.token} ${e.op}`;
    case 'receipt-accept': return `接受回执#${e.token} ${e.kind} <- ${e.source} 持有人:${e.holder}`;
    case 'receipt-drop': return `丢弃迟到回执#${e.token} ${e.kind} <- ${e.source} (${e.reason})`;
    case 'receipt-held': return `扣留回执#${e.token} ${e.kind} <- ${e.source}（暂挂中）`;
    case 'prop-restored': return `道具归还 ${e.holder}（${e.reason}）`;
    case 'line': return `台词 ${e.actor}:「${e.text}」`;
    case 'bb-set': return `写黑板 ${e.key} = ${fmtVal(e.value)} [${e.scope}]`;
    case 'retry': return `重试 ${e.node} 第${e.attempt}/${e.max}次`;
    case 'action-issue': return `${e.node} 签发 #${e.token}`;
    case 'action-failed': return `${e.node} 失败：${e.reason}`;
    case 'cond-missing-key': return `条件缺键拦截：${e.key}（判失败，未放行）`;
    case 'handover-idempotent': return `${e.node} 幂等成功（${e.prop} 已在 ${e.holder} 手中）`;
    case 'tree-done': return `演出结束：${e.status}`;
    case 'input': return `输入：${e.label}`;
    case 'scope-enter': return `进入作用域 ${e.scope}`;
    default: return `${e.type} ${JSON.stringify(e).slice(0, 90)}`;
  }
}

export class LogView {
  constructor(container) {
    this.container = container;
    this.rendered = 0;
  }
  reset() { this.container.innerHTML = ''; this.rendered = 0; }
  update(events) {
    for (; this.rendered < events.length; this.rendered++) {
      const e = events[this.rendered];
      const div = document.createElement('div');
      div.className = LOG_CLASS[e.type] || '';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = `#${e.tick}`;
      div.appendChild(t);
      div.appendChild(document.createTextNode(describeEvent(e)));
      this.container.appendChild(div);
    }
    this.container.scrollTop = this.container.scrollHeight;
  }
}

export class BlackboardView {
  constructor(container) { this.container = container; }
  update(bbRoot, extraScopes) {
    const layers = [...bbRoot.dump()];
    for (const s of extraScopes) layers.unshift(...s.dump().slice(0, 1));
    let html = '';
    for (const layer of layers) {
      html += `<div class="scope-name">作用域 ${layer.name}（v${layer.version}）</div>`;
      html += '<table><tr><th>键</th><th>值</th><th>版本</th><th>更新@tick</th></tr>';
      const keys = Object.keys(layer.entries);
      if (keys.length === 0) html += '<tr><td colspan="4" style="color:#566072">（空）</td></tr>';
      for (const k of keys) {
        const e = layer.entries[k];
        html += `<tr><td>${k}</td><td class="val">${fmtVal(e.value)}</td><td>v${e.version}</td><td>${e.updatedTick}</td></tr>`;
      }
      html += '</table>';
    }
    this.container.innerHTML = html;
  }
}

export class ResultView {
  constructor(container) { this.container = container; }

  update(runner) {
    if (!runner) { this.container.innerHTML = '<span style="color:#566072">尚未启动。点击「▶ 启动 / 重启」。</span>'; return; }
    const w = runner.world;
    const holder = w.propHolder('prop1');
    const confirmLines = w.dialogue.filter((d) => d.text.includes('收到了'));
    const holderLines = w.dialogue.filter((d) => d.text === '道具在我这里，演出继续。');
    const missingKeys = runner.events.filter((e) => e.type === 'cond-missing-key');
    const checks = [];
    checks.push({ ok: w.transferCount <= 1, text: `道具转交次数 = ${w.transferCount}（不得重复转交）` });
    checks.push({ ok: confirmLines.length === w.transferCount, text: `确认接词 ${confirmLines.length} 次 = 成交 ${w.transferCount} 次（迟到回执未触发台词）` });
    checks.push({ ok: holderLines.every((d) => d.actor === runner.bbRoot.get('propHolder')), text: `持有人接词与黑板 propHolder(${runner.bbRoot.get('propHolder')}) 一致` });
    checks.push({ ok: w.droppedReceipts.every((d) => w.propHolder('prop1') !== null), text: `已丢弃迟到回执 ${w.droppedReceipts.length} 份（幂等）` });
    if (missingKeys.length) checks.push({ info: true, text: `缺键访问被拦截 ${missingKeys.length} 次（判失败，未静默放行）` });
    if (runner.done) checks.push({ ok: runner.tree.status === 'success', text: `演出树终态：${runner.tree.status}` });

    const kv = `
      <div class="kv">
        <span class="item"><span class="k">当前持有人</span><span class="v">${holder}</span></span>
        <span class="item"><span class="k">A 位置</span><span class="v">(${w.actor('A').pos.x.toFixed(2)}, ${w.actor('A').pos.z.toFixed(2)})</span></span>
        <span class="item"><span class="k">B 位置</span><span class="v">(${w.actor('B').pos.x.toFixed(2)}, ${w.actor('B').pos.z.toFixed(2)})</span></span>
        <span class="item"><span class="k">道具位置</span><span class="v">(${w.prop('prop1').pos.x.toFixed(2)}, ${w.prop('prop1').pos.z.toFixed(2)})</span></span>
        <span class="item"><span class="k">树状态</span><span class="v">${runner.tree.status}${runner.tree.suspended ? '(暂挂)' : ''}</span></span>
      </div>`;
    const checkHtml = checks.map((c) =>
      `<div class="check ${c.info ? 'info' : c.ok ? 'ok' : 'bad'}">${c.info ? 'ℹ' : c.ok ? '✓' : '✗'} ${c.text}</div>`).join('');
    const dlg = w.dialogue.map((d) =>
      `<div><span class="t" style="color:#566072">#${d.tick}</span> <span class="who">${d.actor}</span>：「${d.text}」</div>`).join('');
    this.container.innerHTML = kv + checkHtml + `<div class="dialogue"><b style="color:#8fb8ff">台词记录</b>${dlg || '<div style="color:#566072">（暂无）</div>'}</div>`;
  }
}
