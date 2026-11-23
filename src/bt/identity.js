// 稳定节点身份与动作契约。
//
// 热换版绝不按节点序号（Node.id）或数组下标继承运行状态：
//   - key：使用者声明的稳定身份，出现在两个版本中即视为「同一节点」。
//   - contract：节点语义指纹（类型 + 全部影响行为的参数，不含展示名）。
// 同一个 key 但 contract 不同 -> 动作含义已变，必须退出旧状态后重新进入，
// 否则会拿旧动作的进度去续演新动作（例如把「递交」改成「收回」）。

const SEMANTIC_PARAMS = [
  'actor', 'target', 'prop', 'giver', 'receiver', 'passDuration', 'confirmDelay',
  'confirmLine', 'clip', 'duration', 'text', 'bbKey', 'value', 'scope',
  'scopeName', 'maxAttempts', 'abortModeKey', 'amount',
];

function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
}

// 叶子节点：类型 + 语义参数。组合/装饰节点：类型 + 自身选项；
// 子节点另行按 key 递归匹配，不把整棵子树塞进指纹。
export function contractOf(node) {
  const type = node.constructor.name;
  const parts = { type };
  if (node.params && typeof node.params === 'object') {
    const picked = {};
    for (const k of SEMANTIC_PARAMS) {
      if (node.params[k] !== undefined) picked[k] = node.params[k];
    }
    parts.params = picked;
  }
  if (node.scopeName !== undefined) parts.scopeName = node.scopeName;
  if (node.maxAttempts !== undefined) parts.maxAttempts = node.maxAttempts;
  if (node.abortModeKey !== undefined && type === 'ReactiveSelector') {
    parts.abortModeKey = node.abortModeKey;
  }
  return canon(parts);
}

export function contractLabel(node) {
  const type = node.constructor.name;
  if (node.params && typeof node.params === 'object') {
    const picked = {};
    for (const k of SEMANTIC_PARAMS) {
      if (node.params[k] !== undefined) picked[k] = node.params[k];
    }
    return `${type} ${canon(picked)}`;
  }
  return type;
}

// 供台词去重：同一 key + 同一契约 = 同一句已发台词。
export function lineSignature(node) {
  if (!node.key) return null;
  return `${node.key}::${contractOf(node)}`;
}

export function collectNodes(node, out = []) {
  out.push(node);
  if (node.guard) collectNodes(node.guard, out);
  if (node.children) for (const c of node.children) collectNodes(c, out);
  if (node.child) collectNodes(node.child, out);
  if (node.body) collectNodes(node.body, out);
  return out;
}

export function nodesByKey(root) {
  const map = new Map();
  for (const n of collectNodes(root)) {
    if (n.key) {
      if (!map.has(n.key)) map.set(n.key, n);
    }
  }
  return map;
}
