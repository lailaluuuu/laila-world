export const TILE_SIZE = 2;
export const WORLD_WIDTH = 32;
export const WORLD_HEIGHT = 32;

export const TileType = {
  DEEP_WATER: 'DEEP_WATER',
  WATER:    'WATER',
  GRASS:    'GRASS',
  FOREST:   'FOREST',
  STONE:    'STONE',
  MOUNTAIN: 'MOUNTAIN',
};

export class World {
  constructor(seed = Math.floor(Math.random() * 9999)) {
    this.width = WORLD_WIDTH;
    this.height = WORLD_HEIGHT;
    this.seed = seed;
    this.tiles = this._generate();
  }

  // ── Procedural generation ─────────────────────────────────────────────

  _noise(x, z) {
    const s = this.seed * 0.137;
    return (
      Math.sin(x * 0.18 + s)        * Math.cos(z * 0.14 + s * 1.71) * 0.45 +
      Math.sin(x * 0.35 + s * 2.13) * Math.cos(z * 0.29 + s * 0.63) * 0.30 +
      Math.sin(x * 0.72 + s * 0.54) * Math.cos(z * 0.61 + s * 1.23) * 0.15 +
      Math.cos(x * 0.11 + z * 0.16 + s * 1.87)                       * 0.25
    ) / 1.15;
  }

  _generate() {
    const tiles = [];
    for (let z = 0; z < this.height; z++) {
      tiles[z] = [];
      for (let x = 0; x < this.width; x++) {
        const n = this._noise(x, z);
        let type;
        if      (n < -0.22) type = TileType.WATER;
        else if (n <  0.18) type = TileType.GRASS;
        else if (n <  0.52) type = TileType.FOREST;
        else if (n <  0.72) type = TileType.STONE;
        else                type = TileType.MOUNTAIN;

        const baseElev = { WATER: 0.04, GRASS: 0.12, FOREST: 0.22, STONE: 0.32, MOUNTAIN: 1.5 }[type];
        const elev = baseElev + (Math.sin(x * 3.7 + z * 2.3 + this.seed) * 0.5 + 0.5) * 0.06;

        tiles[z][x] = { type, x, z, elevation: elev, resource: 1.0 };
      }
    }

    // Second pass: water tiles surrounded by water on all 4 sides become DEEP_WATER
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        if (tiles[z][x].type !== TileType.WATER) continue;
        const allWater = [[-1,0],[1,0],[0,-1],[0,1]].every(([dx, dz]) => {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) return true;
          const t = tiles[nz][nx].type;
          return t === TileType.WATER || t === TileType.DEEP_WATER;
        });
        if (allWater) tiles[z][x].type = TileType.DEEP_WATER;
      }
    }

    // Third pass: guarantee at least one tile of each base terrain type.
    // Uses fixed fallback positions spread around the map so every world is playable.
    const baseElevations = { WATER: 0.04, GRASS: 0.12, FOREST: 0.22, STONE: 0.32, MOUNTAIN: 1.5 };
    const present = new Set();
    for (let z = 0; z < this.height; z++)
      for (let x = 0; x < this.width; x++)
        present.add(tiles[z][x].type);

    const forcePlacements = [
      { type: TileType.WATER,    x: 2,  z: 2  },
      { type: TileType.GRASS,    x: 14, z: 14 },
      { type: TileType.FOREST,   x: 17, z: 14 },
      { type: TileType.STONE,    x: 14, z: 17 },
      { type: TileType.MOUNTAIN, x: 29, z: 29 },
    ];
    for (const { type, x, z } of forcePlacements) {
      if (!present.has(type)) {
        tiles[z][x].type = type;
        tiles[z][x].elevation = baseElevations[type];
        present.add(type);
      }
    }

    return tiles;
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getTile(x, z) {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return null;
    return this.tiles[tz][tx];
  }

  /** Base walkability: used for spawning/birth. Blocks water and mountains regardless of knowledge. */
  isWalkable(x, z) {
    const tile = this.getTile(x, z);
    return tile !== null && tile.type !== TileType.WATER && tile.type !== TileType.DEEP_WATER && tile.type !== TileType.MOUNTAIN;
  }

  /**
   * Knowledge-aware traversal check used by agent movement.
   * Sailing unlocks water, mountain_climbing unlocks mountains.
   */
  canTraverse(x, z, knowledge) {
    const tile = this.getTile(x, z);
    if (!tile) return false;
    if (tile.type === TileType.WATER || tile.type === TileType.DEEP_WATER) return knowledge.has('sailing');
    if (tile.type === TileType.MOUNTAIN) return knowledge.has('mountain_climbing');
    return true;
  }

  /** True if any of the 4 orthogonal neighbours is the given tile type */
  hasAdjacentType(x, z, type) {
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const t = this.getTile(x + dx, z + dz);
      if (t && t.type === type) return true;
    }
    return false;
  }

  /**
   * Regenerate food resources over time. Call each game-tick.
   * Faster in spring/summer, very slow in winter.
   */
  updateResources(delta, season = 'Spring') {
    const mult = { Spring: 1.5, Summer: 2.0, Autumn: 1.0, Winter: 0.35 }[season] ?? 1.0;
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[z][x];
        if (tile.type === TileType.GRASS)  tile.resource = Math.min(1, tile.resource + 0.0020 * delta * mult);
        if (tile.type === TileType.FOREST) tile.resource = Math.min(1, tile.resource + 0.0012 * delta * mult);
      }
    }
  }

  /** Returns a list of walkable spawn positions (tile centres) */
  getSpawnPoints(count) {
    const candidates = [];
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        if (this.tiles[z][x].type === TileType.GRASS) {
          candidates.push({ x: x + 0.5, z: z + 0.5 });
        }
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, count);
  }

  /** Estimated carrying capacity from food-producing tiles (GRASS + FOREST). No upper cap — apply max in main.js. */
  getCarryingCapacity() {
    const foodTiles = this.getTilesOfType([TileType.GRASS, TileType.FOREST]).length;
    return Math.max(40, Math.floor(25 + foodTiles * 0.18));
  }

  /** Returns all tiles of the given type(s). Types can be string or array. */
  getTilesOfType(types) {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    const out = [];
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[z][x];
        if (typeSet.has(tile.type)) out.push(tile);
      }
    }
    return out;
  }

  /** Find nearest tile of a given type within radius, from tile coords cx,cz.
   *  When multiple tiles tie for nearest, picks one at random to avoid biased drift. */
  findNearest(cx, cz, types, radius = 10) {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    let best = null;
    let bestDist = Infinity;
    let tieCount = 0;
    const r = Math.ceil(radius);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.hypot(dx, dz);
        if (dist > radius) continue;
        const tile = this.getTile(cx + dx, cz + dz);
        if (!tile || !typeSet.has(tile.type)) continue;
        if (dist < bestDist) {
          bestDist = dist;
          best = tile;
          tieCount = 1;
        } else if (dist === bestDist) {
          tieCount++;
          if (Math.random() < 1 / tieCount) best = tile;
        }
      }
    }
    return best;
  }
}
