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

  switch (type) {
    case 'sequence': return new Sequence(name, kids());
    case 'selector': return new Selector(name, kids());
    case 'parallel': return new Parallel(name, kids());
    case 'reactiveSelector':
      return new ReactiveSelector(name, kids(), def.abortModeKey || 'interrupt.mode');
    case 'guarded': {
      if (!def.guard) throw new Error(`guarded 节点缺少 guard: ${name}`);
      if (!def.body) throw new Error(`guarded 节点缺少 body: ${name}`);
      return new GuardedBranch(name, buildTree(def.guard), buildTree(def.body));
    }
    case 'inverter': return new Inverter(name, buildTree(def.child));
    case 'scope': return new Scope(name, buildTree(def.child), def.scopeName);
    case 'retry': return new RetryUntilSuccess(name, buildTree(def.child), def.maxAttempts ?? 3);

    case 'moveTo': return new MoveTo(name, def);
    case 'faceTarget': return new FaceTarget(name, def);
    case 'playAnim': return new PlayAnim(name, def);
    case 'handOver': return new HandOver(name, def);
    case 'speakLine': return new SpeakLine(name, def);
    case 'setBlackboard': return new SetBlackboard(name, def);
    case 'wait': return new Wait(name, def);
    case 'fail': return new Fail(name, def);
    case 'bbEquals': return new BlackboardEquals(name, def);
    case 'propHeldBy': return new PropHeldBy(name, def);
    case 'always': return new Always(name, def);
    default:
      throw new Error(`未知节点类型: ${type}`);
  }
}
