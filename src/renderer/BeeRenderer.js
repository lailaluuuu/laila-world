import * as THREE from 'three';
import { TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const SWARM_COUNT    = 3;  // number of hives / swarms
const BEES_PER_SWARM = 8;  // bees per swarm

const BEE_BODY_COLOR = 0xd4860a; // amber gold
const BEE_WING_COLOR = 0xddf4ff; // pale icy blue-white

export class BeeRenderer {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    this._group = new THREE.Group();
    this._geoms = [];
    this._mats  = [];
    this.swarms = [];
    scene.add(this._group);
    this._build();
  }

  _build() {
    const spawns = this.world.getWildHorseSpawnPoints(SWARM_COUNT);

    // Shared geometry — reused by all bees
    const bodyGeom = new THREE.SphereGeometry(0.038, 6, 4);
    this._geoms.push(bodyGeom);

    const wingGeom = new THREE.CircleGeometry(0.052, 5);
    this._geoms.push(wingGeom);

    const eyeGeom = new THREE.SphereGeometry(0.010, 4, 3);
    this._geoms.push(eyeGeom);

    const bodyMat = new THREE.MeshBasicMaterial({ color: BEE_BODY_COLOR });
    const wingMat = new THREE.MeshBasicMaterial({
      color: BEE_WING_COLOR,
      transparent: true,
      opacity: 0.48,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
    this._mats.push(bodyMat, wingMat, eyeMat);

    for (let s = 0; s < SWARM_COUNT; s++) {
      const p  = spawns[s] || { x: 16 + s * 24, z: 16 };
      const hx = p.x * TILE_SIZE;
      const hz = p.z * TILE_SIZE;
      const tile = this.world.getTile(Math.floor(p.x), Math.floor(p.z));
      const gy   = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;

      const bees = [];
      for (let b = 0; b < BEES_PER_SWARM; b++) {
        const root = new THREE.Group();

        const body = new THREE.Mesh(bodyGeom, bodyMat);
        body.scale.z = 1.45; // slightly elongated thorax
        root.add(body);

        // Left and right wings, hinged at the body centre
        const wL = new THREE.Mesh(wingGeom, wingMat);
        wL.position.set(-0.055, 0.012, 0);
        const wR = new THREE.Mesh(wingGeom, wingMat);
        wR.position.set( 0.055, 0.012, 0);
        wR.scale.x = -1; // mirror
        root.add(wL, wR);

        // Two tiny eyes at the front of the body (+Z is the bee's forward direction)
        const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
        const eyeR = new THREE.Mesh(eyeGeom, eyeMat);
        eyeL.position.set(-0.016, 0.013, 0.032);
        eyeR.position.set( 0.016, 0.013, 0.032);
        root.add(eyeL, eyeR);

        this._group.add(root);

        bees.push({
          root, wL, wR,
          orbitPhase:  Math.random() * Math.PI * 2,
          orbitSpeed:  0.55 + Math.random() * 1.0,   // rad / s around swarm centre
          orbitRadius: 0.30 + Math.random() * 0.55,  // world units
          orbitTilt:   (Math.random() - 0.5) * 0.70, // tilts the orbit plane
          bobPhase:    Math.random() * Math.PI * 2,
          bobSpeed:    0.65 + Math.random() * 0.90,
          bobAmp:      0.10 + Math.random() * 0.16,
          baseHeight:  0.50 + Math.random() * 0.55,
          wingPhase:   Math.random() * Math.PI * 2,
          wingSpeed:   22 + Math.random() * 12,      // fast buzz
        });
      }

      this.swarms.push({
        bees,
        hx, hz, gy,
        driftPhase: Math.random() * Math.PI * 2,
        cx: hx, cz: hz,
      });
    }

    // Expose hive positions in tile-space so the simulation can find them
    this.world.beeHives = this.swarms.map(sw => ({ x: sw.hx / TILE_SIZE, z: sw.hz / TILE_SIZE }));
  }

  update(delta, sunny) {
    for (const sw of this.swarms) {
      for (const bee of sw.bees) bee.root.visible = sunny;
      if (!sunny) continue;

      // Hive centre drifts gently around its anchor
      sw.driftPhase += delta * 0.16;
      sw.cx = sw.hx + Math.sin(sw.driftPhase)        * TILE_SIZE * 0.65;
      sw.cz = sw.hz + Math.cos(sw.driftPhase * 0.71) * TILE_SIZE * 0.65;

      for (const bee of sw.bees) {
        bee.orbitPhase += delta * bee.orbitSpeed;
        bee.bobPhase   += delta * bee.bobSpeed;
        bee.wingPhase  += delta * bee.wingSpeed;

        // Tilted circular orbit gives a 3-D swarm look
        const bx = sw.cx
          + Math.cos(bee.orbitPhase) * bee.orbitRadius;
        const by = sw.gy + bee.baseHeight
          + Math.sin(bee.orbitPhase) * bee.orbitRadius * Math.sin(bee.orbitTilt)
          + Math.sin(bee.bobPhase)   * bee.bobAmp;
        const bz = sw.cz
          + Math.sin(bee.orbitPhase) * bee.orbitRadius * Math.cos(bee.orbitTilt);

        bee.root.position.set(bx, by, bz);

        // Face the tangent of the orbit so the bee looks like it's flying forward
        const tx = -Math.sin(bee.orbitPhase);
        const tz =  Math.cos(bee.orbitPhase) * Math.cos(bee.orbitTilt);
        bee.root.rotation.y = Math.atan2(tx, tz);

        // Rapid wing buzz — rotate outward from the body
        const flapAngle = Math.sin(bee.wingPhase) * 0.60;
        bee.wL.rotation.y =  flapAngle;
        bee.wR.rotation.y = -flapAngle;
      }
    }
  }

  dispose() {
    this.scene.remove(this._group);
    for (const g of this._geoms) g.dispose();
    this._geoms = [];
    for (const m of this._mats) m.dispose();
    this._mats = [];
    this.swarms = [];
  }
}
