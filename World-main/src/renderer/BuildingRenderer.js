import * as THREE from 'three';
import { TileType, TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

// Building levels: 1 = simple hut (shelter), 2 = stone house (housing)
const BUILDING_LEVEL = { shelter: 1, housing: 2 };

export class BuildingRenderer {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    /** @type {Map<string, { level: number, group: THREE.Group }>} */
    this._buildings = new Map();
  }

  /**
   * Scan sleeping agents and place / upgrade buildings on their tile.
   * Call this once per simulation step (not every render frame).
   */
  checkAgents(agents) {
    for (const agent of agents) {
      if (agent.health <= 0 || agent.state !== 'sleeping') continue;
      const level = agent.knowledge.has('housing') ? 2
                  : agent.knowledge.has('shelter') ? 1
                  : 0;
      if (level === 0) continue;

      const tx = Math.floor(agent.x);
      const tz = Math.floor(agent.z);
      const tile = this.world.getTile(tx, tz);
      if (!tile || tile.type === TileType.WATER || tile.type === TileType.MOUNTAIN) continue;

      const key = `${tx},${tz}`;
      const existing = this._buildings.get(key);
      if (!existing || existing.level < level) {
        this._place(key, tx, tz, level, tile.type);
      }
    }
  }

  _place(key, tx, tz, level, tileType) {
    const existing = this._buildings.get(key);
    if (existing) {
      this.scene.remove(existing.group);
      existing.group.traverse(obj => {
        obj.geometry?.dispose();
        obj.material?.dispose();
      });
    }
    const surfY = TerrainRenderer.surfaceY(tileType);
    const group = level >= 2
      ? this._makeHouse(tx, tz, surfY)
      : this._makeHut(tx, tz, surfY);
    this.scene.add(group);
    this._buildings.set(key, { level, group });
  }

  _makeHut(tx, tz, surfY) {
    const group = new THREE.Group();
    const cx = tx * TILE_SIZE + TILE_SIZE / 2;
    const cz = tz * TILE_SIZE + TILE_SIZE / 2;

    // Wattle-and-daub walls
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xc4a46e });
    const walls   = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.42, 0.85), wallMat);
    walls.position.set(cx, surfY + 0.21, cz);
    walls.castShadow = true;

    // Thatched pyramid roof (4-sided cone rotated 45° to align with box)
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x8a6030 });
    const roof    = new THREE.Mesh(new THREE.ConeGeometry(0.68, 0.38, 4), roofMat);
    roof.position.set(cx, surfY + 0.42 + 0.19, cz);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;

    group.add(walls, roof);
    return group;
  }

  _makeHouse(tx, tz, surfY) {
    const group = new THREE.Group();
    const cx = tx * TILE_SIZE + TILE_SIZE / 2;
    const cz = tz * TILE_SIZE + TILE_SIZE / 2;

    // Stone walls (taller, grey-brown)
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x9a8878 });
    const walls   = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.60, 1.05), wallMat);
    walls.position.set(cx, surfY + 0.30, cz);
    walls.castShadow = true;

    // Dark wood door
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x5a3a20 });
    const door    = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.30, 0.06), doorMat);
    door.position.set(cx, surfY + 0.15, cz + 0.53);

    // Terracotta tile roof
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x9b3a28 });
    const roof    = new THREE.Mesh(new THREE.ConeGeometry(0.84, 0.50, 4), roofMat);
    roof.position.set(cx, surfY + 0.60 + 0.25, cz);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;

    group.add(walls, door, roof);
    return group;
  }

  dispose() {
    for (const { group } of this._buildings.values()) {
      this.scene.remove(group);
      group.traverse(obj => {
        obj.geometry?.dispose();
        obj.material?.dispose();
      });
    }
    this._buildings.clear();
  }
}
