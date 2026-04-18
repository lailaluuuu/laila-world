import { TileType } from './World.js';

const HOP_SPEED  = 0.85;
const FLY_SPEED  = 4.0;
const REACH_DIST = 0.2;
const WANDER_RADIUS_MIN = 2;
const WANDER_RADIUS_MAX = 6;
const FLY_RADIUS_MIN    = 10;
const FLY_RADIUS_MAX    = 24;
const RETARGET_BASE     = 3;
const FLEE_RADIUS       = 5;
const FLY_HEIGHT        = 4.5;

function crowTileOk(world, tx, tz) {
  const tile = world.getTile(tx, tz);
  if (!tile) return false;
  return tile.type === TileType.GRASS     ||
         tile.type === TileType.WOODLAND  ||
         tile.type === TileType.FOREST    ||
         tile.type === TileType.MOUNTAIN;
}

function rotateFacingToward(fx, fz, tx, tz, maxRad) {
  const cur  = Math.atan2(fx, fz);
  const want = Math.atan2(tx, tz);
  let diff = want - cur;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = Math.sign(diff) * Math.min(Math.abs(diff), maxRad);
  const a = cur + step;
  return { x: Math.sin(a), z: Math.cos(a) };
}

export class Crow {
  constructor(x, z) {
    this.x = x;
    this.z = z;
    this.y = 0;          // height above terrain surface (renderer uses this)
    this.targetX = x;
    this.targetZ = z;
    this.facingX  = 0;
    this.facingZ  = 1;
    this.turnRate = 3.8 + Math.random() * 1.8;

    this.state     = 'idle';  // 'idle' | 'hopping' | 'flying'
    this.walkPhase = Math.random() * Math.PI * 2;
    this.wingPhase = Math.random() * Math.PI * 2;

    this._idleLeft   = 1.5 + Math.random() * 3;
    this._retargetIn = Math.random() * 2;
    this._flyTimer   = 18 + Math.random() * 22;
  }

  _pickGroundTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const r = WANDER_RADIUS_MIN + Math.floor(Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN + 1));
    for (let k = 0; k < 20; k++) {
      const ang  = Math.random() * Math.PI * 2;
      const dist = r * (0.3 + Math.random() * 0.7);
      const tx = Math.floor(cx + Math.cos(ang) * dist);
      const tz = Math.floor(cz + Math.sin(ang) * dist);
      if (crowTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
        return true;
      }
    }
    return false;
  }

  _pickFlyTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const r = FLY_RADIUS_MIN + Math.floor(Math.random() * (FLY_RADIUS_MAX - FLY_RADIUS_MIN + 1));
    for (let k = 0; k < 30; k++) {
      const ang  = Math.random() * Math.PI * 2;
      const dist = r * (0.5 + Math.random() * 0.5);
      const tx = Math.floor(cx + Math.cos(ang) * dist);
      const tz = Math.floor(cz + Math.sin(ang) * dist);
      if (crowTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
        return true;
      }
    }
    return false;
  }

  tick(delta, world, agents = []) {
    const spd = this.state === 'flying' ? FLY_SPEED : HOP_SPEED;
    this.walkPhase += delta * spd * 2.6;
    if (this.state === 'flying') this.wingPhase += delta * 4.5;

    // Fear check — flush from agents
    let nearestDist = Infinity;
    let nearestAx = this.x, nearestAz = this.z;
    for (const agent of agents) {
      if (!agent || agent.health <= 0) continue;
      const d = Math.hypot(agent.x - this.x, agent.z - this.z);
      if (d < nearestDist) { nearestDist = d; nearestAx = agent.x; nearestAz = agent.z; }
    }

    if (nearestDist < FLEE_RADIUS && this.state !== 'flying') {
      this.state = 'flying';
      const ang  = Math.atan2(this.z - nearestAz, this.x - nearestAx);
      const dist = FLY_RADIUS_MIN + Math.random() * (FLY_RADIUS_MAX - FLY_RADIUS_MIN);
      this.targetX = this.x + Math.cos(ang) * dist;
      this.targetZ = this.z + Math.sin(ang) * dist;
      this._flyTimer = 15 + Math.random() * 20;
    }

    // Periodically take flight even without a threat
    if (this.state !== 'flying') {
      this._flyTimer -= delta;
      if (this._flyTimer <= 0) {
        if (this._pickFlyTarget(world)) {
          this.state = 'flying';
          this._flyTimer = 15 + Math.random() * 25;
        } else {
          this._flyTimer = 5;
        }
      }
    }

    const dx   = this.targetX - this.x;
    const dz   = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);

    if (this.state === 'flying') {
      // Smooth climb to flight altitude
      this.y += (FLY_HEIGHT - this.y) * Math.min(1, delta * 2.2);

      if (dist < 0.8) {
        // Descend and land
        this.y = 0;
        this.state   = 'idle';
        this._idleLeft   = 2 + Math.random() * 4;
        this._retargetIn = RETARGET_BASE + Math.random() * 3;
      } else {
        const f = rotateFacingToward(this.facingX, this.facingZ, dx / dist, dz / dist, this.turnRate * delta);
        this.facingX = f.x;
        this.facingZ = f.z;
        this.x += this.facingX * FLY_SPEED * delta;
        this.z += this.facingZ * FLY_SPEED * delta;
      }
    } else {
      // Settle to ground
      this.y += (0 - this.y) * Math.min(1, delta * 4);

      if (this.state === 'idle') {
        this._idleLeft -= delta;
        if (this._idleLeft <= 0 || this._retargetIn <= 0) {
          if (this._pickGroundTarget(world)) {
            this.state = Math.random() < 0.55 ? 'hopping' : 'idle';
          }
          this._idleLeft   = 1.5 + Math.random() * 3;
          this._retargetIn = RETARGET_BASE + Math.random() * 3;
        }
        return;
      }

      // Hopping state
      this._retargetIn -= delta;
      if (dist < REACH_DIST || this._retargetIn <= 0) {
        if (Math.random() < 0.5) {
          this.state     = 'idle';
          this._idleLeft = 1 + Math.random() * 3;
        } else {
          this._pickGroundTarget(world);
          this.state = 'hopping';
        }
        this._retargetIn = RETARGET_BASE + Math.random() * 3;
        return;
      }

      const f = rotateFacingToward(this.facingX, this.facingZ, dx / dist, dz / dist, this.turnRate * delta);
      this.facingX = f.x;
      this.facingZ = f.z;

      const nx = this.x + this.facingX * HOP_SPEED * delta;
      const nz = this.z + this.facingZ * HOP_SPEED * delta;
      if (crowTileOk(world, Math.floor(nx), Math.floor(nz))) {
        this.x = nx;
        this.z = nz;
      } else {
        this._pickGroundTarget(world);
        this.state = 'hopping';
      }
    }
  }
}
