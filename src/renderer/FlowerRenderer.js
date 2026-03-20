import * as THREE from 'three';
import { TILE_SIZE, TileType } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

// ~35% of eligible tiles get flowers
const FLOWER_CHANCE  = 0.35;
const PER_TILE       = 3;

// Petal colours — pinks, whites, lavender, pale yellow
const PETAL_COLORS = [
  0xffb7c5, // cherry blossom pink
  0xffffff, // white
  0xf8d7e3, // blush
  0xe8c5f5, // lavender
  0xffeaa0, // cream yellow
  0xff8fb1, // deep pink
  0xd4b8e0, // violet-soft
  0xfff0c0, // pale butter
];
const CENTER_COLOR = 0xffd633;
const STEM_COLOR   = 0x5a9a3c;

function rng(x, z, off = 0) {
  return Math.sin(x * 127.1 + z * 311.7 + off * 74.5) * 0.5 + 0.5;
}

export class FlowerRenderer {
  constructor(scene, world) {
    this.scene   = scene;
    this.world   = world;
    this._geoms  = [];
    this._mats   = [];
    this._animTime = 0;
    this._opacity  = 0;  // starts invisible; first update sets correct value
    this._build();
  }

  _build() {
    const tiles = [];
    for (let z = 0; z < this.world.height; z++) {
      for (let x = 0; x < this.world.width; x++) {
        const tile = this.world.tiles[z][x];
        if (tile.type === TileType.GRASS && rng(x, z, 500) < FLOWER_CHANCE) tiles.push(tile);
      }
    }
    if (tiles.length === 0) return;

    const total = tiles.length * PER_TILE;

    // ── Geometries ────────────────────────────────────────────────────────
    const stemGeom   = new THREE.CylinderGeometry(0.005, 0.008, 0.082, 4);
    const petalGeom  = new THREE.CircleGeometry(0.052, 8);
    const centerGeom = new THREE.SphereGeometry(0.017, 5, 3);
    this._geoms.push(stemGeom, petalGeom, centerGeom);

    // ── Materials — transparent so we can fade with opacity ───────────────
    const stemMat = new THREE.MeshLambertMaterial({
      color: STEM_COLOR,
      transparent: true, opacity: 1,
    });
    const petalMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true, opacity: 1,
      vertexColors: false,
    });
    const centerMat = new THREE.MeshLambertMaterial({
      color: CENTER_COLOR,
      transparent: true, opacity: 1,
    });
    this._mats.push(stemMat, petalMat, centerMat);
    this._stemMat   = stemMat;
    this._petalMat  = petalMat;
    this._centerMat = centerMat;

    // ── Instanced meshes ──────────────────────────────────────────────────
    const stemMesh   = new THREE.InstancedMesh(stemGeom,   stemMat,   total);
    const petalMesh  = new THREE.InstancedMesh(petalGeom,  petalMat,  total);
    const centerMesh = new THREE.InstancedMesh(centerGeom, centerMat, total);
    stemMesh.castShadow   = false;
    petalMesh.castShadow  = false;
    centerMesh.castShadow = false;

    const dummy = new THREE.Object3D();
    const col   = new THREE.Color();

    const bases = [];  // {bx, bz, tileY, scale, rotY}

    let fi = 0;
    for (const tile of tiles) {
      const tileY = TerrainRenderer.surfaceY(tile.type);
      for (let k = 0; k < PER_TILE; k++) {
        const ox    = (rng(tile.x, tile.z, 501 + k * 3) - 0.5) * 1.3;
        const oz    = (rng(tile.x, tile.z, 502 + k * 3) - 0.5) * 1.3;
        const bx    = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
        const bz    = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
        const scale = 0.65 + rng(tile.x, tile.z, 503 + k) * 0.55;
        const rotY  = rng(tile.x, tile.z, 504 + k) * Math.PI * 2;

        // Stem
        dummy.position.set(bx, tileY + 0.041 * scale, bz);
        dummy.scale.setScalar(scale);
        dummy.rotation.set(0, rotY, 0);
        dummy.updateMatrix();
        stemMesh.setMatrixAt(fi, dummy.matrix);

        // Petal disc — tilted ~80° so it faces upward
        dummy.position.set(bx, tileY + 0.083 * scale, bz);
        dummy.scale.set(scale, scale, scale);
        dummy.rotation.set(-Math.PI * 0.5 + 0.10, rotY, 0);
        dummy.updateMatrix();
        petalMesh.setMatrixAt(fi, dummy.matrix);

        // Center dot
        dummy.position.set(bx, tileY + 0.085 * scale, bz);
        dummy.scale.setScalar(scale * 0.9);
        dummy.rotation.set(0, rotY, 0);
        dummy.updateMatrix();
        centerMesh.setMatrixAt(fi, dummy.matrix);

        // Per-instance petal colour
        const ci = Math.floor(rng(tile.x + k, tile.z, 505) * PETAL_COLORS.length);
        col.setHex(PETAL_COLORS[ci % PETAL_COLORS.length]);
        petalMesh.setColorAt(fi, col);

        bases.push({ bx, bz, tileY, scale, rotY });
        fi++;
      }
    }

    stemMesh.instanceMatrix.needsUpdate   = true;
    petalMesh.instanceMatrix.needsUpdate  = true;
    centerMesh.instanceMatrix.needsUpdate = true;
    if (petalMesh.instanceColor) petalMesh.instanceColor.needsUpdate = true;

    // Start hidden — update() will fade in when season is right
    stemMesh.visible   = false;
    petalMesh.visible  = false;
    centerMesh.visible = false;

    this.scene.add(stemMesh, petalMesh, centerMesh);
    this._stemMesh   = stemMesh;
    this._petalMesh  = petalMesh;
    this._centerMesh = centerMesh;
    this._bases      = bases;
  }

  /**
   * Call every frame.
   * @param {number} delta   game-time seconds
   * @param {string} season  'Spring' | 'Summer' | 'Autumn' | 'Winter'
   */
  update(delta, season) {
    if (!this._stemMesh) return;

    this._animTime += delta;

    // Target opacity: full in Spring, half in Summer, gone otherwise
    const target =
      season === 'Spring' ? 1.0 :
      season === 'Summer' ? 0.45 : 0.0;

    // Smooth fade
    const lerpRate = delta * 0.6;
    this._opacity += (target - this._opacity) * Math.min(1, lerpRate);
    const op = Math.max(0, Math.min(1, this._opacity));

    this._stemMat.opacity   = op;
    this._petalMat.opacity  = op;
    this._centerMat.opacity = op;

    const visible = op > 0.01;
    this._stemMesh.visible   = visible;
    this._petalMesh.visible  = visible;
    this._centerMesh.visible = visible;

    if (!visible) return;

    // Gentle sway — update every frame only while visible
    const dummy = new THREE.Object3D();
    const t = this._animTime;

    for (let i = 0; i < this._bases.length; i++) {
      const { bx, bz, tileY, scale, rotY } = this._bases[i];

      // Each flower has a unique phase via the golden-ratio spacing trick
      const phase  = i * 2.399 + t * 0.85;
      const swayX  = Math.sin(phase)        * 0.055;
      const swayZ  = Math.cos(phase * 0.73) * 0.045;
      // Bloom scale: spring flowers gently pulse; factor in opacity for emergence
      const bloom  = op * (0.92 + Math.sin(phase * 0.4) * 0.08);

      // Stem
      dummy.position.set(bx, tileY + 0.041 * scale, bz);
      dummy.scale.setScalar(scale * bloom);
      dummy.rotation.set(swayX * 0.7, rotY, swayZ * 0.7);
      dummy.updateMatrix();
      this._stemMesh.setMatrixAt(i, dummy.matrix);

      // Petal disc
      dummy.position.set(bx, tileY + 0.083 * scale * bloom, bz);
      dummy.scale.set(scale * bloom, scale * bloom, scale * bloom);
      dummy.rotation.set(-Math.PI * 0.5 + 0.10 + swayX, rotY, swayZ);
      dummy.updateMatrix();
      this._petalMesh.setMatrixAt(i, dummy.matrix);

      // Center
      dummy.position.set(bx, tileY + 0.085 * scale * bloom, bz);
      dummy.scale.setScalar(scale * 0.9 * bloom);
      dummy.rotation.set(swayX, rotY, swayZ);
      dummy.updateMatrix();
      this._centerMesh.setMatrixAt(i, dummy.matrix);
    }

    this._stemMesh.instanceMatrix.needsUpdate   = true;
    this._petalMesh.instanceMatrix.needsUpdate  = true;
    this._centerMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this._stemMesh)   this.scene.remove(this._stemMesh);
    if (this._petalMesh)  this.scene.remove(this._petalMesh);
    if (this._centerMesh) this.scene.remove(this._centerMesh);
    for (const g of this._geoms) g.dispose();
    for (const m of this._mats)  m.dispose();
    this._geoms = [];
    this._mats  = [];
  }
}
