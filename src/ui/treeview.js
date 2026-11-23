// 行为树实时视图：递归渲染节点，着色显示 idle/running/success/failure/suspended，
// 并展示进入/退出次数（验证「持续多步不重复启动」）。

const TYPE_NAMES = {
  Sequence: '顺序', Selector: '选择', Parallel: '并行', ReactiveSelector: '反应选择',
  GuardedBranch: '守卫分支', Inverter: '取反', Scope: '作用域', RetryUntilSuccess: '重试',
  MoveTo: '移动', FaceTarget: '面向', PlayAnim: '动画', HandOver: '递交', SpeakLine: '台词',
  SetBlackboard: '写黑板', Wait: '等待', Fail: '恒失败', BlackboardEquals: '条件:黑板',
  PropHeldBy: '条件:持道具', Always: '条件:恒真', AsyncOpAction: '异步动作',
};

export class TreeView {
  constructor(container) {
    this.container = container;
    this.nodeRows = new Map(); // node -> row element
  }

  build(root) {
    this.nodeRows.clear();
    this.container.innerHTML = '';
    this.container.appendChild(this._renderNode(root, 0));
  }

  _renderNode(node, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'tnode';
    const row = document.createElement('div');
    row.className = 'row idle';
    const badge = document.createElement('span');
    badge.className = 'badge idle';
    badge.textContent = 'idle';
    const type = document.createElement('span');
    type.className = 'ntype';
    type.textContent = TYPE_NAMES[node.constructor.name] || node.constructor.name;
    const name = document.createElement('span');
    name.textContent = node.name;
    const count = document.createElement('span');
    count.className = 'ncount';
    const keyTag = node.key ? `[${node.key}] ` : '';
    row.append(badge, type, name, count);
    row.title = `#${node.id} ${node.name}${node.key ? ` · key=${node.key}` : ''}`;
    wrap.appendChild(row);
    this.nodeRows.set(node, { row, badge, count });

    const kids = [];
    if (node.guard) kids.push(node.guard);
    if (node.children) kids.push(...node.children);
    if (node.child) kids.push(node.child);
    if (node.body) kids.push(node.body);
    for (const k of kids) wrap.appendChild(this._renderNode(k, depth + 1));
    return wrap;
  }

  update() {
    for (const [node, els] of this.nodeRows) {
      const st = node.suspended ? 'suspended' : node.status;
      els.row.className = `row ${st}${node.migrated ? ' migrated' : ''}`;
      els.badge.className = `badge ${st}`;
      els.badge.textContent = st;
      const keyTag = node.key ? `[${node.key}] ` : '';
      els.count.textContent = `${keyTag}入${node.enterCount} 出${node.exitCount}`;
    }
  }
}
