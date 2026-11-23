// 三维舞台：把世界模拟的真实状态渲染出来（位置、朝向、道具、动画）。

import * as THREE from 'three';

function makeLabel(text, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 40px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.2, 0.6, 1);
  return sp;
}

export class Stage3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10131a);
    this.scene.fog = new THREE.Fog(0x10131a, 22, 40);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.azimuth = 0.55;
    this.elevation = 0.85;
    this.radius = 16;
    this._updateCamera();

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(6, 12, 4);
    this.scene.add(dir);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 12),
      new THREE.MeshStandardMaterial({ color: 0x1d2430, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(18, 18, 0x33405a, 0x232c3d);
    grid.position.y = 0.01;
    this.scene.add(grid);

    // 侧台出口标记
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 32),
      new THREE.MeshBasicMaterial({ color: 0xd05a5a, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(-7, 0.02, -4);
    this.scene.add(ring);

    // 通道封锁墙（默认隐藏）
    this.barrier = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 1.6, 12),
      new THREE.MeshStandardMaterial({ color: 0xd05a5a, transparent: true, opacity: 0.55 }),
    );
    this.barrier.position.set(-1, 0.8, 0);
    this.barrier.visible = false;
    this.scene.add(this.barrier);

    this.actorMeshes = new Map();
    this.propMeshes = new Map();
    this._drag = null;
    this._bindInput();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  ensureActor(id, color) {
    if (this.actorMeshes.has(id)) return;
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.34, 0.8, 6, 14),
      new THREE.MeshStandardMaterial({ color }),
    );
    body.position.y = 0.75;
    group.add(body);
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.4, 12),
      new THREE.MeshStandardMaterial({ color: 0xf5f0dc }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.75, 0.5);
    group.add(nose);
    const label = makeLabel(id, id === 'A' ? '#8fb8ff' : '#ffc9a1');
    label.position.y = 1.75;
    group.add(label);
    this.scene.add(group);
    this.actorMeshes.set(id, { group, body, label });
  }

  ensureProp(id) {
    if (this.propMeshes.has(id)) return;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xe8c547, emissive: 0x6b5410, roughness: 0.35 }),
    );
    this.scene.add(mesh);
    this.propMeshes.set(id, mesh);
  }

  syncFromWorld(world) {
    for (const [id, a] of world.actors) {
      this.ensureActor(id, a.color);
      const m = this.actorMeshes.get(id);
      m.group.position.set(a.pos.x, 0, a.pos.z);
      m.group.rotation.y = a.yaw;
      // 鞠躬动画：动画激活时前倾
      m.group.rotation.x = a.anim === 'bow' ? 0.55 : 0;
    }
    for (const [id, p] of world.props) {
      this.ensureProp(id);
      const m = this.propMeshes.get(id);
      m.position.set(p.pos.x, p.state === 'inTransit' ? 0.9 : 0.55, p.pos.z);
    }
    this.barrier.visible = world.pathBlocked;
  }

  // 世界坐标 -> 屏幕坐标（供气泡定位）
  projectToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * rect.width,
      y: (-v.y * 0.5 + 0.5) * rect.height,
      behind: v.z > 1,
    };
  }

  _updateCamera() {
    const r = this.radius;
    const y = Math.sin(this.elevation) * r;
    const h = Math.cos(this.elevation) * r;
    this.camera.position.set(Math.sin(this.azimuth) * h, y, Math.cos(this.azimuth) * h);
    this.camera.lookAt(0, 0.4, 0);
  }

  _bindInput() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this._drag = { x: e.clientX, az: this.azimuth }; });
    window.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      this.azimuth = this._drag.az - (e.clientX - this._drag.x) * 0.008;
      this._updateCamera();
    });
    window.addEventListener('pointerup', () => { this._drag = null; });
  }

  _resize() {
    const w = this.container.clientWidth || 640;
    const h = this.container.clientHeight || 360;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
