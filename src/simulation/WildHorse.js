import { TileType } from './World.js';

const REACH_DIST = 0.15;
const WANDER_RADIUS_MIN = 4;
const WANDER_RADIUS_MAX = 9;
const RETARGET_BASE = 5;
const JUMP_DURATION = 0.42;
const JUMP_COOLDOWN = 4;

/** Coat presets for renderer (hex numbers) */
export const HORSE_COAT_PRESETS = [
  { name: 'bay', coat: 0x5c4033, mane: 0x2a1810, dark: 0x3d2817, muzzle: 0x4a3728 },
  { name: 'black', coat: 0x1e1a18, mane: 0x0d0c0b, dark: 0x2a2522, muzzle: 0x3a3530 },
  { name: 'chestnut', coat: 0x8b4513, mane: 0x4a2510, dark: 0x6b3410, muzzle: 0x7a4a30 },
  { name: 'palomino', coat: 0xc4a574, mane: 0xe8dcc8, dark: 0xa08050, muzzle: 0xb89870 },
  { name: 'gray', coat: 0x8a8a88, mane: 0x4a4a48, dark: 0x6a6a68, muzzle: 0x7a7875 },
  { name: 'dun', coat: 0xa08050, mane: 0x3d3020, dark: 0x6b5538, muzzle: 0x8a7048 },
  { name: 'roan', coat: 0x6b5a4a, mane: 0x2a2018, dark: 0x4a3d32, muzzle: 0x5a4838 },
];

function horseTileOk(world, tx, tz) {
  const tile = world.getTile(tx, tz);
  if (!tile) return false;
  if (!world.isWalkable(tx, tz)) return false;
  return tile.type === TileType.GRASS || tile.type === TileType.WOODLAND || tile.type === TileType.FOREST;
}

function rotateFacingToward(fx, fz, tx, tz, maxRad) {
  const cur = Math.atan2(fx, fz);
  const want = Math.atan2(tx, tz);
  let diff = want - cur;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = Math.sign(diff) * Math.min(Math.abs(diff), maxRad);
  const a = cur + step;
  return { x: Math.sin(a), z: Math.cos(a) };
}

export class WildHorse {
  constructor(x, z) {
    this.x = x;
    this.z = z;
    this.targetX = x;
    this.targetZ = z;
    this.facingX = 0;
    this.facingZ = 1;
    this.coatPreset =
      HORSE_COAT_PRESETS[Math.floor(Math.random() * HORSE_COAT_PRESETS.length)];

    this.turnRate = 2.2 + Math.random() * 2.2;
    this.walkSpeed = 0.55 + Math.random() * 0.2;
    this.runSpeed = 1.65 + Math.random() * 0.45;
    this.idleChance = 0.55 + Math.random() * 0.20;
    this.wanderR0 = WANDER_RADIUS_MIN + Math.floor(Math.random() * 3);
    this.wanderR1 = WANDER_RADIUS_MAX;

    this.gait = 'idle';
    this._idleLeft = 0.8 + Math.random() * 1.5;
    this._retargetIn = 0.3;
    this.gallopPhase = Math.random() * Math.PI * 2;

    this.jumpT = 0;
    this._jumpCooldown = Math.random() * 3;

    /** Agent currently riding this horse, or null */
    this.rider = null;

    this.isDragged = false;
  }

  _pickTarget(world, herd = []) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);

    // 40% chance to move toward another horse — forms loose herds
    if (herd.length > 1 && Math.random() < 0.40) {
      const others = herd.filter(h => h !== this);
      const target = others[Math.floor(Math.random() * others.length)];
      const dist = Math.hypot(target.x - this.x, target.z - this.z);
      // Only flock if the other horse is not already right next to us
      if (dist > 2.5) {
        const ang = Math.atan2(target.z - this.z, target.x - this.x);
        const spread = (Math.random() - 0.5) * 2.5; // land near but not on top
        const tx = Math.floor(target.x + Math.cos(ang + spread) * 1.5);
        const tz = Math.floor(target.z + Math.sin(ang + spread) * 1.5);
        if (horseTileOk(world, tx, tz)) {
          this.targetX = tx + 0.5;
          this.targetZ = tz + 0.5;
          return;
        }
      }
    }

    const r =
      this.wanderR0 +
      Math.floor(Math.random() * (this.wanderR1 - this.wanderR0 + 1));
    for (let k = 0; k < 28; k++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = r * (0.35 + Math.random() * 0.65);
      const tx = Math.floor(cx + Math.cos(ang) * dist);
      const tz = Math.floor(cz + Math.sin(ang) * dist);
      if (horseTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
        return;
      }
    }
    this.targetX = cx + 0.3 + Math.random() * 0.4;
    this.targetZ = cz + 0.3 + Math.random() * 0.4;
  }

  _chooseGaitForDistance(dist) {
    if (dist > 6.5) this.gait = Math.random() < 0.75 ? 'run' : 'walk';
    else if (dist > 3) this.gait = Math.random() < 0.5 ? 'run' : 'walk';
    else this.gait = 'walk';
  }

  tick(delta, world, herd = []) {
    if (this.isDragged) return;
    this._retargetIn -= delta;
    this._jumpCooldown = Math.max(0, this._jumpCooldown - delta);

    const dx = this.targetX - this.x;
    const dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);
    const tx = dx / (dist || 1);
    const tz = dz / (dist || 1);

    // ── Jump arc (still moving forward along facing) ─────────────────────
    if (this.jumpT > 0) {
      this.jumpT = Math.min(1, this.jumpT + delta / JUMP_DURATION);
      if (this.jumpT >= 1) this.jumpT = 0;
      const f = rotateFacingToward(
        this.facingX,
        this.facingZ,
        tx,
        tz,
        this.turnRate * delta * 0.6,
      );
      this.facingX = f.x;
      this.facingZ = f.z;
      const spd = (this.gait === 'run' ? this.runSpeed : this.walkSpeed) * 0.82;
      const nx = this.x + this.facingX * spd * delta;
      const nz = this.z + this.facingZ * spd * delta;
      if (horseTileOk(world, Math.floor(nx), Math.floor(nz))) {
        this.x = nx;
        this.z = nz;
      }
      this.gallopPhase += delta * spd * 4;
      return;
    }

    // ── Idle at waypoint ─────────────────────────────────────────────────
    if (this.gait === 'idle') {
      this._idleLeft -= delta;
      this.gallopPhase += delta * 0.8;
      if (this._idleLeft <= 0 || this._retargetIn <= 0) {
        this._pickTarget(world, herd);
        const d = Math.hypot(this.targetX - this.x, this.targetZ - this.z);
        this._chooseGaitForDistance(d);
        this._retargetIn = RETARGET_BASE + Math.random() * 5;
        if (Math.random() < this.idleChance && d < 4) {
          this.gait = 'walk';
        }
      }
      return;
    }

    // ── Arrived or retarget ─────────────────────────────────────────────
    if (dist < REACH_DIST || this._retargetIn <= 0) {
      if (Math.random() < this.idleChance) {
        this.gait = 'idle';
        this._idleLeft = 3 + Math.random() * 7; // graze for 3–10 seconds
      } else {
        this._pickTarget(world, herd);
        const d = Math.hypot(this.targetX - this.x, this.targetZ - this.z);
        this._chooseGaitForDistance(d);
      }
      this._retargetIn = RETARGET_BASE + Math.random() * 5;
      return;
    }

    // ── Steer facing toward target, then step only forward ───────────────
    const f = rotateFacingToward(
      this.facingX,
      this.facingZ,
      tx,
      tz,
      this.turnRate * delta,
    );
    this.facingX = f.x;
    this.facingZ = f.z;

    const speed = this.gait === 'run' ? this.runSpeed : this.walkSpeed;
    const nx = this.x + this.facingX * speed * delta;
    const nz = this.z + this.facingZ * speed * delta;

    if (horseTileOk(world, Math.floor(nx), Math.floor(nz))) {
      this.x = nx;
      this.z = nz;
    } else {
      this._pickTarget(world, herd);
      this._chooseGaitForDistance(
        Math.hypot(this.targetX - this.x, this.targetZ - this.z),
      );
    }

    this.gallopPhase += delta * speed * (this.gait === 'run' ? 5.2 : 2.4);

    if (
      this._jumpCooldown <= 0 &&
      this.gait === 'run' &&
      Math.random() < 0.012 * delta * 60
    ) {
      this.jumpT = 0.001;
      this._jumpCooldown = JUMP_COOLDOWN + Math.random() * 4;
    }
  }
}
