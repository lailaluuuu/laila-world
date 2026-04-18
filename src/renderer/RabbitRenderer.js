import * as THREE from 'three';
import { TileType, WORLD_WIDTH, WORLD_HEIGHT } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const RABBIT_COUNT = 8;
const WANDER_SPEED  = 0.3;  // tiles/sec
const FLEE_SPEED    = 1.4;  // tiles/sec when frightened
const HOP_INTERVAL  = 1.4;  // seconds between hops
const HOP_HEIGHT    = 0.18; // world units, peak of hop

const RABBIT_FEAR_RADIUS = 5;
const FEAR_RISE_RATE     = 0.1;
const FEAR_DECAY_RATE    = 0.05;
const FEAR_FLEE_THRESH   = 0.7;
const FEAR_CALM_THRESH   = 0.2;

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

export class RabbitRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this._rabbits = [];
    this._build();
  }

  _build() {
    const bodyGeom = new THREE.SphereGeometry(0.14, 7, 5);
    const headGeom = new THREE.SphereGeometry(0.10, 7, 5);
    const earGeom  = new THREE.CylinderGeometry(0.025, 0.018, 0.18, 5);
    const tailGeom = new THREE.SphereGeometry(0.045, 5, 4);
    const eyeGeom  = new THREE.SphereGeometry(0.022, 5, 4);

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 0.9 });
    const eyeMat  = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });

    const grassTiles = [];
    for (let z = 0; z < WORLD_HEIGHT; z++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        const tile = this.world.getTile(x, z);
        if (tile?.type === TileType.GRASS) grassTiles.push({ x, z });
      }
    }

    const rand = seededRand(77);
    for (let i = grassTiles.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [grassTiles[i], grassTiles[j]] = [grassTiles[j], grassTiles[i]];
    }

    const surfY = TerrainRenderer.surfaceY(TileType.GRASS);

    for (let i = 0; i < Math.min(RABBIT_COUNT, grassTiles.length); i++) {
      const tile = grassTiles[i];
      const ox = (rand() - 0.5) * 1.4;
      const oz = (rand() - 0.5) * 1.4;

      const group = new THREE.Group();

      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.position.set(0, 0.14, 0);
      group.add(body);

      const head = new THREE.Mesh(headGeom, bodyMat);
      head.position.set(0, 0.27, 0.10);
      group.add(head);

      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(earGeom, bodyMat);
        ear.position.set(side * 0.055, 0.40, 0.10);
        ear.rotation.z = side * 0.1;
        group.add(ear);
      }

      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(eyeGeom, eyeMat);
        eye.position.set(side * 0.045, 0.30, 0.175);
        group.add(eye);
      }

      const tail = new THREE.Mesh(tailGeom, tailMat);
      tail.position.set(0, 0.15, -0.14);
      group.add(tail);

      group.position.set((tile.x + 0.5 + ox) * 2, surfY, (tile.z + 0.5 + oz) * 2);
      this.scene.add(group);

      this._rabbits.push({
        group,
        x: tile.x + 0.5 + ox,
        z: tile.z + 0.5 + oz,
        baseY: surfY,
        wanderAngle: rand() * Math.PI * 2,
        wanderTimer: rand() * 3,
        hopTimer: rand() * HOP_INTERVAL,
        hopPhase: 0,
        fearLevel: 0,
      });
    }
  }

  update(delta, agents = []) {
    for (const r of this._rabbits) {
      let nearestDist = Infinity;
      let nearestAx = r.x, nearestAz = r.z;
      for (const agent of agents) {
        if (!agent || agent.health <= 0) continue;
        const d = Math.hypot(agent.x - r.x, agent.z - r.z);
        if (d < nearestDist) { nearestDist = d; nearestAx = agent.x; nearestAz = agent.z; }
      }
      if (nearestDist < RABBIT_FEAR_RADIUS) {
        r.fearLevel = Math.min(1, r.fearLevel + FEAR_RISE_RATE * delta);
      } else {
        r.fearLevel = Math.max(0, r.fearLevel - FEAR_DECAY_RATE * delta);
      }

      const isFleeing = r.fearLevel > FEAR_FLEE_THRESH;
      if (isFleeing && nearestDist < Infinity) {
        r.wanderAngle = Math.atan2(r.x - nearestAx, r.z - nearestAz);
      }

      if (!isFleeing) {
        r.wanderTimer -= delta;
        if (r.wanderTimer <= 0) {
          r.wanderTimer = 1.5 + Math.random() * 2.5;
          r.wanderAngle += (Math.random() - 0.5) * Math.PI;
        }
      }

      r.hopTimer -= delta;
      const hopInterval = isFleeing ? HOP_INTERVAL * 0.35 : HOP_INTERVAL * (0.7 + Math.random() * 0.6);
      if (r.hopTimer <= 0) {
        r.hopTimer = hopInterval;
        r.hopPhase = 0.32;
      }

      const speed = isFleeing ? FLEE_SPEED : WANDER_SPEED;
      let yOffset = 0;
      if (r.hopPhase > 0) {
        r.hopPhase -= delta;
        const t = Math.max(0, r.hopPhase) / 0.32;
        yOffset = HOP_HEIGHT * Math.sin(t * Math.PI);

        const dx = Math.sin(r.wanderAngle) * speed * delta;
        const dz = Math.cos(r.wanderAngle) * speed * delta;
        const nx = r.x + dx;
        const nz = r.z + dz;
        const tile = this.world.getTile(Math.floor(nx), Math.floor(nz));
        if (tile?.type === TileType.GRASS || tile?.type === TileType.WOODLAND) {
          r.x = nx;
          r.z = nz;
        } else {
          r.wanderAngle += Math.PI * (0.5 + Math.random());
        }
      }

      r.group.rotation.y = -r.wanderAngle;
      r.group.position.set(r.x * 2, r.baseY + yOffset, r.z * 2);
    }
  }

  dispose() {
    for (const r of this._rabbits) this.scene.remove(r.group);
    this._rabbits.length = 0;
  }
}
