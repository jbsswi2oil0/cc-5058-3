// 作用域 + 版本化黑板。
// - 每个黑板可有一个 parent，读取沿作用域链向上查找，写入默认落在声明层。
// - 每个键携带单调递增 version；黑板自身也有 version（任意写都会推进）。
// - 缺失键：require() 抛 MissingKeyError，条件节点据此判 FAILURE，
//   绝不允许把缺失值当作真值放行。

export class MissingKeyError extends Error {
  constructor(key) {
    super(`blackboard key missing: ${key}`);
    this.key = key;
  }
}

export class Blackboard {
  constructor(name = 'root', parent = null) {
    this.name = name;
    this.parent = parent;
    this.entries = new Map(); // key -> { value, version, updatedTick }
    this.version = 0;
  }

  createScope(name) {
    return new Blackboard(name, this);
  }

  // 键在哪一层声明（含祖先），找不到返回 null
  _ownerOf(key) {
    let bb = this;
    while (bb) {
      if (bb.entries.has(key)) return bb;
      bb = bb.parent;
    }
    return null;
  }

  has(key) {
    return this._ownerOf(key) !== null;
  }

  // 宽松读取：返回 undefined 表示缺失。仅供展示层使用。
  get(key) {
    const owner = this._ownerOf(key);
    return owner ? owner.entries.get(key).value : undefined;
  }

  // 严格读取：缺失即抛错。行为树条件/动作必须走这里。
  require(key) {
    const owner = this._ownerOf(key);
    if (!owner) throw new MissingKeyError(key);
    return owner.entries.get(key).value;
  }

  entryOf(key) {
    const owner = this._ownerOf(key);
    return owner ? owner.entries.get(key) : undefined;
  }

  versionOf(key) {
    const e = this.entryOf(key);
    return e ? e.version : -1; // -1 表示从未写过
  }

  // 写入：若键已在某祖先层声明过，则写到那一层（保持作用域归属），
  // 否则写到当前层。返回新条目。
  set(key, value, tick = 0) {
    const owner = this._ownerOf(key) || this;
    owner.version += 1;
    const entry = { value, version: owner.version, updatedTick: tick };
    owner.entries.set(key, entry);
    return entry;
  }

  // 强制写当前层（用于 Scope 内局部遮蔽）
  setLocal(key, value, tick = 0) {
    this.version += 1;
    const entry = { value, version: this.version, updatedTick: tick };
    this.entries.set(key, entry);
    return entry;
  }

  // 展示用：导出本层及继承链
  dump() {
    const layers = [];
    let bb = this;
    while (bb) {
      const entries = {};
      for (const [k, e] of bb.entries) {
        entries[k] = { value: e.value, version: e.version, updatedTick: e.updatedTick };
      }
      layers.push({ name: bb.name, version: bb.version, entries });
      bb = bb.parent;
    }
    return layers;
  }
}
