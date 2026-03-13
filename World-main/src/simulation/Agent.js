import { TileType } from './World.js';

let nextId = 1;

const AGENT_SPEED     = 1.8;   // tiles/sec
const HUNGER_DRAIN    = 1 / 90; // full → empty in 90 game-sec
const ENERGY_DRAIN    = 1 / 200;
const ENERGY_RECOVER  = 1 / 20;
const SOCIAL_COOLDOWN = 4;      // game-sec between social checks

export const AgentState = {
  WANDERING:   'wandering',
  GATHERING:   'gathering',
  SLEEPING:    'sleeping',
  SOCIALIZING: 'socializing',
  DISCOVERING: 'discovering',
};

export class Agent {
  constructor(x, z) {
    this.id = nextId++;
    this.name = randomName();

    // Position in tile-space (fractional)
    this.x = x;
    this.z = z;
    this.targetX = x;
    this.targetZ = z;

    // Needs: 1.0 = full/satisfied, 0.0 = critical
    this.needs = { hunger: 0.8 + Math.random() * 0.2, energy: 0.8 + Math.random() * 0.2 };

    this.state = AgentState.WANDERING;
    this.knowledge = new Set();   // set of concept IDs

    this.curiosity  = 0.3 + Math.random() * 0.5;
    this.age        = 0;
    this.health     = 1.0;
    this.maxAge     = 60 + Math.random() * 60; // game-seconds (die of old age)

    this.restTimer    = 0;
    this.discoveryFlash = 0;  // countdown for glow effect (game-sec)
    this.socialTimer  = Math.random() * SOCIAL_COOLDOWN;

    // Reproduction: becomes eligible after maturity, then on cooldown after each birth
    this.reproductionCooldown = 8 + Math.random() * 12; // game-sec until first eligibility
    this.isAdult = false; // flips true once age >= maturity threshold

    this.selected = false;
    this.facingX = 0;
    this.facingZ = 1;

    /** Task role (gatherer, teacher, scout, carer) — set when Organisation is discovered */
    this.task = null;

    /** How often the agent re-evaluates its needs even mid-wander (game-sec) */
    this._needsCheckTimer = 2 + Math.random() * 3;
    /** Store last weatherMult so _decideAction can consider it */
    this._lastWeatherMult = 1.0;
    /** Cooldown before this agent can light another campfire (game-sec) */
    this._fireCooldown = 20 + Math.random() * 20;
  }

  static get TASKS() {
    return {
      gatherer: { icon: '🌾', name: 'Gatherer', gatherThreshold: 0.5, gatherBonus: 1.05 },
      teacher:  { icon: '📢', name: 'Teacher', seekSocial: true, spreadBonus: 1.1 },
      scout:    { icon: '🔭', name: 'Scout', wanderRadiusBonus: 3, discoveryBonus: 1.15 },
      carer:    { icon: '💚', name: 'Carer', restThreshold: 0.35, restBonus: 1.1 },
    };
  }

  _adoptTask(allAgents) {
    if (this.task || !this.knowledge.has('organisation')) return;
    const tasks = Object.keys(Agent.TASKS);
    const taken = new Set(allAgents.filter(a => a.task).map(a => a.task));
    const available = tasks.filter(t => !taken.has(t));
    const pool = available.length > 0 ? available : tasks;
    this.task = pool[Math.floor(Math.random() * pool.length)];
  }

  // ── Main tick ─────────────────────────────────────────────────────────

  tick(delta, world, allAgents, conceptGraph, weatherMult = 1.0) {
    this.age += delta;

    if (this.knowledge.has('organisation') && !this.task) this._adoptTask(allAgents);

    // Knowledge bonuses
    const hasFire    = this.knowledge.has('fire');
    const hasCooking = this.knowledge.has('cooking');
    const hasShelter = this.knowledge.has('shelter');
    const hasMedicine = this.knowledge.has('medicine');

    // Concepts extend lifespan
    const ageBonus = (hasFire ? 0.15 : 0) + (hasShelter ? 0.10 : 0) + (hasCooking ? 0.20 : 0) + (hasMedicine ? 0.25 : 0);
    if (this.age > this.maxAge * (1 + ageBonus)) {
      this.health = 0;
      return; // dead of old age
    }

    // Maturity
    if (!this.isAdult && this.age >= 20) this.isAdult = true;
    if (this.reproductionCooldown > 0) this.reproductionCooldown -= delta;

    // Weather protection: fire, shelter, and clothing reduce harsh-weather energy penalty
    let envMult = weatherMult;
    if (hasFire)    envMult = Math.max(1.0, envMult - 0.25);
    if (hasShelter) envMult = Math.max(1.0, envMult - 0.35);
    if (this.knowledge.has('clothing')) envMult = Math.max(1.0, envMult - 0.20);
    if (this.knowledge.has('housing')) envMult = Math.max(1.0, envMult - 0.20);

    // Drain needs
    this.needs.hunger = Math.max(0, this.needs.hunger - HUNGER_DRAIN * delta);
    const isSleeping = this.state === AgentState.SLEEPING;
    if (!isSleeping) {
      this.needs.energy = Math.max(0, this.needs.energy - ENERGY_DRAIN * delta * envMult);
    }
    if (this.discoveryFlash > 0) this.discoveryFlash -= delta;
    if (this._fireCooldown > 0) this._fireCooldown -= delta;

    // Store for use in _decideAction
    this._lastWeatherMult = envMult;

    // Fire-lighting: cold agent who knows fire will light a campfire on their tile
    if (hasFire && envMult >= 1.2 && this._fireCooldown <= 0) {
      const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
      if (tile && (tile.type === TileType.FOREST || tile.type === TileType.GRASS)) {
        this._fireCooldown = 45 + Math.random() * 30;
        // Emit a campfire event to be consumed by main.js
        if (!world.campfireEvents) world.campfireEvents = [];
        world.campfireEvents.push({ tx: tile.x, tz: tile.z, agentName: this.name });
      }
    }

    // ── Sleeping: recover energy, then resume ────────────────────────────────
    if (this.state === AgentState.SLEEPING) {
      let sleepMult = hasShelter ? 1.6 : 1.0;
      if (this.knowledge.has('weaving')) sleepMult *= 1.25;
      if (this.knowledge.has('rope')) sleepMult *= 1.1;
      if (this.knowledge.has('housing')) sleepMult *= 1.15;
      const taskRestBonus = this.task && Agent.TASKS[this.task]?.restBonus ? Agent.TASKS[this.task].restBonus : 1.0;
      sleepMult *= taskRestBonus;
      this.needs.energy = Math.min(1, this.needs.energy + ENERGY_RECOVER * delta * 1.4 * sleepMult);
      this.restTimer -= delta;
      if (this.restTimer <= 0) {
        this.state = AgentState.WANDERING;
        this._pickWanderTarget(world, allAgents);
      }
      this._trySocialise(delta, allAgents, conceptGraph);
      return;
    }

    // ── Periodic needs re-evaluation (even mid-wander) ────────────────
    this._needsCheckTimer -= delta;
    if (this._needsCheckTimer <= 0) {
      this._needsCheckTimer = 3 + Math.random() * 4;
      if (this.state === AgentState.WANDERING || this.state === AgentState.DISCOVERING) {
        this._decideAction(world, allAgents);
      }
    }

    // ── Move toward target ────────────────────────────────────────────
    const dx = this.targetX - this.x;
    const dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 0.04) {
      const move = Math.min(AGENT_SPEED * delta, dist);
      const newX = this.x + (dx / dist) * move;
      const newZ = this.z + (dz / dist) * move;
      if (world.canTraverse(Math.floor(newX), Math.floor(newZ), this.knowledge)) {
        this.x = newX;
        this.z = newZ;
        this.facingX = dx / dist;
        this.facingZ = dz / dist;
      } else {
        // Blocked — pick a new reachable target
        this._pickWanderTarget(world);
      }
    } else {
      this.x = this.targetX;
      this.z = this.targetZ;
      this._onArrival(world, allAgents, conceptGraph);
    }

    // ── Continuous checks ──────────────────────────────────────────────
    this._tryDiscover(delta, world, conceptGraph, allAgents);
    this._trySocialise(delta, allAgents, conceptGraph);
  }

  // ── Arrival: decide next action ───────────────────────────────────────

  _onArrival(world, allAgents, conceptGraph) {
    if (!allAgents) allAgents = [];
    // Eating: arriving at food tile satisfies hunger
    if (this.state === AgentState.GATHERING) {
      const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
      if (tile && (tile.type === TileType.GRASS || tile.type === TileType.FOREST)) {
        let toolMult  = this.knowledge.has('stone_tools') ? 1.20 : 1.0;
        if (this.knowledge.has('metal_tools')) toolMult *= 1.25;
        if (this.knowledge.has('fishing')) toolMult *= 1.1;
        if (this.knowledge.has('animal_domestication')) toolMult *= 1.25;
        if (this.knowledge.has('herding')) toolMult *= 1.15;
        if (this.knowledge.has('hunting') && tile.type === TileType.FOREST) toolMult *= 1.35;
        if (this.knowledge.has('agriculture') && tile.type === TileType.GRASS) toolMult *= 1.35;
        let cookMult  = this.knowledge.has('cooking') ? 1.60 : 1.0;
        if (this.knowledge.has('pottery')) cookMult *= 1.15;
        if (this.knowledge.has('preservation')) cookMult *= 1.12;
        const taskGatherBonus = this.task && Agent.TASKS[this.task]?.gatherBonus ? Agent.TASKS[this.task].gatherBonus : 1.0;
        const yield_    = Math.max(0.15, tile.resource); // at least 15% even when almost depleted
        this.needs.hunger = Math.min(1.0, this.needs.hunger + 0.60 * toolMult * cookMult * taskGatherBonus * yield_);
        // Deplete the tile (better tools = more careful harvesting = less depletion)
        tile.resource = Math.max(0, tile.resource - 0.28 / toolMult);
      }
    }
    this._decideAction(world, allAgents);
  }

  _decideAction(world, allAgents = []) {
    const taskDef = this.task ? Agent.TASKS[this.task] : null;
    const gatherThreshold = taskDef?.gatherThreshold ?? 0.25;
    const restThreshold   = taskDef?.restThreshold   ?? 0.2;
    const envMult = this._lastWeatherMult ?? 1.0;

    // Critical hunger — immediately seek food
    if (this.needs.hunger < gatherThreshold) {
      this.state = AgentState.GATHERING;
      this._pickGatherTarget(world);
      return;
    }

    // Low energy — rest
    if (this.needs.energy < restThreshold) {
      this.state = AgentState.SLEEPING;
      this.restTimer = 10 + Math.random() * 8;
      return;
    }

    // Cold & exposed: proactively seek forest to discover fire, or seek shelter
    if (envMult >= 1.3 && !this.knowledge.has('fire') && !this.knowledge.has('shelter')) {
      const cx = Math.floor(this.x);
      const cz = Math.floor(this.z);
      const warmTile = world.findNearest(cx, cz, [TileType.FOREST], 10);
      if (warmTile) {
        this.state = AgentState.WANDERING;
        this.targetX = warmTile.x + 0.5;
        this.targetZ = warmTile.z + 0.5;
        return;
      }
    }

    // Moderate hunger: gatherers proactively seek food even before critical
    if (this.task === 'gatherer' && this.needs.hunger < 0.55) {
      this.state = AgentState.GATHERING;
      this._pickGatherTarget(world);
      return;
    }

    this.state = AgentState.WANDERING;
    this._pickWanderTarget(world, allAgents);
  }

  // ── Target selection ──────────────────────────────────────────────────

  _pickWanderTarget(world, allAgents = []) {
    const taskDef = this.task ? Agent.TASKS[this.task] : null;
    const radiusBonus = taskDef?.wanderRadiusBonus ?? 0;
    let radius = 4 + Math.floor(this.curiosity * 4) + radiusBonus;

    // Teacher: bias toward other agents to share knowledge
    if (taskDef?.seekSocial && allAgents.length > 1) {
      const others = allAgents.filter(a => a !== this && a.health > 0);
      if (others.length > 0 && Math.random() < 0.6) {
        const nearest = others.reduce((best, a) => {
          const d = Math.hypot(a.x - this.x, a.z - this.z);
          return d < best.d ? { a, d } : best;
        }, { a: others[0], d: Infinity });
        const dx = nearest.a.x - this.x;
        const dz = nearest.a.z - this.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 2) {
          const step = Math.min(radius, dist * 0.6);
          const tx = Math.floor(this.x + (dx / dist) * step);
          const tz = Math.floor(this.z + (dz / dist) * step);
          if (world.canTraverse(tx, tz, this.knowledge)) {
            this.targetX = tx + 0.5;
            this.targetZ = tz + 0.5;
            return;
          }
        }
      }
    }

    for (let attempt = 0; attempt < 25; attempt++) {
      const tx = Math.floor(this.x) + Math.floor(Math.random() * radius * 2 + 1) - radius;
      const tz = Math.floor(this.z) + Math.floor(Math.random() * radius * 2 + 1) - radius;
      if (world.canTraverse(tx, tz, this.knowledge)) {
        this.targetX = tx + 0.5;
        this.targetZ = tz + 0.5;
        return;
      }
    }
    this.targetX = this.x;
    this.targetZ = this.z;
  }

  _pickGatherTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const tile = world.findNearest(cx, cz, [TileType.GRASS, TileType.FOREST], 8);
    if (tile) {
      this.targetX = tile.x + 0.5;
      this.targetZ = tile.z + 0.5;
    } else {
      this._pickWanderTarget(world);
    }
  }

  // ── Concept discovery ─────────────────────────────────────────────────

  _tryDiscover(delta, world, conceptGraph, allAgents = []) {
    const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
    if (!tile) return;

    const discovered = conceptGraph.checkDiscovery(this, tile, delta, world, allAgents);
    if (discovered) {
      this.state = AgentState.DISCOVERING;
      this.discoveryFlash = 1.5;
      setTimeout(() => {
        if (this.state === AgentState.DISCOVERING) this.state = AgentState.WANDERING;
      }, 1500);
    }
  }

  // ── Social / knowledge spreading ─────────────────────────────────────

  _trySocialise(delta, allAgents, conceptGraph) {
    this.socialTimer -= delta;
    if (this.socialTimer > 0) return;
    this.socialTimer = SOCIAL_COOLDOWN + Math.random() * 2;

    for (const other of allAgents) {
      if (other === this || other.health <= 0) continue;
      const dist = Math.hypot(this.x - other.x, this.z - other.z);
      if (dist < 5.0) {
        conceptGraph.trySpread(this, other, SOCIAL_COOLDOWN);
        if (dist < 3.5) this._tryReproduce(other, conceptGraph);
      }
    }
  }

  // ── Reproduction ──────────────────────────────────────────────────────

  _tryReproduce(other, conceptGraph) {
    if (!this.isAdult || !other.isAdult) return;
    if (this.reproductionCooldown > 0 || other.reproductionCooldown > 0) return;
    if (this.needs.hunger < 0.40 || other.needs.hunger < 0.40) return;
    if (this.needs.energy < 0.20 || other.needs.energy < 0.20) return;

    const baseCooldown = 18 + Math.random() * 20;
    const communityMult = (this.knowledge.has('community') || other.knowledge.has('community')) ? 0.82 : 1.0;
    const cooldown = baseCooldown * communityMult;
    this.reproductionCooldown  = cooldown;
    other.reproductionCooldown = cooldown;

    // Child spawns between parents, slightly randomised
    const cx = (this.x + other.x) / 2 + (Math.random() - 0.5) * 1.5;
    const cz = (this.z + other.z) / 2 + (Math.random() - 0.5) * 1.5;
    conceptGraph.birthEvents.push({ x: cx, z: cz, parentName: this.name });
  }
}

// ── Name generator ────────────────────────────────────────────────────────

const SYLLABLES = ['ar','el','or','an','en','am','ul','in','er','om','al','ir','un','ae'];
function randomName() {
  const len = 2 + Math.floor(Math.random() * 2);
  let name = '';
  for (let i = 0; i < len; i++) {
    name += SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}
