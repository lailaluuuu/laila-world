import { TileType } from './World.js';

const REACH_DIST = 0.15;
const WANDER_RADIUS_MIN = 3;
const WANDER_RADIUS_MAX = 8;
const RETARGET_BASE = 4;
const NORMAL_SPEED = 1.2;
const BURST_SPEED = 2.5;
const BURST_DURATION = 2.5;

function foxTileOk(world, tx, tz) {
  const tile = world.getTile(tx, tz);
  if (!tile) return false;
  if (!world.isWalkable(tx, tz)) return false;
  return tile.type === TileType.GRASS ||
         tile.type === TileType.WOODLAND ||
         tile.type === TileType.FOREST;
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

const FOX_FEAR_RADIUS  = 3;
const FEAR_RISE_RATE   = 0.1;
const FEAR_DECAY_RATE  = 0.05;
const FEAR_FLEE_THRESH = 0.7;
const FEAR_CALM_THRESH = 0.2;

export class Fox {
  constructor(x, z) {
    this.x = x;
    this.z = z;
    this.targetX = x;
    this.targetZ = z;
    this.facingX = 0;
    this.facingZ = 1;

    this.turnRate = 2.8 + Math.random() * 1.8;
    this.gait = 'idle';
    this._idleLeft = 1 + Math.random() * 2;
    this._retargetIn = 0.5;
    this.walkPhase = Math.random() * Math.PI * 2;

    this.fearLevel = 0;
    this._burstTimer = 0;
    this.isStartled = false;
  }

  _pickTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const r = WANDER_RADIUS_MIN +
      Math.floor(Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN + 1));
    for (let k = 0; k < 24; k++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = r * (0.3 + Math.random() * 0.7);
      const tx = Math.floor(cx + Math.cos(ang) * dist);
      const tz = Math.floor(cz + Math.sin(ang) * dist);
      if (foxTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
        return;
      }
    }
    this.targetX = cx + 0.3 + Math.random() * 0.4;
    this.targetZ = cz + 0.3 + Math.random() * 0.4;
  }

  tick(delta, world, agents = []) {
    this.walkPhase += delta * (this.isStartled ? BURST_SPEED : NORMAL_SPEED) * 2.8;

    let nearestAgentDist = Infinity;
    let nearestAx = this.x, nearestAz = this.z;
    for (const agent of agents) {
      if (!agent || agent.health <= 0) continue;
      const d = Math.hypot(agent.x - this.x, agent.z - this.z);
      if (d < nearestAgentDist) {
        nearestAgentDist = d;
        nearestAx = agent.x;
        nearestAz = agent.z;
      }
    }

    if (nearestAgentDist < FOX_FEAR_RADIUS) {
      this.fearLevel = Math.min(1, this.fearLevel + FEAR_RISE_RATE * delta);
    } else {
      this.fearLevel = Math.max(0, this.fearLevel - FEAR_DECAY_RATE * delta);
    }

    if (this.fearLevel > FEAR_FLEE_THRESH) {
      this._burstTimer = BURST_DURATION;
      this.isStartled = true;
      const fleeAng = Math.atan2(this.z - nearestAz, this.x - nearestAx);
      const fleeDist = WANDER_RADIUS_MAX;
      const tx = Math.floor(this.x + Math.cos(fleeAng) * fleeDist);
      const tz = Math.floor(this.z + Math.sin(fleeAng) * fleeDist);
      if (foxTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
      } else {
        this._pickTarget(world);
      }
      this.gait = 'run';
      this._retargetIn = BURST_DURATION;
    } else if (this.fearLevel < FEAR_CALM_THRESH) {
      if (this.isStartled) {
        this.isStartled = false;
        this._burstTimer = 0;
        this.gait = 'walk';
      }
    } else if (this._burstTimer > 0) {
      this._burstTimer = Math.max(0, this._burstTimer - delta);
      if (this._burstTimer <= 0 && this.fearLevel < FEAR_CALM_THRESH) {
        this.isStartled = false;
        this.gait = 'walk';
      }
    }

    this._retargetIn -= delta;

    const dx = this.targetX - this.x;
    const dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);
    const tx = dx / (dist || 1);
    const tz = dz / (dist || 1);

    if (this.gait === 'idle') {
      this._idleLeft -= delta;
      if (this._idleLeft <= 0 || this._retargetIn <= 0) {
        this._pickTarget(world);
        this.gait = Math.random() < 0.6 ? 'walk' : 'idle';
        this._idleLeft = 1.5 + Math.random() * 3;
        this._retargetIn = RETARGET_BASE + Math.random() * 4;
      }
      return;
    }

    if (dist < REACH_DIST || this._retargetIn <= 0) {
      if (!this.isStartled && Math.random() < 0.45) {
        this.gait = 'idle';
        this._idleLeft = 1.5 + Math.random() * 4;
      } else {
        this._pickTarget(world);
        this.gait = this.isStartled ? 'run' : 'walk';
      }
      this._retargetIn = RETARGET_BASE + Math.random() * 4;
      return;
    }

    const f = rotateFacingToward(
      this.facingX, this.facingZ, tx, tz,
      this.turnRate * delta,
    );
    this.facingX = f.x;
    this.facingZ = f.z;

    const speed = this.isStartled ? BURST_SPEED : NORMAL_SPEED;
    const nx = this.x + this.facingX * speed * delta;
    const nz = this.z + this.facingZ * speed * delta;

    if (foxTileOk(world, Math.floor(nx), Math.floor(nz))) {
      this.x = nx;
      this.z = nz;
    } else {
      this._pickTarget(world);
      this.gait = 'walk';
    }
  }
}
