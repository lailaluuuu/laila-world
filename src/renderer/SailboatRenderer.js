// Sailboat rendering module
/**
 * SailboatRenderer — Monument Valley-style wooden sailboats.
 *
 * Anatomy (all in world units, TILE_SIZE = 2):
 *   Hull   — scaled half-sphere ellipsoid, warm amber/wood
 *   Gunwale — thin torus ring at deck edge, slightly darker
 *   Mast   — tall thin cylinder, near-black
 *   Sail   — tall triangle BufferGeometry, off-white, double-sided
 *   Figure — tiny crow-person silhouette on deck, red accent
 *   Wake   — two fanning triangles behind the stern, pale teal
 */
import * as THREE from 'three';
import { TILE_SIZE, TileType } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const HULL_COLOR    = 0xc07828;   // warm amber wood
const GUNWALE_COLOR = 0x7a4a10;   // darker wood trim
const MAST_COLOR    = 0x1a0e04;   // near-black
const SAIL_COLOR    = 0xeef4ff;   // off-white / very pale blue
const FIGURE_COLOR  = 0x0e0e1a;   // same near-black as crow body
const FIGURE_ACC    = 0xcc2222;   // red accent (hat / flag)
const WAKE_COLOR    = 0x7ab8d8;   // pale teal wake foam

export class SailboatRenderer {
  constructor(scene, boats) {
    this.scene   = scene;
    this.boats   = boats;
    this.entries = [];
    this._geoms  = [];
    this._mats   = [];
    this._initShared();
    for (const b of this.boats) this._buildEntry(b);
  }

  // ── Shared geometry / material ─────────────────────────────────────────
  _initShared() {
    // Materials
    const mk = (color, opts = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...opts });
      this._mats.push(m);
      return m;
    };
    this._hullMat    = mk(HULL_COLOR);
    this._gunwaleMat = mk(GUNWALE_COLOR);
    this._mastMat    = mk(MAST_COLOR);
    this._sailMat    = mk(SAIL_COLOR, { side: THREE.DoubleSide, roughness: 0.4, flatShading: false });
    this._figMat     = mk(FIGURE_COLOR);
    this._figAccMat  = mk(FIGURE_ACC);
    this._wakeMat    = mk(WAKE_COLOR, { transparent: true, opacity: 0.55, side: THREE.DoubleSide });

    // Hull: SphereGeometry scaled into a flat boat-hull ellipsoid
    this._hullGeom = new THREE.SphereGeometry(1, 10, 6);

    // Gunwale: thin torus at deck level, scaled to match hull
    this._gunwaleGeom = new THREE.TorusGeometry(1, 0.035, 4, 12);

    // Mast: slim cylinder
    this._mastGeom = new THREE.CylinderGeometry(0.030, 0.036, 1.55, 6);

    // Sail: tall triangle — forward-swept like a lateen
    //   Apex: top of mast
    //   Tack: base of mast
    //   Clew: low point at stern
    {
      const geo = new THREE.BufferGeometry();
      const v = new Float32Array([
         0,    1.52,  0.00,   // apex (top of mast)
         0,    0.00,  0.00,   // tack (mast base)
         0,    0.18, -0.76,   // clew (stern, slightly elevated)
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
      geo.setIndex([0, 2, 1,  0, 1, 2]);   // double-face winding
      geo.computeVertexNormals();
      this._sailGeom = geo;
      this._geoms.push(geo);
    }

    // Tiny figure: sphere head + cone body
    this._figHeadGeom = new THREE.SphereGeometry(0.055, 6, 4);
    this._figBodyGeom = new THREE.ConeGeometry(0.058, 0.14, 6);
    this._figHatGeom  = new THREE.ConeGeometry(0.042, 0.065, 5);

    // Wake: two narrow triangles fanning behind the stern
    {
      const geo = new THREE.BufferGeometry();
      const v = new Float32Array([
        // left fan
         0,    0,  0,
        -0.18, 0,  0.55,
        -0.06, 0,  0.48,
        // right fan
         0,    0,  0,
         0.06, 0,  0.48,
         0.18, 0,  0.55,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
      geo.setIndex([0, 1, 2,  3, 4, 5]);
      geo.computeVertexNormals();
      this._wakeGeom = geo;
      this._geoms.push(geo);
    }

    this._geoms.push(
      this._hullGeom, this._gunwaleGeom, this._mastGeom,
      this._figHeadGeom, this._figBodyGeom, this._figHatGeom,
    );
  }

  // ── Per-boat mesh group ────────────────────────────────────────────────
  _buildEntry(boat) {
    const root = new THREE.Group();

    // Hull ellipsoid (x=width, y=height, z=length)
    const hull = new THREE.Mesh(this._hullGeom, this._hullMat);
    hull.scale.set(0.28, 0.11, 0.52);
    hull.castShadow = true;
    root.add(hull);

    // Gunwale ring (outline at deck)
    const gunwale = new THREE.Mesh(this._gunwaleGeom, this._gunwaleMat);
    gunwale.scale.set(0.28, 0.52, 1);       // match hull XZ footprint, flat on deck
    gunwale.rotation.x = Math.PI / 2;
    gunwale.position.y = 0.11;              // at top of hull
    root.add(gunwale);

    // Mast group — placed slightly forward of centre
    const mastGroup = new THREE.Group();
    mastGroup.position.set(0, 0.11, -0.10);  // on deck, forward of centre
    const mast = new THREE.Mesh(this._mastGeom, this._mastMat);
    mast.position.y = 1.55 / 2;             // centre of cylinder sits at midheight
    mast.castShadow = true;
    mastGroup.add(mast);

    // Sail attached to mast group
    const sail = new THREE.Mesh(this._sailGeom, this._sailMat);
    sail.castShadow = false;
    mastGroup.add(sail);

    root.add(mastGroup);

    // Figure on deck (slightly aft of mast)
    const figGroup = new THREE.Group();
    figGroup.position.set(0, 0.11, 0.08);

    const figBody = new THREE.Mesh(this._figBodyGeom, this._figMat);
    figBody.position.y = 0.07;
    figGroup.add(figBody);

    const figHead = new THREE.Mesh(this._figHeadGeom, this._figMat);
    figHead.position.y = 0.19;
    figGroup.add(figHead);

    const figHat  = new THREE.Mesh(this._figHatGeom, this._figAccMat);
    figHat.position.y = 0.265;
    figGroup.add(figHat);

    root.add(figGroup);

    // Wake (behind stern, flat on water)
    const wake = new THREE.Mesh(this._wakeGeom, this._wakeMat);
    wake.position.set(0, 0.02, 0.52);       // just behind stern
    root.add(wake);

    this.scene.add(root);
    this.entries.push({ root, boat, mastGroup, figGroup, wake });
  }

  addBoat(boat) {
    this.boats.push(boat);
    this._buildEntry(boat);
    if (globalThis.localStorage?.getItem('debugWorldLogs') === '1') {
      console.debug('[DebugWorld] sailboat:add', { total: this.boats.length, x: boat.x, z: boat.z });
    }
  }

  // ── Per-frame update ───────────────────────────────────────────────────
  update() {
    for (const { root, boat, mastGroup, figGroup, wake } of this.entries) {
      // World position — boats float at water surface height
      const wx = boat.x * TILE_SIZE;
      const wz = boat.z * TILE_SIZE;
      const surfY = TerrainRenderer.surfaceY(TileType.WATER);

      // Gentle bob: vertical + slight roll
      const bob  = Math.sin(boat.bobPhase) * 0.018;
      const roll = Math.sin(boat.bobPhase * 0.7) * 0.04;

      root.position.set(wx, surfY + 0.02 + bob, wz);

      // Face the direction of travel
      const angle = Math.atan2(boat.facingX, boat.facingZ);
      root.rotation.y = angle;
      root.rotation.z = roll;

      // Sail sway: gentle lean into the (fake) wind
      mastGroup.rotation.z = Math.sin(boat.sailPhase) * 0.05 - 0.06;

      // Figure gently turns head (just rotate figGroup slightly)
      figGroup.rotation.y = Math.sin(boat.sailPhase * 0.6) * 0.3;

      // Wake stretches when moving fast, fades in lighter conditions
      const speed = boat.speed;
      wake.scale.set(1, 1, 0.8 + speed * 1.5);
      wake.material.opacity = 0.3 + speed * 0.7;
    }
  }

  dispose() {
    for (const { root } of this.entries) this.scene.remove(root);
    this.entries = [];
    for (const g of this._geoms) g.dispose();
    this._geoms = [];
    for (const m of this._mats) m.dispose();
    this._mats = [];
  }
}
