import * as THREE from 'three';
import { TileType, TILE_SIZE, WORLD_WIDTH, WORLD_HEIGHT } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

// How many decorative sheep to scatter across the world
const SHEEP_COUNT = 18;

// Seeded pseudo-random (deterministic placement each load)
function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

export class SheepRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this._sheep = []; // { group, bodyMat, homeX, homeZ, phase, facingY }
    this._build();
  }

  _build() {
    // Shared geometries for all sheep
    const puffData = [
      { geom: new THREE.SphereGeometry(0.22, 8, 6),  x:  0,     y: 0.15, z:  0    },
      { geom: new THREE.SphereGeometry(0.18, 7, 5),  x: -0.17,  y: 0.13, z:  0.02 },
      { geom: new THREE.SphereGeometry(0.18, 7, 5),  x:  0.17,  y: 0.13, z:  0.02 },
      { geom: new THREE.SphereGeometry(0.17, 7, 5),  x:  0,     y: 0.27, z: -0.02 },
      { geom: new THREE.SphereGeometry(0.155, 7, 5), x: -0.09,  y: 0.22, z:  0.12 },
      { geom: new THREE.SphereGeometry(0.155, 7, 5), x:  0.09,  y: 0.22, z:  0.12 },
      { geom: new THREE.SphereGeometry(0.14, 7, 5),  x:  0,     y: 0.13, z: -0.17 },
    ];
    const headGeom = new THREE.SphereGeometry(0.10, 8, 6);
    const eyeGeom  = new THREE.SphereGeometry(0.028, 5, 4);
    const legGeom  = new THREE.CylinderGeometry(0.036, 0.030, 0.16, 5);

    const eyeMat  = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.5 });
    const faceMat = new THREE.MeshStandardMaterial({ color: 0xdcc8a0, roughness: 0.85 });
    const legMat  = new THREE.MeshStandardMaterial({ color: 0xbcaa90, roughness: 0.90 });

    // Collect grass tiles
    const grassTiles = [];
    for (let z = 0; z < WORLD_HEIGHT; z++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        const tile = this.world.getTile(x, z);
        if (tile?.type === TileType.GRASS) grassTiles.push({ x, z });
      }
    }

    const rand = seededRand(42);
    const placed = new Set();

    // Shuffle & pick SHEEP_COUNT grass tiles, one sheep per tile
    for (let i = grassTiles.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [grassTiles[i], grassTiles[j]] = [grassTiles[j], grassTiles[i]];
    }

    const surfY = TerrainRenderer.surfaceY(TileType.GRASS);

    for (let i = 0; i < Math.min(SHEEP_COUNT, grassTiles.length); i++) {
      const tile = grassTiles[i];

      // Offset sheep within the tile
      const offX = (rand() - 0.5) * 0.8;
      const offZ = (rand() - 0.5) * 0.8;
      const homeX = (tile.x + 0.5 + offX) * TILE_SIZE;
      const homeZ = (tile.z + 0.5 + offZ) * TILE_SIZE;

      const isBlack = placed.size % 9 === 0; // roughly 1 in 9 is a black sheep
      placed.add(i);

      const bodyMat = new THREE.MeshStandardMaterial({
        color: isBlack ? 0x1a1a1a : 0xf5f2ec,
        roughness: 0.72,
      });

      const woolPuffs = puffData.map(({ geom, x, y, z }) => {
        const puff = new THREE.Mesh(geom, bodyMat);
        puff.position.set(x, y, z);
        puff.castShadow = true;
        return puff;
      });

      const head = new THREE.Mesh(headGeom, faceMat);
      head.position.set(0, 0.12, 0.26);

      const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
      const eyeR = new THREE.Mesh(eyeGeom, eyeMat);
      eyeL.position.set(-0.062, 0.13, 0.355);
      eyeR.position.set( 0.062, 0.13, 0.355);

      const legOffsets = [[-0.09, -0.12, 0.07], [0.09, -0.12, 0.07], [-0.09, -0.12, -0.07], [0.09, -0.12, -0.07]];
      const legs = legOffsets.map(([lx, ly, lz]) => {
        const leg = new THREE.Mesh(legGeom, legMat);
        leg.position.set(lx, ly, lz);
        return leg;
      });

      const group = new THREE.Group();
      group.add(...woolPuffs, head, eyeL, eyeR, ...legs);
      group.position.set(homeX, surfY + 0.18, homeZ);
      group.rotation.y = rand() * Math.PI * 2;
      this.scene.add(group);

      this._sheep.push({
        group,
        bodyMat,
        legs,
        homeX,
        homeZ,
        surfY,
        phase: rand() * Math.PI * 2,
        wanderAngle: rand() * Math.PI * 2,
        wanderTimer: rand() * 4,
      });
    }

    // Store shared disposables for cleanup
    this._puffData = puffData;
    this._headGeom = headGeom;
    this._eyeGeom  = eyeGeom;
    this._legGeom  = legGeom;
    this._eyeMat   = eyeMat;
    this._faceMat  = faceMat;
    this._legMat   = legMat;
  }

  update(delta) {
    const now = Date.now() * 0.001;
    for (const sheep of this._sheep) {
      // Slowly drift toward home position with gentle wandering
      sheep.wanderTimer -= delta;
      if (sheep.wanderTimer <= 0) {
        sheep.wanderAngle += (Math.random() - 0.5) * 1.2;
        sheep.wanderTimer = 2 + Math.random() * 3;
      }

      const speed = 0.25;
      const wx = sheep.homeX + Math.cos(sheep.wanderAngle) * 0.6;
      const wz = sheep.homeZ + Math.sin(sheep.wanderAngle) * 0.6;
      const dx = wx - sheep.group.position.x;
      const dz = wz - sheep.group.position.z;

      sheep.group.position.x += dx * delta * speed;
      sheep.group.position.z += dz * delta * speed;

      // Face direction of travel
      if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
        sheep.group.rotation.y = Math.atan2(dx, dz);
      }

      // Gentle bob
      sheep.group.position.y = sheep.surfY + 0.18 + Math.abs(Math.sin(now * 1.4 + sheep.phase)) * 0.012;

      // Leg walk animation
      const t = now * 1.4 + sheep.phase;
      const swing = 0.22 * Math.sin(t);
      sheep.legs[0].rotation.x =  swing;
      sheep.legs[3].rotation.x =  swing;
      sheep.legs[1].rotation.x = -swing;
      sheep.legs[2].rotation.x = -swing;
    }
  }

  dispose() {
    for (const { group, bodyMat } of this._sheep) {
      this.scene.remove(group);
      bodyMat.dispose();
    }
    for (const { geom } of this._puffData) geom.dispose();
    this._headGeom.dispose();
    this._eyeGeom.dispose();
    this._legGeom.dispose();
    this._eyeMat.dispose();
    this._faceMat.dispose();
    this._legMat.dispose();
    this._sheep = [];
  }
}
