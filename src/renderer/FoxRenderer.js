import * as THREE from 'three';
import { TileType, TILE_SIZE, WORLD_WIDTH, WORLD_HEIGHT } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

export class FoxRenderer {
  constructor(scene, foxes, world) {
    this.scene = scene;
    this.foxes = foxes;
    this.world = world;
    this.entries = [];
    this._geoms = [];
    this._mats = [];
    this._build();
  }

  _build() {
    const bodyMat    = new THREE.MeshStandardMaterial({ color: 0xc45c0a, roughness: 0.82 });
    const tailMat    = new THREE.MeshStandardMaterial({ color: 0xd4700e, roughness: 0.85 });
    const tailTipMat = new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.88 });
    const earMat     = new THREE.MeshStandardMaterial({ color: 0xc45c0a, roughness: 0.82 });
    const snoutMat   = new THREE.MeshStandardMaterial({ color: 0x2a1a0a, roughness: 0.9  });
    const legMat     = new THREE.MeshStandardMaterial({ color: 0xa04808, roughness: 0.88 });
    const eyeMat     = new THREE.MeshStandardMaterial({ color: 0x1a1000, roughness: 0.5  });
    this._mats.push(bodyMat, tailMat, tailTipMat, earMat, snoutMat, legMat, eyeMat);

    const bodyGeom  = new THREE.BoxGeometry(0.35, 0.18, 0.55);
    const legGeom   = new THREE.CylinderGeometry(0.028, 0.022, 0.22, 5);
    const earGeom   = new THREE.ConeGeometry(0.045, 0.13, 4);
    const snoutGeom = new THREE.BoxGeometry(0.10, 0.08, 0.12);
    const eyeGeom   = new THREE.SphereGeometry(0.022, 5, 4);
    this._geoms.push(bodyGeom, legGeom, earGeom, snoutGeom, eyeGeom);

    for (let i = 0; i < this.foxes.length; i++) {
      const foxSim = this.foxes[i];

      const root = new THREE.Group();
      const fox  = new THREE.Group();
      fox.position.y = 0.22;

      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.castShadow = true;
      fox.add(body);

      const headGroup = new THREE.Group();
      headGroup.position.set(0, 0.06, -0.30);

      const headGeom = new THREE.BoxGeometry(0.20, 0.16, 0.22);
      this._geoms.push(headGeom);
      const head = new THREE.Mesh(headGeom, bodyMat);
      head.castShadow = true;
      headGroup.add(head);

      const earL = new THREE.Mesh(earGeom, earMat);
      const earR = earL.clone();
      earL.position.set(-0.065, 0.12, 0.02);
      earR.position.set( 0.065, 0.12, 0.02);
      earL.rotation.z =  0.18;
      earR.rotation.z = -0.18;
      earL.castShadow = earR.castShadow = true;
      headGroup.add(earL, earR);

      const snout = new THREE.Mesh(snoutGeom, snoutMat);
      snout.position.set(0, -0.03, -0.14);
      snout.castShadow = true;
      headGroup.add(snout);

      const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
      const eyeR = new THREE.Mesh(eyeGeom, eyeMat);
      eyeL.position.set(-0.072, 0.025, -0.08);
      eyeR.position.set( 0.072, 0.025, -0.08);
      headGroup.add(eyeL, eyeR);

      fox.add(headGroup);

      const tailGroup = new THREE.Group();
      tailGroup.position.set(0, 0.04, 0.30);
      tailGroup.rotation.x = -0.85;

      const tailBodyGeom = new THREE.ConeGeometry(0.12, 0.45, 6);
      this._geoms.push(tailBodyGeom);
      const tailBody = new THREE.Mesh(tailBodyGeom, tailMat);
      tailBody.position.y = 0.22;
      tailBody.castShadow = true;
      tailGroup.add(tailBody);

      const tailTipGeom = new THREE.SphereGeometry(0.075, 6, 5);
      this._geoms.push(tailTipGeom);
      const tailTip = new THREE.Mesh(tailTipGeom, tailTipMat);
      tailTip.position.y = 0.46;
      tailTip.castShadow = true;
      tailGroup.add(tailTip);

      fox.add(tailGroup);

      const legPositions = [
        [-0.10, -0.09, -0.15],
        [ 0.10, -0.09, -0.15],
        [-0.10, -0.09,  0.15],
        [ 0.10, -0.09,  0.15],
      ];
      const legs = legPositions.map(([lx, ly, lz]) => {
        const leg = new THREE.Mesh(legGeom, legMat);
        leg.position.set(lx, ly, lz);
        leg.castShadow = true;
        fox.add(leg);
        return leg;
      });

      root.add(fox);
      this.scene.add(root);

      this.entries.push({ root, fox, foxSim, legs, tailGroup, headGroup });
    }
  }

  update() {
    for (const { root, fox, foxSim, legs, tailGroup, headGroup } of this.entries) {
      const tile  = this.world.getTile(Math.floor(foxSim.x), Math.floor(foxSim.z));
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.1;

      const fx  = foxSim.facingX;
      const fz  = foxSim.facingZ;
      const len = Math.hypot(fx, fz) || 1;
      root.position.set(foxSim.x * TILE_SIZE, surfY + 0.01, foxSim.z * TILE_SIZE);
      root.rotation.set(0, Math.atan2(-fx / len, -fz / len), 0);

      const phase      = foxSim.walkPhase;
      const isRunning  = foxSim.isStartled;
      const isIdle     = foxSim.gait === 'idle';

      let swing = 0.18, bounce = 0;
      if (isRunning) {
        swing  = 0.50;
        bounce = Math.abs(Math.sin(phase * 2)) * 0.04;
      } else if (!isIdle) {
        swing  = 0.28;
        bounce = Math.abs(Math.sin(phase)) * 0.018;
      } else {
        swing  = 0.05;
        bounce = Math.sin(phase * 0.4) * 0.008;
      }

      fox.position.y      = 0.22 + bounce;
      legs[0].rotation.x  =  swing * Math.sin(phase);
      legs[1].rotation.x  =  swing * Math.sin(phase + Math.PI);
      legs[2].rotation.x  =  swing * Math.sin(phase + Math.PI * 0.5);
      legs[3].rotation.x  =  swing * Math.sin(phase + Math.PI * 1.5);

      tailGroup.rotation.z  = Math.sin(phase * (isRunning ? 3 : 1.5)) * (isRunning ? 0.20 : 0.12);
      headGroup.rotation.x  = isRunning ? -0.15 : 0;
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
