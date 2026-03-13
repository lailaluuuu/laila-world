import * as THREE from 'three';
import { TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

// Realistic bay / wild coat
const COAT = 0x5c4033;
const COAT_DARK = 0x3d2817;
const MUZZLE = 0x4a3728;
const HOOF = 0x1a1510;
const MANE_TAIL = 0x2a1810;

export class WildHorseRenderer {
  constructor(scene, horses, world) {
    this.scene = scene;
    this.horses = horses;
    this.world = world;
    this.entries = [];
    this._geoms = [];
    this._mats = [];
    this._build();
  }

  _build() {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: COAT,
      roughness: 0.82,
      metalness: 0.02,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: COAT_DARK,
      roughness: 0.88,
    });
    const muzzleMat = new THREE.MeshStandardMaterial({
      color: MUZZLE,
      roughness: 0.9,
    });
    const hoofMat = new THREE.MeshStandardMaterial({
      color: HOOF,
      roughness: 0.95,
    });
    const maneMat = new THREE.MeshStandardMaterial({
      color: MANE_TAIL,
      roughness: 0.92,
    });
    this._mats.push(bodyMat, darkMat, muzzleMat, hoofMat, maneMat);

    for (let i = 0; i < this.horses.length; i++) {
      const root = new THREE.Group();

      // Model built in local space: forward = -Z (Three.js lookAt convention)
      const horse = new THREE.Group();
      horse.position.y = 0.38;

      // Barrel (chest–belly)
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.22, 0.5, 10, 1, false),
        bodyMat,
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = 0.02;
      barrel.castShadow = true;
      this._geoms.push(barrel.geometry);

      // Withers / shoulder hump
      const withers = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 6),
        bodyMat,
      );
      withers.scale.set(1.1, 0.75, 1);
      withers.position.set(0, 0.08, -0.22);
      withers.castShadow = true;
      this._geoms.push(withers.geometry);

      // Neck (tapered)
      const neck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.14, 0.38, 8, 1, false),
        bodyMat,
      );
      neck.rotation.x = -0.55;
      neck.position.set(0, 0.12, -0.48);
      neck.castShadow = true;
      this._geoms.push(neck.geometry);

      // Mane strip
      const mane = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.14, 0.36),
        maneMat,
      );
      mane.position.set(0, 0.22, -0.46);
      mane.rotation.x = -0.5;
      mane.castShadow = true;
      this._geoms.push(mane.geometry);

      // Head + muzzle (read as one block + wedge)
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.16, 0.22),
        bodyMat,
      );
      head.position.set(0, 0.06, -0.72);
      head.castShadow = true;
      this._geoms.push(head.geometry);

      const muzzle = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.1, 0.16),
        muzzleMat,
      );
      muzzle.position.set(0, 0.02, -0.86);
      muzzle.castShadow = true;
      this._geoms.push(muzzle.geometry);

      const earL = new THREE.Mesh(
        new THREE.ConeGeometry(0.04, 0.1, 4),
        darkMat,
      );
      const earR = earL.clone();
      earL.position.set(-0.06, 0.18, -0.68);
      earR.position.set(0.06, 0.18, -0.68);
      earL.rotation.z = 0.35;
      earR.rotation.z = -0.35;
      earL.castShadow = earR.castShadow = true;
      this._geoms.push(earL.geometry);

      // Tail
      const tail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.02, 0.45, 6, 1, false),
        maneMat,
      );
      tail.rotation.x = 0.85;
      tail.position.set(0, 0.1, 0.38);
      tail.castShadow = true;
      this._geoms.push(tail.geometry);

      function makeLeg(material, x, z) {
        const pivot = new THREE.Group();
        pivot.position.set(x, 0, z);
        const upper = new THREE.Mesh(
          new THREE.CylinderGeometry(0.055, 0.045, 0.22, 6, 1, false),
          material,
        );
        upper.position.y = -0.11;
        upper.castShadow = true;
        const lower = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.035, 0.2, 6, 1, false),
          material,
        );
        lower.position.y = -0.28;
        lower.castShadow = true;
        const hoof = new THREE.Mesh(
          new THREE.BoxGeometry(0.07, 0.05, 0.09),
          hoofMat,
        );
        hoof.position.y = -0.42;
        hoof.castShadow = true;
        pivot.add(upper, lower, hoof);
        this._geoms.push(upper.geometry, lower.geometry, hoof.geometry);
        return { pivot, upper, lower };
      }

      const legFL = makeLeg.call(this, bodyMat, 0.12, -0.14);
      const legFR = makeLeg.call(this, bodyMat, -0.12, -0.14);
      const legBL = makeLeg.call(this, bodyMat, 0.12, 0.2);
      const legBR = makeLeg.call(this, bodyMat, -0.12, 0.2);

      horse.add(
        barrel,
        withers,
        neck,
        mane,
        head,
        muzzle,
        earL,
        earR,
        tail,
        legFL.pivot,
        legFR.pivot,
        legBL.pivot,
        legBR.pivot,
      );

      root.add(horse);
      this.scene.add(root);
      this.entries.push({
        root,
        horse,
        horseSim: this.horses[i],
        legs: [legFL, legFR, legBL, legBR],
        tail,
      });
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

  update() {
    for (const entry of this.entries) {
      const { root, horse, horseSim, legs } = entry;
      const tile = this.world.getTile(
        Math.floor(horseSim.x),
        Math.floor(horseSim.z),
      );
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;
      const wx = horseSim.x * TILE_SIZE;
      const wz = horseSim.z * TILE_SIZE;

      root.position.set(wx, surfY + 0.02, wz);
      const fx = horseSim.facingX;
      const fz = horseSim.facingZ;
      const len = Math.hypot(fx, fz) || 1;
      root.lookAt(wx + fx / len, surfY + 0.35, wz + fz / len);

      // gallopPhase advances in sim (~2+ rad/s while moving)
      const phase = horseSim.gallopPhase;

      // Vertical bounce + slight pitch (suspension)
      const bounce = Math.abs(Math.sin(phase * 2)) * 0.055;
      horse.position.y = 0.38 + bounce;
      horse.rotation.x = Math.sin(phase * 2) * 0.06;

      // Gallop leg order (approx): RH, LH, LF, RF — diagonal pairs swing together visually
      const swing = 0.55;
      legs[0].pivot.rotation.x = swing * Math.sin(phase); // FL
      legs[1].pivot.rotation.x = swing * Math.sin(phase + Math.PI); // FR
      legs[2].pivot.rotation.x = swing * Math.sin(phase + Math.PI * 0.5); // BL
      legs[3].pivot.rotation.x = swing * Math.sin(phase + Math.PI * 1.5); // BR

      entry.tail.rotation.z = Math.sin(phase * 2) * 0.15;
    }
  }
}
