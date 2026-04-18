export const TILE_SIZE = 2;
export const WORLD_WIDTH = 64;
export const WORLD_HEIGHT = 64;

export const TileType = {
  DEEP_WATER: 'DEEP_WATER',
  WATER:    'WATER',
  BEACH:    'BEACH',
  GRASS:    'GRASS',
  WOODLAND: 'WOODLAND',
  FOREST:   'FOREST',
  DESERT:   'DESERT',
  STONE:    'STONE',
  MOUNTAIN: 'MOUNTAIN',
};

export class World {
  constructor(seed = Math.floor(Math.random() * 9999)) {
    this.width = WORLD_WIDTH;
    this.height = WORLD_HEIGHT;
    this.seed = seed;
    this.tiles = this._generate();
    this._generateElevatedPlatforms();
    this.glacierData = this._initGlaciers();
    /** Array of {fromX, fromZ, toX, toZ} — tile pairs connected by a ladder */
    this.ladders = [];
    /** Array of {x, z} — water tiles that have been bridged and are now passable on foot */
    this.bridges = [];
    /** "x,z" → { countdown: gameSeconds } for felled trees awaiting regrowth */
    this.cutTrees = new Map();
    /** "x,z" → { eggs: number, layTimer: gameSeconds } — populated by TerrainRenderer */
    this.chickenNests = null;
    /** Array of { x, z, milk, milkTimer } — populated by HighlandCowRenderer, positions updated each frame */
    this.cows = [];
    /** "x,z" → { charge: 0.0–1.0, timer: gameSeconds } — electrically charged tiles after lightning */
    this.chargedTiles = new Map();
    /** "x,z" → 'amber' | 'copper_ore' — rare materials that spawn after lightning strikes */
    this.chargedMaterials = new Map();
    /** Set of "x,z" keys where lodestone deposits exist (rare stone tiles near mountains) */
    this.lodestoneDeposits = this._initLodestoneDeposits();
  }

  /**
   * Mark a forest/woodland tile as felled. Returns true if the cut was registered.
   * Regrowth takes 90–150 game-seconds (slow — trees are a long-term resource).
   */
  cutTree(x, z) {
    const tile = this.getTile(x, z);
    if (!tile) return false;
    if (tile.type !== TileType.FOREST && tile.type !== TileType.WOODLAND) return false;
    const key = `${tile.x},${tile.z}`;
    if (this.cutTrees.has(key)) return false; // already felled
    tile.treeCut = true;
    this.cutTrees.set(key, { countdown: 90 + Math.random() * 60 });
    return true;
  }

  /** Called once by TerrainRenderer after chickens are placed. */
  initChickenNests(tiles) {
    this.chickenNests = new Map();
    for (const { x, z } of tiles) {
      this.chickenNests.set(`${x},${z}`, {
        eggs: 0,
        layTimer: 10 + Math.random() * 20, // stagger initial lay times
      });
    }
  }

  /** Tick egg-laying timers. Each nest produces up to 3 eggs, one per ~20–35 game-sec. */
  updateChickenNests(delta) {
    if (!this.chickenNests) return;
    for (const nest of this.chickenNests.values()) {
      if (nest.eggs >= 3) continue;
      nest.layTimer -= delta;
      if (nest.layTimer <= 0) {
        nest.eggs++;
        nest.layTimer = 20 + Math.random() * 15;
      }
    }
  }

  /** Tick cow milk refill timers. Each cow refills ~0.5 milk every 30–60 game-sec. */
  updateCows(delta) {
    for (const cow of this.cows) {
      if (cow.milk >= 1) continue;
      cow.milkTimer -= delta;
      if (cow.milkTimer <= 0) {
        cow.milk = Math.min(1, cow.milk + 0.5);
        cow.milkTimer = 30 + Math.random() * 30;
      }
    }
  }

  /** Electrically charge tiles within radius of a lightning strike. */
  chargeArea(tx, tz, radius = 2) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dist = Math.hypot(dx, dz);
        if (dist > radius) continue;
        const x = tx + dx, z = tz + dz;
        const tile = this.getTile(x, z);
        if (!tile) continue;
        const key = `${x},${z}`;
        const prev = this.chargedTiles.get(key);
        const charge = Math.max(prev?.charge ?? 0, 1.0 - dist / (radius + 1));
        this.chargedTiles.set(key, { charge, timer: 55 + Math.random() * 50 });
      }
    }
  }

  /** Decay charged tiles over time. Call once per game tick. */
  updateChargedTiles(delta) {
    for (const [key, data] of this.chargedTiles) {
      data.timer -= delta;
      data.charge = Math.max(0, data.charge - delta * 0.008);
      if (data.timer <= 0 || data.charge < 0.02) {
        this.chargedTiles.delete(key);
        this.chargedMaterials.delete(key); // material can no longer be found once charge fades
      }
    }
  }

  /** Initialise rare lodestone deposits on stone tiles adjacent to mountains. */
  _initLodestoneDeposits() {
    const deposits = new Set();
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        if (this.tiles[z][x].type !== TileType.STONE) continue;
        if (this._rng(x, z, 777) > 0.06) continue; // ~6% of stone tiles
        const nearMountain = [-1, 0, 1].some(dz =>
          [-1, 0, 1].some(dx => {
            if (dx === 0 && dz === 0) return false;
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) return false;
            return this.tiles[nz][nx].type === TileType.MOUNTAIN;
          })
        );
        if (nearMountain) deposits.add(`${x},${z}`);
      }
    }
    return deposits;
  }

  /** Tick regrowth countdowns. Call once per simulation step with game-time delta. */
  updateCutTrees(delta) {
    for (const [key, data] of this.cutTrees) {
      data.countdown -= delta;
      if (data.countdown <= 0) {
        this.cutTrees.delete(key);
        const [x, z] = key.split(',').map(Number);
        const tile = this.getTile(x, z);
        if (tile) tile.treeCut = false;
      }
    }
  }

  // ── Procedural generation ─────────────────────────────────────────────

  // Deterministic per-tile pseudo-random (stable across redraws)
  _rng(x, z, offset = 0) {
    return Math.sin(x * 127.1 + z * 311.7 + offset * 74.5) * 0.5 + 0.5;
  }

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
        else if (n < -0.08) type = TileType.BEACH;   // coastal strip
        else if (n <  0.18) type = TileType.GRASS;
        else if (n <  0.30) type = TileType.WOODLAND;
        else if (n <  0.52) type = TileType.FOREST;
        else if (n <  0.72) type = TileType.STONE;
        else                type = TileType.MOUNTAIN;

        // Desert: arid heat patches within flat terrain
        // Uses a large-scale secondary noise (different frequency + seed phase)
        if (type === TileType.GRASS || type === TileType.WOODLAND || type === TileType.FOREST) {
          const s = this.seed * 0.491;
          const arid = (
            Math.sin(x * 0.09 + s)        * Math.cos(z * 0.07 + s * 1.6) * 0.50 +
            Math.sin(x * 0.17 + s * 1.9)  * Math.cos(z * 0.13 + s * 0.5) * 0.30 +
            Math.cos(x * 0.05 + z * 0.08 + s * 1.2)                       * 0.20
          ) / 1.0 + 0.5; // range ≈ 0–1
          if (arid > 0.91) type = TileType.DESERT;
        }

        const baseElev = {
          WATER: 0.04, BEACH: 0.06, GRASS: 0.12, WOODLAND: 0.17, FOREST: 0.22,
          DESERT: 0.12, STONE: 0.32, MOUNTAIN: 1.5,
        }[type];
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
    const baseElevations = { WATER: 0.04, BEACH: 0.06, GRASS: 0.12, WOODLAND: 0.17, FOREST: 0.22, DESERT: 0.12, STONE: 0.32, MOUNTAIN: 1.5 };
    const present = new Set();
    for (let z = 0; z < this.height; z++)
      for (let x = 0; x < this.width; x++)
        present.add(tiles[z][x].type);

    const forcePlacements = [
      { type: TileType.WATER,    x: 2,  z: 2  },
      { type: TileType.GRASS,    x: 14, z: 14 },
      { type: TileType.WOODLAND, x: 16, z: 14 },
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

    // Fourth pass: natural resource fields (herbs, mushrooms, reeds, flint)
    const hasAdj = (tx, tz, t) => {
      for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = tx+dx, nz = tz+dz;
        if (nx<0||nx>=this.width||nz<0||nz>=this.height) continue;
        if (tiles[nz][nx].type === t) return true;
      }
      return false;
    };
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const tile = tiles[z][x];
        if (tile.type === TileType.WOODLAND) {
          if (this._rng(x, z, 301) < 0.30) tile.herbs = 1.0;
        }
        if (tile.type === TileType.FOREST) {
          if (this._rng(x, z, 301) < 0.45) tile.herbs     = 1.0;
          if (this._rng(x, z, 303) < 0.30) tile.mushrooms = 1.0;
        }
        if (tile.type === TileType.GRASS &&
            (hasAdj(x, z, TileType.WATER) || hasAdj(x, z, TileType.DEEP_WATER))) {
          if (this._rng(x, z, 302) < 0.35) tile.herbs = 1.0;
        }
        if (tile.type === TileType.STONE) {
          if (this._rng(x, z, 306) < 0.25) tile.flint = 1;
        }
      }
    }

    return tiles;
  }

  // ── Elevated Platforms ────────────────────────────────────────────────

  /**
   * Picks 6–9 clusters of STONE tiles and marks them as layer=1 (elevated).
   * Each cluster is 6–20 connected tiles, placed away from map edges and mountains.
   * Called once after _generate() completes.
   */
  _generateElevatedPlatforms() {
    const PLATFORM_COUNT = 6 + Math.floor(this._rng(this.seed % 64, 7, 200) * 4); // 6–9
    const MIN_SIZE = 6;
    const MAX_SIZE = 20;
    const EDGE_MARGIN = 4;

    // Collect candidate STONE tiles far from edges and mountains
    const candidates = [];
    for (let z = EDGE_MARGIN; z < this.height - EDGE_MARGIN; z++) {
      for (let x = EDGE_MARGIN; x < this.width - EDGE_MARGIN; x++) {
        const tile = this.tiles[z][x];
        if (tile.type !== TileType.STONE) continue;
        // Skip tiles adjacent to mountains (mountains already read as tall)
        const nearMtn = [-1, 0, 1].some(dz =>
          [-1, 0, 1].some(dx => {
            if (dx === 0 && dz === 0) return false;
            const t = this.getTile(x + dx, z + dz);
            return t && t.type === TileType.MOUNTAIN;
          })
        );
        if (!nearMtn) candidates.push({ x, z });
      }
    }

    /** Cache of elevated edge pairs, populated at end of this method */
    this._elevatedEdgesCache = null;

    if (candidates.length === 0) return;

    const used = new Set(); // "x,z" keys already assigned to a platform
    let placed = 0;

    // Shuffle candidates deterministically with seed-based sort
    candidates.sort((a, b) => this._rng(a.x, a.z, 555) - this._rng(b.x, b.z, 555));

    for (const seed of candidates) {
      if (placed >= PLATFORM_COUNT) break;
      const key = `${seed.x},${seed.z}`;
      if (used.has(key)) continue;

      // BFS flood-fill from seed, collecting connected STONE tiles not yet used
      const cluster = [];
      const queue = [seed];
      const visited = new Set([key]);

      while (queue.length > 0 && cluster.length < MAX_SIZE) {
        const { x, z } = queue.shift();
        cluster.push({ x, z });
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, nz = z + dz;
          const nk = `${nx},${nz}`;
          if (visited.has(nk) || used.has(nk)) continue;
          const t = this.getTile(nx, nz);
          if (!t || t.type !== TileType.STONE) continue;
          visited.add(nk);
          queue.push({ x: nx, z: nz });
        }
      }

      if (cluster.length < MIN_SIZE) continue;

      // Mark cluster tiles as elevated
      for (const { x, z } of cluster) {
        this.tiles[z][x].layer = 1;
        used.add(`${x},${z}`);
      }
      placed++;
    }

    // Pre-compute the edge cache so agents don't scan the full map each tick
    this._elevatedEdgesCache = null; // force rebuild on first call
  }

  // ── Glaciers ──────────────────────────────────────────────────────────

  _initGlaciers() {
    const data = new Map();
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[z][x];
        // Mountain peaks always have ice caps
        if (tile.type === TileType.MOUNTAIN) {
          data.set(`${x},${z}`, { x, z, melt: 0 });
          continue;
        }
        // Stone tiles adjacent to a mountain carry ground glaciers
        if (tile.type !== TileType.STONE) continue;
        const nearMountain = [-1, 0, 1].some(dz =>
          [-1, 0, 1].some(dx => {
            if (dx === 0 && dz === 0) return false;
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) return false;
            return this.tiles[nz][nx].type === TileType.MOUNTAIN;
          })
        );
        if (nearMountain) data.set(`${x},${z}`, { x, z, melt: 0 });
      }
    }
    return data;
  }

  /** Update glacier melt state. Positive temperature melts, negative refreezes. */
  updateGlaciers(delta, temperature) {
    const rate = (temperature / 25) * 0.00028;
    for (const g of this.glacierData.values()) {
      g.melt = Math.max(0, Math.min(1, g.melt + rate * delta));
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getTile(x, z) {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return null;
    return this.tiles[tz][tx];
  }

  /** Base walkability: used for spawning/birth. Blocks water, mountains, and elevated tiles (layer=1). */
  isWalkable(x, z) {
    const tile = this.getTile(x, z);
    if (!tile) return false;
    if (tile.type === TileType.WATER || tile.type === TileType.DEEP_WATER) return false;
    if (tile.type === TileType.MOUNTAIN) return false;
    if ((tile.layer ?? 0) === 1) return false; // elevated — only reachable via ladder
    return true;
  }

  /**
   * Knowledge-aware traversal check used by agent movement.
   * Sailing unlocks water, mountain_climbing unlocks mountains.
   * fromX/fromZ: current agent tile (optional). When provided, layer transitions
   * are only allowed if a ladder exists between the two tiles.
   */
  canTraverse(x, z, knowledge, fromX = null, fromZ = null) {
    const tile = this.getTile(x, z);
    if (!tile) return false;
    if (tile.type === TileType.WATER || tile.type === TileType.DEEP_WATER) return knowledge.has('sailing') || this.hasBridgeAt(x, z);
    if (tile.type === TileType.MOUNTAIN) return knowledge.has('mountain_climbing');
    // Flood disaster: beach tiles become submerged and impassable
    if (tile.type === TileType.BEACH && this.isBeachFlooded) return knowledge.has('sailing');
    // Layer transition: need a ladder to move between ground and elevated tiles
    if (fromX !== null && fromZ !== null) {
      const fromTile = this.getTile(fromX, fromZ);
      if (fromTile && (fromTile.layer ?? 0) !== (tile.layer ?? 0)) {
        return this.hasLadderBetween(fromX, fromZ, x, z);
      }
    }
    return true;
  }

  /** True if a ladder exists between the two given tile coordinates (bidirectional). */
  hasLadderBetween(fromX, fromZ, toX, toZ) {
    return this.ladders.some(l =>
      (l.fromX === fromX && l.fromZ === fromZ && l.toX === toX && l.toZ === toZ) ||
      (l.fromX === toX   && l.fromZ === toZ   && l.toX === fromX && l.toZ === fromZ)
    );
  }

  /** Place a new ladder between two adjacent tiles of different layers. No-op if already exists. */
  addLadder(fromX, fromZ, toX, toZ) {
    if (this.hasLadderBetween(fromX, fromZ, toX, toZ)) return false;
    this.ladders.push({ fromX, fromZ, toX, toZ });
    return true;
  }

  /** True if the given water tile has a bridge on it. */
  hasBridgeAt(x, z) {
    return this.bridges.some(b => b.x === x && b.z === z);
  }

  /** Place a bridge on a water tile, making it passable on foot. No-op if already bridged. */
  addBridge(x, z) {
    if (this.hasBridgeAt(x, z)) return false;
    this.bridges.push({ x, z });
    return true;
  }

  /**
   * Returns water tiles that make good bridge crossing points — water adjacent to land on
   * at least two opposite sides (N/S or E/W), forming a narrow strait.
   * Each entry: { waterX, waterZ, landX, landZ } where landX/landZ is the approach tile.
   */
  getBridgableWaterEdges() {
    if (this._bridgableEdgesCache) return this._bridgableEdgesCache;
    const result = [];
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[z][x];
        if (tile.type !== TileType.WATER) continue;
        if (this.hasBridgeAt(x, z)) continue;
        const N = this.getTile(x, z - 1), S = this.getTile(x, z + 1);
        const W = this.getTile(x - 1, z), E = this.getTile(x + 1, z);
        const isLand = t => t && t.type !== TileType.WATER && t.type !== TileType.DEEP_WATER && t.type !== TileType.MOUNTAIN;
        const hasNS = isLand(N) && isLand(S);
        const hasEW = isLand(W) && isLand(E);
        if (hasNS) {
          result.push({ waterX: x, waterZ: z, landX: x, landZ: z - 1 });
        } else if (hasEW) {
          result.push({ waterX: x, waterZ: z, landX: x - 1, landZ: z });
        }
      }
    }
    this._bridgableEdgesCache = result;
    return result;
  }

  /**
   * Returns all adjacent tile pairs where one tile is layer 1 and the other is layer 0.
   * Each entry: { groundX, groundZ, elevX, elevZ }
   * Result is cached since elevated platforms don't change after world generation.
   */
  getElevatedEdges() {
    if (this._elevatedEdgesCache) return this._elevatedEdgesCache;
    const edges = [];
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[z][x];
        if ((tile.layer ?? 0) !== 1) continue;
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, nz = z + dz;
          const neighbor = this.getTile(nx, nz);
          if (neighbor && (neighbor.layer ?? 0) === 0 &&
              neighbor.type !== TileType.WATER && neighbor.type !== TileType.DEEP_WATER) {
            edges.push({ groundX: nx, groundZ: nz, elevX: x, elevZ: z });
          }
        }
      }
    }
    this._elevatedEdgesCache = edges;
    return edges;
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
    const seasonMult = { Spring: 1.5, Summer: 2.0, Autumn: 1.0, Winter: 0.50 }[season] ?? 1.0;
    // Drought (set by DisasterSystem via world.disasterResourceMult) suppresses regen
    const disasterMult = this.disasterResourceMult ?? 1.0;
    const mult = seasonMult * disasterMult;
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[z][x];
        if (tile.type === TileType.GRASS)    tile.resource = Math.min(1, tile.resource + 0.0020 * delta * mult);
        if (tile.type === TileType.WOODLAND) tile.resource = Math.min(1, tile.resource + 0.0016 * delta * mult);
        if (tile.type === TileType.FOREST)   tile.resource = Math.min(1, tile.resource + 0.0012 * delta * mult);
        if (tile.herbs     !== undefined)  tile.herbs     = Math.min(1, tile.herbs     + 0.0006 * delta * mult);
        if (tile.mushrooms !== undefined)  tile.mushrooms = Math.min(1, tile.mushrooms + 0.0008 * delta * mult);
        // flint does not regenerate
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

  /** Spawn positions on GRASS or FOREST only (wild horses stay off stone/water). */
  getWildHorseSpawnPoints(count) {
    const candidates = [];
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const t = this.tiles[z][x].type;
        if (t === TileType.GRASS || t === TileType.WOODLAND || t === TileType.FOREST) {
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
    const foodTiles = this.getTilesOfType([TileType.GRASS, TileType.WOODLAND, TileType.FOREST]).length;
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
