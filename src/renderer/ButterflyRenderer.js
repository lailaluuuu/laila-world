import * as THREE from 'three';
import { TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const COUNT = 6;

/** Bright wing colours: turquoise, gold, coral, lime, magenta, orange */
const WING_COLORS = [
  0x00e5e0, // turquoise
  0xffcc00, // gold
  0xff5588, // coral pink
  0x7fff00, // chartreuse
  0xff44ee, // magenta
  0xff8800, // orange
];

const BODY_COLOR = 0x2a2018;

export class ButterflyRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.entries = [];
    this._geoms = [];
    this._mats = [];
    this._group = new THREE.Group();
    this.scene.add(this._group);

    const spawns = world.getWildHorseSpawnPoints(COUNT);
    while (spawns.length < COUNT) {
      spawns.push({
        x: 8 + Math.random() * 16,
        z: 8 + Math.random() * 16,
      });
    }

    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.quadraticCurveTo(0.22, 0.18, 0.38, 0.02);
    wingShape.quadraticCurveTo(0.32, -0.12, 0.1, -0.08);
    wingShape.lineTo(0, 0);
    const wingGeom = new THREE.ShapeGeometry(wingShape);
    this._geoms.push(wingGeom);

    for (let i = 0; i < COUNT; i++) {
      const p = spawns[i];
      const wx = p.x * TILE_SIZE;
      const wz = p.z * TILE_SIZE;
      const tx = Math.floor(p.x);
      const tz = Math.floor(p.z);
      const tile = world.getTile(tx, tz);
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;

      const wingColor = WING_COLORS[i % WING_COLORS.length];
      const wingMat = new THREE.MeshBasicMaterial({
        color: wingColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      });
      const wingMat2 = wingMat.clone();
      wingMat2.color.setHex(wingColor);
      // Slightly different shade on hind wing
      wingMat2.color.offsetHSL(0, 0.08, -0.06);
      this._mats.push(wingMat, wingMat2);

      const bodyGeom = new THREE.CylinderGeometry(0.018, 0.022, 0.14, 6);
      this._geoms.push(bodyGeom);
      const bodyMat = new THREE.MeshBasicMaterial({ color: BODY_COLOR });
      this._mats.push(bodyMat);

      const root = new THREE.Group();
      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.rotation.z = Math.PI / 2;
      root.add(body);

      const wingL = new THREE.Mesh(wingGeom, wingMat);
      wingL.position.set(0, 0, 0.01);
      wingL.rotation.x = -Math.PI / 2;
      wingL.rotation.z = Math.PI / 2;
      const wingR = wingL.clone();
      wingR.material = wingMat2;
      wingR.scale.x = -1;

      const wings = new THREE.Group();
      wings.add(wingL);
      wings.add(wingR);
      root.add(wings);

      root.position.set(
        wx,
        surfY + 1.2 + Math.random() * 1.8,
        wz,
      );
      root.scale.setScalar(0.85 + Math.random() * 0.35);
      this._group.add(root);

      this.entries.push({
        root,
        wings,
        wx,
        wz,
        vy: 0.15 + Math.random() * 0.12,
        phase: Math.random() * Math.PI * 2,
        flapSpeed: 10 + Math.random() * 6,
        wanderPhase: Math.random() * Math.PI * 2,
        targetWx: wx + (Math.random() - 0.5) * 14,
        targetWz: wz + (Math.random() - 0.5) * 14,
        retargetIn: 2 + Math.random() * 4,
        heightOffset: 1.1 + Math.random() * 1.4,
      });
    }
  }

  _groundY(wx, wz) {
    const tx = Math.floor(wx / TILE_SIZE);
    const tz = Math.floor(wz / TILE_SIZE);
    const tile = this.world.getTile(tx, tz);
    return tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;
  }

  update(delta, sunny) {
    const worldW = this.world.width * TILE_SIZE;
    const worldD = this.world.height * TILE_SIZE;
    const margin = 3;

    for (const e of this.entries) {
      e.root.visible = sunny;
      if (!sunny) continue;

      e.phase += delta * e.flapSpeed;
      e.wanderPhase += delta * 0.7;
      e.retargetIn -= delta;

      const flap = Math.sin(e.phase);
      e.wings.rotation.y = flap * 0.85;
      e.wings.scale.y = 0.88 + Math.abs(flap) * 0.2;

      if (e.retargetIn <= 0) {
        e.retargetIn = 3 + Math.random() * 6;
        e.targetWx =
          margin + Math.random() * (worldW - margin * 2);
        e.targetWz =
          margin + Math.random() * (worldD - margin * 2);
      }

      const dx = e.targetWx - e.wx;
      const dz = e.targetWz - e.wz;
      const len = Math.hypot(dx, dz) || 1;
      const speed = 1.35 + Math.sin(e.wanderPhase) * 0.25;
      e.wx += (dx / len) * speed * delta;
      e.wz += (dz / len) * speed * delta;

      const ground = this._groundY(e.wx, e.wz);
      const wantY = ground + e.heightOffset + Math.sin(e.wanderPhase * 1.3) * 0.35;
      const y = e.root.position.y;
      e.root.position.y = y + (wantY - y) * Math.min(1, delta * 2.2);

      e.root.position.x = e.wx;
      e.root.position.z = e.wz;
      e.root.rotation.y = Math.atan2(dx, dz);
    }
  }

  dispose() {
    this.scene.remove(this._group);
    for (const g of this._geoms) g.dispose();
    this._geoms = [];
    for (const m of this._mats) m.dispose();
    this._mats = [];
    this.entries = [];
  }
}
