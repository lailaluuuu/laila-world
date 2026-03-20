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

/**
 * Eased flap value from a raw phase angle.
 * Using exponent < 1 makes the curve linger near ±1 (wings fully open/closed)
 * and snap quickly through 0 (mid-stroke) — like a real butterfly stroke that
 * decelerates at the top and bottom of each beat.
 */
function easedFlap(phase) {
  const s = Math.sin(phase);
  return Math.sign(s) * Math.pow(Math.abs(s), 0.62);
}

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

    // ── Forewing shape: upper, larger, more pointed at tip ──────────────────
    const foreShape = new THREE.Shape();
    foreShape.moveTo(0, 0);
    foreShape.quadraticCurveTo(0.055, 0.096, 0.143, 0.071);
    foreShape.quadraticCurveTo(0.176, 0.013, 0.155, -0.021);
    foreShape.quadraticCurveTo(0.080, -0.038, 0.025, -0.017);
    foreShape.lineTo(0, 0);
    const foreGeom = new THREE.ShapeGeometry(foreShape);
    this._geoms.push(foreGeom);

    // ── Hindwing shape: lower, smaller, rounder ──────────────────────────────
    const hindShape = new THREE.Shape();
    hindShape.moveTo(0, -0.013);
    hindShape.quadraticCurveTo(0.042, 0.029, 0.105, 0.021);
    hindShape.quadraticCurveTo(0.130, -0.013, 0.097, -0.071);
    hindShape.quadraticCurveTo(0.042, -0.088, 0.013, -0.050);
    hindShape.lineTo(0, -0.013);
    const hindGeom = new THREE.ShapeGeometry(hindShape);
    this._geoms.push(hindGeom);

    for (let i = 0; i < COUNT; i++) {
      const p = spawns[i];
      const wx = p.x * TILE_SIZE;
      const wz = p.z * TILE_SIZE;
      const tx = Math.floor(p.x);
      const tz = Math.floor(p.z);
      const tile = world.getTile(tx, tz);
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;

      const wingColor = WING_COLORS[i % WING_COLORS.length];

      // Forewing materials (main colour)
      const foreMatL = new THREE.MeshBasicMaterial({
        color: wingColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      });
      const foreMatR = foreMatL.clone();
      this._mats.push(foreMatL, foreMatR);

      // Hindwing materials (slightly darker, less saturated — hind pair)
      const hindMatL = foreMatL.clone();
      hindMatL.color.offsetHSL(0, 0.08, -0.07);
      hindMatL.opacity = 0.84;
      const hindMatR = hindMatL.clone();
      this._mats.push(hindMatL, hindMatR);

      const bodyGeom = new THREE.CylinderGeometry(0.008, 0.010, 0.058, 6);
      this._geoms.push(bodyGeom);
      const bodyMat = new THREE.MeshBasicMaterial({ color: BODY_COLOR });
      this._mats.push(bodyMat);

      const root = new THREE.Group();
      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.rotation.z = Math.PI / 2;
      root.add(body);

      // ── Helper: build a mirrored left/right wing pair ──────────────────────
      const makeWingPair = (geom, matL, matR) => {
        const group = new THREE.Group();
        const wL = new THREE.Mesh(geom, matL);
        wL.position.set(0, 0, 0.01);
        wL.rotation.x = -Math.PI / 2;
        wL.rotation.z = Math.PI / 2;
        const wR = wL.clone();
        wR.material = matR;
        wR.scale.x = -1;
        group.add(wL, wR);
        return group;
      };

      // Hindwings render first (behind forewings) and attach slightly rearward
      const hindWings = makeWingPair(hindGeom, hindMatL, hindMatR);
      hindWings.position.x = -0.010;

      // Forewings attach slightly forward
      const foreWings = makeWingPair(foreGeom, foreMatL, foreMatR);
      foreWings.position.x = 0.008;

      root.add(hindWings);
      root.add(foreWings);

      // ── Depth / parallax: vary size so nearer butterflies appear larger ─────
      const sizeScale = 0.85 + Math.random() * 0.35; // 0.85 – 1.20
      root.position.set(wx, surfY + 1.2 + Math.random() * 1.8, wz);
      root.scale.setScalar(sizeScale);
      this._group.add(root);

      this.entries.push({
        root,
        body,
        foreWings,
        hindWings,
        wx,
        wz,
        phase:       Math.random() * Math.PI * 2,
        flapSpeed:   10 + Math.random() * 6,       // 10 – 16 rad/s (desync)
        wanderPhase: Math.random() * Math.PI * 2,
        targetWx:    wx + (Math.random() - 0.5) * 14,
        targetWz:    wz + (Math.random() - 0.5) * 14,
        retargetIn:  2 + Math.random() * 4,
        heightOffset: 1.1 + Math.random() * 1.4,
        sizeScale,
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

      e.phase       += delta * e.flapSpeed;
      e.wanderPhase += delta * 0.7;
      e.retargetIn  -= delta;

      // ── 1. Wing flapping with organic easing ────────────────────────────────
      // Forewings: full amplitude, eased
      const flapFore = easedFlap(e.phase);
      // Hindwings: lag ~0.31 rad behind forewings (~18° / a few milliseconds)
      const flapHind = easedFlap(e.phase - 0.31);

      e.foreWings.rotation.y = flapFore * 0.85;
      e.foreWings.scale.y    = 0.90 + Math.abs(flapFore) * 0.18;

      e.hindWings.rotation.y = flapHind * 0.70; // hindwings open slightly less
      e.hindWings.scale.y    = 0.90 + Math.abs(flapHind) * 0.15;

      // ── 2. Body tilt — rocks opposite to the wing stroke ────────────────────
      // flapFore near +1 (wings up): body tips one way; -1 (wings down): other
      e.body.rotation.z = Math.PI / 2 - flapFore * 0.10;

      // ── 3. Retarget waypoint ────────────────────────────────────────────────
      if (e.retargetIn <= 0) {
        e.retargetIn = 3 + Math.random() * 6;
        e.targetWx = margin + Math.random() * (worldW - margin * 2);
        e.targetWz = margin + Math.random() * (worldD - margin * 2);
      }

      const dx  = e.targetWx - e.wx;
      const dz  = e.targetWz - e.wz;
      const len = Math.hypot(dx, dz) || 1;

      // ── 4. Flight path — wandering curve ────────────────────────────────────
      // Depth parallax: larger (nearer) butterflies move proportionally faster
      const speed = (1.35 + Math.sin(e.wanderPhase) * 0.25) * e.sizeScale;

      // Advance along heading
      e.wx += (dx / len) * speed * delta;
      e.wz += (dz / len) * speed * delta;

      // Add perpendicular lateral drift for an organic meander
      const perpX = -dz / len;
      const perpZ =  dx / len;
      const drift = Math.sin(e.wanderPhase * 1.85) * 0.50 * delta;
      e.wx += perpX * drift;
      e.wz += perpZ * drift;

      // Keep inside world bounds
      e.wx = Math.max(margin, Math.min(worldW - margin, e.wx));
      e.wz = Math.max(margin, Math.min(worldD - margin, e.wz));

      // ── 5. Vertical bob: slow sinusoidal drift + small flap-linked pulse ────
      const ground = this._groundY(e.wx, e.wz);
      const flapBob = Math.abs(flapFore) * 0.07; // rises slightly on upstroke
      const wantY = ground + e.heightOffset
        + Math.sin(e.wanderPhase * 1.3) * 0.28
        + flapBob;
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
