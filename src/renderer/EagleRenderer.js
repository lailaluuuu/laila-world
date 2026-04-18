/**
 * CAD-198: Enhanced Eagle soaring — thermal riding above mountains.
 *
 * Eagles orbit above the highest cluster of MOUNTAIN tiles. Altitude varies
 * sinusoidally between y=8 and y=14 (thermal updraft simulation). Occasionally
 * dives toward terrain (y=1.5) then climbs back — simulating a hunting pass.
 */
import * as THREE from 'three';
import { TileType, WORLD_WIDTH, WORLD_HEIGHT } from '../simulation/World.js';

const EAGLE_COUNT  = 3;
const SOAR_SPEED   = 0.4;  // radians/sec (orbit angular speed)
const SOAR_Y_MIN   = 8;
const SOAR_Y_MAX   = 14;
const DIVE_Y       = 1.5;  // altitude during hunting pass
const DIVE_INTERVAL_MIN = 30;  // seconds between dive attempts
const DIVE_INTERVAL_MAX = 60;
const DIVE_DESCEND_TIME = 2.5; // seconds to reach low point
const DIVE_HOLD_TIME    = 1.2; // seconds at low altitude
const DIVE_CLIMB_TIME   = 4.0; // seconds to return to soar altitude

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function findMountainClusterCentre(world) {
  let sumX = 0, sumZ = 0, count = 0;
  for (let z = 0; z < WORLD_HEIGHT; z++) {
    for (let x = 0; x < WORLD_WIDTH; x++) {
      const tile = world.getTile(x, z);
      if (tile?.type === TileType.MOUNTAIN) {
        sumX += x;
        sumZ += z;
        count++;
      }
    }
  }
  if (count === 0) return { cx: WORLD_WIDTH / 2, cz: WORLD_HEIGHT / 2 };
  return { cx: sumX / count, cz: sumZ / count };
}

export class EagleRenderer {
  constructor(scene, world) {
    this.scene  = scene;
    this._world = world ?? null;
    this._eagles = [];
    this._build();
  }

  _build() {
    let thermalCX = WORLD_WIDTH  / 2;
    let thermalCZ = WORLD_HEIGHT / 2;
    if (this._world) {
      const c = findMountainClusterCentre(this._world);
      thermalCX = c.cx;
      thermalCZ = c.cz;
    }

    const bodyGeom = new THREE.BoxGeometry(0.28, 0.14, 0.55);
    const wingGeom = new THREE.BoxGeometry(1.1, 0.06, 0.35);
    const tailGeom = new THREE.BoxGeometry(0.18, 0.05, 0.22);
    const headGeom = new THREE.SphereGeometry(0.10, 7, 5);
    const beakGeom = new THREE.BoxGeometry(0.06, 0.05, 0.12);

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.85 });
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x4a3010, roughness: 0.9  });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xf5f0e0, roughness: 0.85 });
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xe0aa20, roughness: 0.7  });

    const rand = seededRand(13);

    for (let i = 0; i < EAGLE_COUNT; i++) {
      const group = new THREE.Group();

      const body = new THREE.Mesh(bodyGeom, bodyMat);
      group.add(body);

      const wingL = new THREE.Mesh(wingGeom, wingMat);
      wingL.position.set(-0.69, 0.02, 0.0);
      group.add(wingL);

      const wingR = new THREE.Mesh(wingGeom, wingMat);
      wingR.position.set(0.69, 0.02, 0.0);
      group.add(wingR);

      const tail = new THREE.Mesh(tailGeom, wingMat);
      tail.position.set(0, -0.03, -0.35);
      group.add(tail);

      const head = new THREE.Mesh(headGeom, headMat);
      head.position.set(0, 0.07, 0.32);
      group.add(head);

      const beak = new THREE.Mesh(beakGeom, beakMat);
      beak.position.set(0, 0.02, 0.48);
      group.add(beak);

      const offsetX   = (rand() - 0.5) * WORLD_WIDTH  * 0.3;
      const offsetZ   = (rand() - 0.5) * WORLD_HEIGHT * 0.3;
      const orbitCX   = thermalCX + offsetX;
      const orbitCZ   = thermalCZ + offsetZ;
      const radius    = 10 + rand() * 12;
      const soarY     = SOAR_Y_MIN + rand() * (SOAR_Y_MAX - SOAR_Y_MIN);
      const angle     = rand() * Math.PI * 2;
      const speed     = SOAR_SPEED * (0.7 + rand() * 0.6);
      const bankPhase = rand() * Math.PI * 2;
      const thermalPhase = rand() * Math.PI * 2;
      const diveTimer = DIVE_INTERVAL_MIN + rand() * (DIVE_INTERVAL_MAX - DIVE_INTERVAL_MIN);

      this._eagles.push({
        group,
        orbitCX, orbitCZ,
        radius,
        soarY,
        angle,
        speed,
        bankPhase,
        thermalPhase,
        time: rand() * 100,
        diveTimer,
        diveState: 'soar',
        diveT: 0,
        diveFromY: soarY,
      });

      group.position.set(
        orbitCX * 2 + radius * Math.sin(angle),
        soarY,
        orbitCZ * 2 + radius * Math.cos(angle)
      );
      this.scene.add(group);
    }
  }

  update(delta) {
    for (const e of this._eagles) {
      e.angle += e.speed * delta;
      e.time  += delta;

      const wx = e.orbitCX * 2 + e.radius * Math.sin(e.angle);
      const wz = e.orbitCZ * 2 + e.radius * Math.cos(e.angle);

      const thermalY = (SOAR_Y_MIN + SOAR_Y_MAX) / 2 +
        Math.sin(e.time * 0.15 + e.thermalPhase) * ((SOAR_Y_MAX - SOAR_Y_MIN) / 2);

      let wy = thermalY;

      if (e.diveState === 'soar') {
        wy = thermalY;
        e.diveTimer -= delta;
        if (e.diveTimer <= 0) {
          e.diveState = 'descend';
          e.diveT     = 0;
          e.diveFromY = thermalY;
        }
      } else if (e.diveState === 'descend') {
        e.diveT += delta / DIVE_DESCEND_TIME;
        if (e.diveT >= 1) {
          e.diveT     = 1;
          e.diveState = 'hold';
          e._holdTimer = DIVE_HOLD_TIME;
        }
        const t = e.diveT * e.diveT;
        wy = e.diveFromY + (DIVE_Y - e.diveFromY) * t;
      } else if (e.diveState === 'hold') {
        wy = DIVE_Y;
        e._holdTimer -= delta;
        if (e._holdTimer <= 0) {
          e.diveState     = 'climb';
          e.diveT         = 0;
          e.diveFromY     = DIVE_Y;
          e._climbTargetY = thermalY;
        }
      } else if (e.diveState === 'climb') {
        e.diveT += delta / DIVE_CLIMB_TIME;
        if (e.diveT >= 1) {
          e.diveT     = 1;
          e.diveState = 'soar';
          e.diveTimer = DIVE_INTERVAL_MIN +
            Math.random() * (DIVE_INTERVAL_MAX - DIVE_INTERVAL_MIN);
        }
        const t = 1 - (1 - e.diveT) * (1 - e.diveT);
        wy = e.diveFromY + (e._climbTargetY - e.diveFromY) * t;
      }

      e.group.position.set(wx, wy, wz);
      e.group.rotation.y = -e.angle - Math.PI / 2;

      const bankMult = e.diveState === 'descend' ? 2.5 : 1.0;
      e.group.rotation.z = Math.sin(e.time * e.speed * 0.8 + e.bankPhase) * 0.18 * bankMult;

      if (e.diveState === 'descend') {
        e.group.rotation.x = -0.35 * e.diveT;
      } else if (e.diveState === 'climb') {
        e.group.rotation.x = 0.2 * (1 - e.diveT);
      } else {
        e.group.rotation.x = 0;
      }
    }
  }

  dispose() {
    for (const e of this._eagles) this.scene.remove(e.group);
    this._eagles.length = 0;
  }
}
