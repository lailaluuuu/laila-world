import { TileType } from './World.js';

const SPEED = 2.05; // tiles per game-second (gallop pace)
const REACH_DIST = 0.12;
const WANDER_RADIUS_MIN = 4;
const WANDER_RADIUS_MAX = 8;
const RETARGET_INTERVAL = 6; // game-seconds between wander retargets (plus jitter in tick)

function horseTileOk(world, tx, tz) {
  const tile = world.getTile(tx, tz);
  if (!tile) return false;
  if (!world.isWalkable(tx, tz)) return false;
  return tile.type === TileType.GRASS || tile.type === TileType.FOREST;
}

export class WildHorse {
  constructor(x, z) {
    this.x = x;
    this.z = z;
    this.targetX = x;
    this.targetZ = z;
    this.facingX = 0;
    this.facingZ = 1;
    this._retargetIn = 0.5 + Math.random() * 2;
    /** Accumulated for gallop animation (renderer reads) */
    this.gallopPhase = Math.random() * Math.PI * 2;
  }

  _pickTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const r =
      WANDER_RADIUS_MIN +
      Math.floor(Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN + 1));
    const attempts = 24;
    for (let k = 0; k < attempts; k++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = r * (0.4 + Math.random() * 0.6);
      const tx = Math.floor(cx + Math.cos(ang) * dist);
      const tz = Math.floor(cz + Math.sin(ang) * dist);
      if (horseTileOk(world, tx, tz)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
        return;
      }
    }
    // Fallback: tiny jitter on current tile
    this.targetX = cx + 0.3 + Math.random() * 0.4;
    this.targetZ = cz + 0.3 + Math.random() * 0.4;
  }

  tick(delta, world) {
    this._retargetIn -= delta;
    const dx = this.targetX - this.x;
    const dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);

    if (dist < REACH_DIST || this._retargetIn <= 0) {
      this._pickTarget(world);
      this._retargetIn = RETARGET_INTERVAL + Math.random() * 4;
      return;
    }

    // Gallop cycle stays in sync with distance travelled
    this.gallopPhase += delta * SPEED * 1.15;

    const step = SPEED * delta;
    const nx = this.x + (dx / dist) * Math.min(step, dist);
    const nz = this.z + (dz / dist) * Math.min(step, dist);
    const tx = Math.floor(nx);
    const tz = Math.floor(nz);
    if (horseTileOk(world, tx, tz)) {
      this.x = nx;
      this.z = nz;
      this.facingX = dx / dist;
      this.facingZ = dz / dist;
    } else {
      this._pickTarget(world);
      this._retargetIn = 1 + Math.random() * 2;
    }
  }
}
