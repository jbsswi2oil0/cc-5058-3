// 从 JSON 定义构建行为树。界面编辑器与测试共用同一构建器。

import {
  Sequence, Selector, Parallel, ReactiveSelector, GuardedBranch,
  Inverter, Scope, RetryUntilSuccess,
} from '../bt/nodes.js';
import {
  MoveTo, FaceTarget, PlayAnim, HandOver, SpeakLine, SetBlackboard,
  Wait, Fail, BlackboardEquals, PropHeldBy, Always,
} from '../world/actions.js';

export function buildTree(def) {
  if (!def || typeof def !== 'object') throw new Error('节点定义必须是对象');
  const { type } = def;
  if (!type) throw new Error(`节点缺少 type: ${JSON.stringify(def).slice(0, 80)}`);
  const name = def.name || type;
  const kids = () => (def.children || []).map(buildTree);

  let node;
  switch (type) {
    case 'sequence': node = new Sequence(name, kids()); break;
    case 'selector': node = new Selector(name, kids()); break;
    case 'parallel': node = new Parallel(name, kids()); break;
    case 'reactiveSelector':
      node = new ReactiveSelector(name, kids(), def.abortModeKey || 'interrupt.mode');
      break;
    case 'guarded': {
      if (!def.guard) throw new Error(`guarded 节点缺少 guard: ${name}`);
      if (!def.body) throw new Error(`guarded 节点缺少 body: ${name}`);
      node = new GuardedBranch(name, buildTree(def.guard), buildTree(def.body));
      break;
    }
    case 'inverter': node = new Inverter(name, buildTree(def.child)); break;
    case 'scope': node = new Scope(name, buildTree(def.child), def.scopeName); break;
    case 'retry':
      node = new RetryUntilSuccess(name, buildTree(def.child), def.maxAttempts ?? 3);
      break;

    case 'moveTo': node = new MoveTo(name, def); break;
    case 'faceTarget': node = new FaceTarget(name, def); break;
    case 'playAnim': node = new PlayAnim(name, def); break;
    case 'handOver': node = new HandOver(name, def); break;
    case 'speakLine': node = new SpeakLine(name, def); break;
    case 'setBlackboard': node = new SetBlackboard(name, def); break;
    case 'wait': node = new Wait(name, def); break;
    case 'fail': node = new Fail(name, def); break;
    case 'bbEquals': node = new BlackboardEquals(name, def); break;
    case 'propHeldBy': node = new PropHeldBy(name, def); break;
    case 'always': node = new Always(name, def); break;
    default:
      throw new Error(`未知节点类型: ${type}`);
  }

  // 稳定节点身份：热换版只按 key 匹配进度，绝不按节点序号/数组下标继承。
  if (def.key !== undefined) {
    if (typeof def.key !== 'string' || def.key.trim() === '') {
      throw new Error(`节点 key 必须是非空字符串: ${name}`);
    }
    node.key = def.key;
  }
  return node;
}
