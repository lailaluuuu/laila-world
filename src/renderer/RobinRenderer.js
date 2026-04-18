import * as THREE from 'three';
import { TileType, WORLD_WIDTH, WORLD_HEIGHT, TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const ROBIN_COUNT   = 7;
const HOP_SPEED     = 0.55;   // tiles/sec while hopping
const FLIGHT_SPEED  = 3.2;    // tiles/sec while in the air
const HOP_HEIGHT    = 0.09;   // bounce peak (world units)
const FLIGHT_HEIGHT = 1.4;    // arc peak above ground
const PAUSE_MIN     = 1.2;
const PAUSE_MAX     = 3.5;
const HOP_INTERVAL  = 0.55;   // seconds between hops
const FLIGHT_CHANCE = 0.22;   // chance of flying instead of hopping on direction change

const GROUND_TILES = new Set([TileType.GRASS, TileType.WOODLAND]);

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function pickGroundTile(world, rand) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const x = Math.floor(rand() * WORLD_WIDTH);
    const z = Math.floor(rand() * WORLD_HEIGHT);
    const tile = world.getTile(x, z);
    if (tile && GROUND_TILES.has(tile.type)) return tile;
  }
  return null;
}

export class RobinRenderer {
  constructor(scene, world) {
    this.scene  = scene;
    this._world = world;
    this._robins = [];
    this._build();
  }

  _build() {
    const rand = seededRand(42);

    // ── Materials ──────────────────────────────────────────────────────────
    const backMat   = new THREE.MeshStandardMaterial({ color: 0x3b2510, roughness: 0.88 }); // dark brown back
    const breastMat = new THREE.MeshStandardMaterial({ color: 0xd94f18, roughness: 0.82 }); // robin red breast
    const headMat   = new THREE.MeshStandardMaterial({ color: 0x1c1410, roughness: 0.85 }); // nearly black head
    const beakMat   = new THREE.MeshStandardMaterial({ color: 0xd4a020, roughness: 0.65 }); // yellowish beak
    const eyeMat    = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.4,
                                                       emissive: 0x111111 });
    const bellyMat  = new THREE.MeshStandardMaterial({ color: 0xf0e0d0, roughness: 0.88 }); // pale belly

    // ── Geometries ─────────────────────────────────────────────────────────
    const bodyGeom   = new THREE.SphereGeometry(0.095, 7, 5);
    const breastGeom = new THREE.SphereGeometry(0.085, 6, 5);
    const headGeom   = new THREE.SphereGeometry(0.070, 6, 5);
    const beakGeom   = new THREE.BoxGeometry(0.022, 0.018, 0.055);
    const eyeGeom    = new THREE.SphereGeometry(0.016, 5, 4);
    const wingGeom   = new THREE.BoxGeometry(0.18, 0.030, 0.12);
    const tailGeom   = new THREE.BoxGeometry(0.065, 0.018, 0.11);

    const surfGrass    = TerrainRenderer.surfaceY(TileType.GRASS);
    const surfWoodland = TerrainRenderer.surfaceY(TileType.WOODLAND);

    for (let i = 0; i < ROBIN_COUNT; i++) {
      const tile = pickGroundTile(this._world, rand);
      if (!tile) continue;

      const ox = (rand() - 0.5) * 1.2;
      const oz = (rand() - 0.5) * 1.2;
      const wx = (tile.x + 0.5 + ox) * TILE_SIZE;
      const wz = (tile.z + 0.5 + oz) * TILE_SIZE;
      const baseY = tile.type === TileType.WOODLAND ? surfWoodland : surfGrass;

      const group = new THREE.Group();

      // Body (back colour)
      const body = new THREE.Mesh(bodyGeom, backMat);
      body.position.set(0, 0.095, 0);
      body.scale.set(1.0, 0.88, 1.15); // slightly squished horizontally
      group.add(body);

      // Breast (orange-red, forward and slightly lower)
      const breast = new THREE.Mesh(breastGeom, breastMat);
      breast.position.set(0, 0.088, 0.045);
      breast.scale.set(0.95, 0.90, 0.85);
      group.add(breast);

      // Pale belly (bottom of breast)
      const belly = new THREE.Mesh(breastGeom, bellyMat);
      belly.position.set(0, 0.055, 0.055);
      belly.scale.set(0.55, 0.55, 0.55);
      group.add(belly);

      // Head
      const head = new THREE.Mesh(headGeom, headMat);
      head.position.set(0, 0.200, 0.055);
      group.add(head);

      // Beak
      const beak = new THREE.Mesh(beakGeom, beakMat);
      beak.position.set(0, 0.198, 0.118);
      group.add(beak);

      // Eyes
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(eyeGeom, eyeMat);
        eye.position.set(side * 0.038, 0.212, 0.082);
        group.add(eye);
      }

      // Wings (store refs for flapping)
      const wingL = new THREE.Mesh(wingGeom, backMat);
      wingL.position.set(-0.135, 0.105, -0.005);
      wingL.rotation.z =  0.15;
      group.add(wingL);

      const wingR = new THREE.Mesh(wingGeom, backMat);
      wingR.position.set( 0.135, 0.105, -0.005);
      wingR.rotation.z = -0.15;
      group.add(wingR);

      // Tail (angled downward slightly)
      const tail = new THREE.Mesh(tailGeom, backMat);
      tail.position.set(0, 0.082, -0.115);
      tail.rotation.x = 0.30;
      group.add(tail);

      group.position.set(wx, baseY, wz);
      group.rotation.y = rand() * Math.PI * 2;
      this.scene.add(group);

      this._robins.push({
        group,
        wingL,
        wingR,
        x: tile.x + 0.5 + ox,
        z: tile.z + 0.5 + oz,
        baseY,
        facing: rand() * Math.PI * 2,

        // Hopping state
        state: 'pause',
        pauseTimer: rand() * PAUSE_MAX,
        hopTimer: 0,
        hopPhase: 0,   // 0 = not mid-hop, >0 = seconds remaining in hop bounce

        // Head-bob
        headBobTimer: rand() * 1.5,
        headBobPhase: 0,

        // Flight state
        flightFromX: 0, flightFromZ: 0, flightFromY: baseY,
        flightToX:   0, flightToZ:   0, flightToY:   baseY,
        flightT:     0,
        flightDur:   1,
        wingFlapT:   0,

        // Head reference for bobbing
        head,
        headBaseY: 0.200,
      });
    }
  }

  update(delta) {
    for (const r of this._robins) {
      if (r.state === 'pause') {
        r.pauseTimer -= delta;

        // Gentle head bob while paused
        r.headBobTimer -= delta;
        if (r.headBobTimer <= 0) {
          r.headBobTimer = 0.45 + Math.random() * 0.6;
          r.headBobPhase = 0.25;
        }
        if (r.headBobPhase > 0) {
          r.headBobPhase = Math.max(0, r.headBobPhase - delta);
          const t = 1 - r.headBobPhase / 0.25;
          const dip = Math.sin(t * Math.PI) * 0.025;
          r.head.position.y = r.headBaseY - dip;
        }

        if (r.pauseTimer <= 0) {
          // Decide: fly to a new tile, or just hop around on this one
          if (Math.random() < FLIGHT_CHANCE) {
            this._startFlight(r);
          } else {
            r.state = 'ground';
            r.facing += (Math.random() - 0.5) * Math.PI * 1.2;
            r.hopTimer = 0;
          }
        }

        r.group.position.set(r.x * TILE_SIZE, r.baseY, r.z * TILE_SIZE);

      } else if (r.state === 'ground') {
        // Hop forward in facing direction
        r.hopTimer -= delta;

        if (r.hopPhase > 0) {
          r.hopPhase -= delta;
          const t = Math.max(0, r.hopPhase) / 0.18;
          const yOff = HOP_HEIGHT * Math.sin(t * Math.PI);

          const dx = Math.sin(r.facing) * HOP_SPEED * delta;
          const dz = Math.cos(r.facing) * HOP_SPEED * delta;
          const nx = r.x + dx;
          const nz = r.z + dz;
          const tile = this._world.getTile(Math.floor(nx), Math.floor(nz));
          if (tile && GROUND_TILES.has(tile.type)) {
            r.x = nx;
            r.z = nz;
          } else {
            r.facing += Math.PI * (0.5 + Math.random() * 0.8);
          }
          r.group.position.set(r.x * TILE_SIZE, r.baseY + yOff, r.z * TILE_SIZE);
        } else {
          r.group.position.set(r.x * TILE_SIZE, r.baseY, r.z * TILE_SIZE);
        }

        if (r.hopTimer <= 0) {
          r.hopTimer = HOP_INTERVAL * (0.6 + Math.random() * 0.8);
          r.hopPhase = 0.18;
          // Occasionally pause after a run of hops
          if (Math.random() < 0.25) {
            r.state = 'pause';
            r.pauseTimer = PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
          }
        }

        r.group.rotation.y = -r.facing;

      } else if (r.state === 'flight') {
        r.flightT = Math.min(1, r.flightT + delta / r.flightDur);

        // Smooth ease in/out arc
        const ease = r.flightT < 0.5
          ? 2 * r.flightT * r.flightT
          : 1 - Math.pow(-2 * r.flightT + 2, 2) / 2;

        const fx = r.flightFromX + (r.flightToX - r.flightFromX) * ease;
        const fz = r.flightFromZ + (r.flightToZ - r.flightFromZ) * ease;
        const arc = Math.sin(r.flightT * Math.PI) * FLIGHT_HEIGHT;
        const fy  = r.flightFromY + (r.flightToY - r.flightFromY) * ease + arc;

        r.x = fx / TILE_SIZE;
        r.z = fz / TILE_SIZE;
        r.group.position.set(fx, fy, fz);

        // Face direction of travel
        const dx = r.flightToX - r.flightFromX;
        const dz = r.flightToZ - r.flightFromZ;
        if (Math.hypot(dx, dz) > 0.01) {
          r.facing = Math.atan2(dx, dz);
          r.group.rotation.y = -r.facing;
        }

        // Slight nose-down pitch during flight
        r.group.rotation.x = -0.18;

        // Wing flap
        r.wingFlapT += delta * 8.0;
        const flapAngle = Math.sin(r.wingFlapT) * 0.55;
        r.wingL.rotation.z =  0.15 + flapAngle;
        r.wingR.rotation.z = -0.15 - flapAngle;

        if (r.flightT >= 1) {
          // Land
          r.x = r.flightToX / TILE_SIZE;
          r.z = r.flightToZ / TILE_SIZE;
          const tile = this._world.getTile(Math.floor(r.x), Math.floor(r.z));
          r.baseY = tile?.type === TileType.WOODLAND
            ? TerrainRenderer.surfaceY(TileType.WOODLAND)
            : TerrainRenderer.surfaceY(TileType.GRASS);
          r.group.position.set(r.flightToX, r.baseY, r.flightToZ);
          r.group.rotation.x = 0;
          r.wingL.rotation.z =  0.15;
          r.wingR.rotation.z = -0.15;
          r.state = 'pause';
          r.pauseTimer = PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
        }
      }
    }
  }

  _startFlight(r) {
    // Pick a random ground tile within ~10-18 tiles
    const cx = Math.floor(r.x);
    const cz = Math.floor(r.z);
    for (let attempt = 0; attempt < 30; attempt++) {
      const range = 8 + Math.floor(Math.random() * 10);
      const tx = cx + Math.floor((Math.random() - 0.5) * range * 2);
      const tz = cz + Math.floor((Math.random() - 0.5) * range * 2);
      const tile = this._world.getTile(tx, tz);
      if (!tile || !GROUND_TILES.has(tile.type)) continue;

      const toX = (tx + 0.5 + (Math.random() - 0.5) * 0.8) * TILE_SIZE;
      const toZ = (tz + 0.5 + (Math.random() - 0.5) * 0.8) * TILE_SIZE;
      const toY = tile.type === TileType.WOODLAND
        ? TerrainRenderer.surfaceY(TileType.WOODLAND)
        : TerrainRenderer.surfaceY(TileType.GRASS);

      const dist = Math.hypot(toX - r.x * TILE_SIZE, toZ - r.z * TILE_SIZE);
      r.flightFromX = r.x * TILE_SIZE;
      r.flightFromZ = r.z * TILE_SIZE;
      r.flightFromY = r.baseY;
      r.flightToX   = toX;
      r.flightToZ   = toZ;
      r.flightToY   = toY;
      r.flightT     = 0;
      r.flightDur   = Math.max(0.5, dist / (FLIGHT_SPEED * TILE_SIZE));
      r.wingFlapT   = 0;
      r.state       = 'flight';
      return;
    }
    // Fallback: just pause again
    r.state = 'pause';
    r.pauseTimer = PAUSE_MIN + Math.random() * PAUSE_MAX;
  }

  dispose() {
    for (const r of this._robins) this.scene.remove(r.group);
    this._robins.length = 0;
  }
}
