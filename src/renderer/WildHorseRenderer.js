import * as THREE from 'three';
import { TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const HOOF = 0x1a1510;

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
    const hoofMat = new THREE.MeshStandardMaterial({
      color: HOOF,
      roughness: 0.95,
    });
    this._mats.push(hoofMat);

    for (let i = 0; i < this.horses.length; i++) {
      const horseSim = this.horses[i];
      const P = horseSim.coatPreset;

      const bodyMat = new THREE.MeshStandardMaterial({
        color: P.coat,
        roughness: 0.82,
        metalness: 0.02,
      });
      const darkMat = new THREE.MeshStandardMaterial({
        color: P.dark,
        roughness: 0.88,
      });
      const muzzleMat = new THREE.MeshStandardMaterial({
        color: P.muzzle,
        roughness: 0.9,
      });
      const maneMat = new THREE.MeshStandardMaterial({
        color: P.mane,
        roughness: 0.92,
      });
      this._mats.push(bodyMat, darkMat, muzzleMat, maneMat);

      const root = new THREE.Group();
      const horse = new THREE.Group();
      horse.position.y = 0.38;

      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.22, 0.5, 10, 1, false),
        bodyMat,
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = 0.02;
      barrel.castShadow = true;
      this._geoms.push(barrel.geometry);

      const withers = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 6),
        bodyMat,
      );
      withers.scale.set(1.1, 0.75, 1);
      withers.position.set(0, 0.08, -0.22);
      withers.castShadow = true;
      this._geoms.push(withers.geometry);

      const neck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.14, 0.38, 8, 1, false),
        bodyMat,
      );
      neck.rotation.x = -0.55;
      neck.position.set(0, 0.12, -0.48);
      neck.castShadow = true;
      this._geoms.push(neck.geometry);

      const mane = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.14, 0.36),
        maneMat,
      );
      mane.position.set(0, 0.22, -0.46);
      mane.rotation.x = -0.5;
      mane.castShadow = true;
      this._geoms.push(mane.geometry);

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

      const tail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.02, 0.45, 6, 1, false),
        maneMat,
      );
      tail.rotation.x = 0.85;
      tail.position.set(0, 0.1, 0.38);
      tail.castShadow = true;
      this._geoms.push(tail.geometry);

      const self = this;
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
        self._geoms.push(upper.geometry, lower.geometry, hoof.geometry);
        return { pivot };
      }

      const legFL = makeLeg(bodyMat, 0.12, -0.14);
      const legFR = makeLeg(bodyMat, -0.12, -0.14);
      const legBL = makeLeg(bodyMat, 0.12, 0.2);
      const legBR = makeLeg(bodyMat, -0.12, 0.2);

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
        horseSim,
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
      const { root, horse, horseSim, legs, tail } = entry;
      const tile = this.world.getTile(
        Math.floor(horseSim.x),
        Math.floor(horseSim.z),
      );
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;
      const wx = horseSim.x * TILE_SIZE;
      const wz = horseSim.z * TILE_SIZE;

      const fx = horseSim.facingX;
      const fz = horseSim.facingZ;
      const len = Math.hypot(fx, fz) || 1;
      root.position.set(wx, surfY + 0.02, wz);
      root.lookAt(wx + fx / len, surfY + 0.35, wz + fz / len);

      const phase = horseSim.gallopPhase;
      const gait = horseSim.gait;
      const jumping = horseSim.jumpT > 0 && horseSim.jumpT < 1;
      const jumpY =
        jumping && horseSim.jumpT > 0
          ? Math.sin(Math.PI * Math.min(1, horseSim.jumpT)) * 0.38
          : 0;
      root.position.y += jumpY;

      let bounce = 0;
      let swing = 0.22;
      let pitch = 0.02;
      if (gait === 'run' && !jumping) {
        bounce = Math.abs(Math.sin(phase * 2)) * 0.055;
        swing = 0.52;
        pitch = 0.06;
      } else if (gait === 'walk' && !jumping) {
        bounce = Math.abs(Math.sin(phase)) * 0.022;
        swing = 0.28;
        pitch = 0.025;
      } else if (gait === 'idle') {
        bounce = Math.sin(phase * 0.5) * 0.012;
        swing = 0.06;
        pitch = 0.01;
      }
      if (jumping) {
        swing *= 0.35;
        pitch = 0.03;
      }

      horse.position.y = 0.38 + bounce;
      horse.rotation.x = Math.sin(phase * (gait === 'run' ? 2 : 1)) * pitch;

      legs[0].pivot.rotation.x = swing * Math.sin(phase);
      legs[1].pivot.rotation.x = swing * Math.sin(phase + Math.PI);
      legs[2].pivot.rotation.x = swing * Math.sin(phase + Math.PI * 0.5);
      legs[3].pivot.rotation.x = swing * Math.sin(phase + Math.PI * 1.5);

      tail.rotation.z = Math.sin(phase * 2) * (gait === 'run' ? 0.15 : 0.08);
    }
  }
}
