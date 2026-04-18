import { TileType } from './World.js';

const REACH_DIST = 0.15;
const WANDER_RADIUS_MIN = 3;
const WANDER_RADIUS_MAX = 10;
const RETARGET_BASE = 5;
const WANDER_SPEED = 0.6;
const FLEE_SPEED = 2.2;
const FLEE_DETECT_DIST = 8;

const DEER_FEAR_RADIUS  = 8;
const FEAR_RISE_RATE    = 0.1;
const FEAR_DECAY_RATE   = 0.05;
const FEAR_FLEE_THRESH  = 0.7;
const FEAR_CALM_THRESH  = 0.2;

function deerTileOk(world, tx, tz) {
  const tile = world.getTile(tx, tz);
  if (!tile) return false;
  if (!world.isWalkable(tx, tz)) return false;
  return tile.type === TileType.GRASS || tile.type === TileType.WOODLAND;
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

export class Deer {
  constructor(x, z) {
    this.x = x;
    this.z = z;
    this.targetX = x;
    this.targetZ = z;
    this.facingX = 0;
    this.facingZ = 1;

    this.isMale = Math.random() < 0.5;
    this.turnRate = 3.0 + Math.random() * 1.5;

    this.gait = 'idle';
    this._idleLeft = 1 + Math.random() * 3;
    this._retargetIn = 0.5;
    this.walkPhase = Math.random() * Math.PI * 2;

    this.isFleeing = false;
    this.alertLevel = 0;

    this.fearLevel = 0;
  }

  _pickTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const r = WANDER_RADIUS_MIN +
      Math.floor(Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN + 1));
    for (let k = 0; k < 28; k++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = r * (0.3 + Math.random() * 0.7);
      const tx = Math.floor(cx + Math.cos(ang) * dist);
      const tz = Math.floor(cz + Math.sin(ang) * dist);
      if (deerTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
        return;
      }
    }
    this.targetX = cx + 0.3 + Math.random() * 0.4;
    this.targetZ = cz + 0.3 + Math.random() * 0.4;
  }

  tick(delta, world, agents = [], predators = []) {
    this.walkPhase += delta * (this.isFleeing ? FLEE_SPEED : WANDER_SPEED) * 2.2;

    let fleeX = 0, fleeZ = 0;
    let isThreatNear = false;

    for (const agent of agents) {
      if (!agent || agent.health <= 0) continue;
      const d = Math.hypot(agent.x - this.x, agent.z - this.z);
      if (d < FLEE_DETECT_DIST && d > 0.01) {
        const weight = 1.0 - d / FLEE_DETECT_DIST;
        fleeX += ((this.x - agent.x) / d) * weight;
        fleeZ += ((this.z - agent.z) / d) * weight;
        isThreatNear = true;
      }
    }

    for (const pred of predators) {
      if (!pred) continue;
      const d = Math.hypot(pred.x - this.x, pred.z - this.z);
      if (d < FLEE_DETECT_DIST && d > 0.01) {
        const weight = 1.5 - d / FLEE_DETECT_DIST;
        fleeX += ((this.x - pred.x) / d) * weight;
        fleeZ += ((this.z - pred.z) / d) * weight;
        isThreatNear = true;
      }
    }

    if (isThreatNear) {
      this.fearLevel = Math.min(1, this.fearLevel + FEAR_RISE_RATE * delta);
    } else {
      this.fearLevel = Math.max(0, this.fearLevel - FEAR_DECAY_RATE * delta);
    }

    const targetAlert = isThreatNear ? 1.0 : 0.0;
    this.alertLevel += (targetAlert - this.alertLevel) * Math.min(1, delta * 4);

    if (this.fearLevel > FEAR_FLEE_THRESH || isThreatNear) {
      this.isFleeing = true;
      const mag = Math.hypot(fleeX, fleeZ) || 1;
      const nx = fleeX / mag;
      const nz = fleeZ / mag;
      const fleeDist = WANDER_RADIUS_MAX;
      const fleeAng = Math.atan2(nz, nx);
      const tx = Math.floor(this.x + Math.cos(fleeAng) * fleeDist);
      const tz = Math.floor(this.z + Math.sin(fleeAng) * fleeDist);
      if (deerTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
      } else {
        this._pickTarget(world);
      }
      this.gait = 'run';
      this._retargetIn = 1.5;
    } else if (this.fearLevel < FEAR_CALM_THRESH) {
      this.isFleeing = false;
      this._retargetIn -= delta;
    } else {
      if (!this.isFleeing) this._retargetIn -= delta;
    }

    const dx = this.targetX - this.x;
    const dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);
    const tx = dx / (dist || 1);
    const tz = dz / (dist || 1);

    if (this.gait === 'idle') {
      this._idleLeft -= delta;
      if (this._idleLeft <= 0 || this._retargetIn <= 0) {
        this._pickTarget(world);
        this.gait = Math.random() < 0.5 ? 'walk' : 'idle';
        this._idleLeft = 2 + Math.random() * 5;
        this._retargetIn = RETARGET_BASE + Math.random() * 5;
      }
      return;
    }

    if (dist < REACH_DIST || (!this.isFleeing && this._retargetIn <= 0)) {
      if (!this.isFleeing && Math.random() < 0.55) {
        this.gait = 'idle';
        this._idleLeft = 2 + Math.random() * 6;
      } else {
        this._pickTarget(world);
        this.gait = this.isFleeing ? 'run' : 'walk';
      }
      this._retargetIn = RETARGET_BASE + Math.random() * 5;
      return;
    }

    const f = rotateFacingToward(
      this.facingX, this.facingZ, tx, tz,
      this.turnRate * delta,
    );
    this.facingX = f.x;
    this.facingZ = f.z;

    const speed = this.isFleeing ? FLEE_SPEED : WANDER_SPEED;
    const nx = this.x + this.facingX * speed * delta;
    const nz = this.z + this.facingZ * speed * delta;

    if (deerTileOk(world, Math.floor(nx), Math.floor(nz))) {
      this.x = nx;
      this.z = nz;
    } else {
      this._pickTarget(world);
      this.gait = 'walk';
      this.isFleeing = false;
    }
  }
}
