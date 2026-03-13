import * as THREE from 'three';
import { TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const BODY = 0x6b4423;
const MANE = 0x3d2817;

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
    const bodyGeom = new THREE.BoxGeometry(0.52, 0.28, 0.22);
    const neckGeom = new THREE.BoxGeometry(0.14, 0.2, 0.14);
    const headGeom = new THREE.BoxGeometry(0.16, 0.14, 0.2);
    const legGeom = new THREE.BoxGeometry(0.06, 0.22, 0.06);
    this._geoms.push(bodyGeom, neckGeom, headGeom, legGeom);

    const bodyMat = new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.85 });
    const maneMat = new THREE.MeshStandardMaterial({ color: MANE, roughness: 0.9 });
    this._mats.push(bodyMat, maneMat);

    for (let i = 0; i < this.horses.length; i++) {
      const group = new THREE.Group();

      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.position.y = 0.25;
      body.castShadow = true;

      const neck = new THREE.Mesh(neckGeom, bodyMat);
      neck.position.set(0.28, 0.38, 0);
      neck.rotation.z = -0.35;
      neck.castShadow = true;

      const head = new THREE.Mesh(headGeom, bodyMat);
      head.position.set(0.42, 0.48, 0);
      head.castShadow = true;

      const mane = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.18), maneMat);
      mane.position.set(0.22, 0.42, 0);
      mane.castShadow = true;
      this._geoms.push(mane.geometry);

      const legFL = new THREE.Mesh(legGeom, bodyMat);
      const legFR = new THREE.Mesh(legGeom, bodyMat);
      const legBL = new THREE.Mesh(legGeom, bodyMat);
      const legBR = new THREE.Mesh(legGeom, bodyMat);
      legFL.position.set(0.18, 0.11, 0.09);
      legFR.position.set(0.18, 0.11, -0.09);
      legBL.position.set(-0.18, 0.11, 0.09);
      legBR.position.set(-0.18, 0.11, -0.09);
      for (const leg of [legFL, legFR, legBL, legBR]) leg.castShadow = true;

      group.add(body, neck, head, mane, legFL, legFR, legBL, legBR);
      this.scene.add(group);
      this.entries.push({ group, horse: this.horses[i] });
    }
  }

  dispose() {
    for (const { group } of this.entries) this.scene.remove(group);
    this.entries = [];
    for (const g of this._geoms) g.dispose();
    this._geoms = [];
    for (const m of this._mats) m.dispose();
    this._mats = [];
  }

  update() {
    const t = Date.now() * 0.004;
    for (const { group, horse } of this.entries) {
      const tile = this.world.getTile(Math.floor(horse.x), Math.floor(horse.z));
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;
      group.position.set(horse.x * TILE_SIZE, surfY + 0.02, horse.z * TILE_SIZE);
      group.rotation.y = Math.atan2(horse.facingX, horse.facingZ);
      group.position.y += Math.sin(t + horse.x * 2.1) * 0.02;
    }
  }
}
