import { TileType } from './World.js';

let nextId = 1;

const AGENT_SPEED     = 0.42;  // tiles/sec — sheep amble slowly
const HUNGER_DRAIN    = 1 / 115; // full → empty in 115 game-sec
const ENERGY_DRAIN    = 1 / 200;
const ENERGY_RECOVER  = 1 / 20;
const VITALITY_DRAIN  = 1 / 400; // very slow — full → critical in ~400 game-sec
const SOCIAL_COOLDOWN = 4;      // game-sec between social checks

export const AgentState = {
  WANDERING:   'wandering',
  GATHERING:   'gathering',
  SLEEPING:    'sleeping',
  SOCIALIZING: 'socializing',
  DISCOVERING: 'discovering',
  FISHING:     'fishing',
  PERFORMING:  'performing',
};

export class Agent {
  constructor(x, z) {
    this.id = nextId++;
    this.gender = Math.random() < 0.5 ? 'female' : 'male';
    this.name = randomName();

    // Position in tile-space (fractional)
    this.x = x;
    this.z = z;
    this.targetX = x;
    this.targetZ = z;

    // Needs: 1.0 = full/satisfied, 0.0 = critical
    this.needs = { hunger: 0.8 + Math.random() * 0.2, energy: 0.8 + Math.random() * 0.2, vitality: 1.0 };

    this.state = AgentState.WANDERING;
    this.knowledge = new Set(['dairy', 'animal_domestication']);   // set of concept IDs

    this.curiosity       = 0.3 + Math.random() * 0.5;
    this.sociability     = 0.3 + Math.random() * 0.5; // tendency to seek others
    this.industriousness = 0.3 + Math.random() * 0.5; // eagerness to gather/work
    this.courage         = 0.3 + Math.random() * 0.5; // wander radius / risk-taking
    this.creativity      = 0.3 + Math.random() * 0.5; // bonus to discovery
    this.age        = 0;
    this.health     = 1.0;
    this.maxAge     = 100 + Math.random() * 80; // game-seconds (die of old age)

    this.restTimer    = 0;
    this.grazeTimer   = Math.random() * 3; // sheep pause to graze after arriving
    this.discoveryFlash = 0;  // countdown for glow effect (game-sec)
    this.socialTimer  = Math.random() * SOCIAL_COOLDOWN;

    // Reproduction: becomes eligible after maturity, then on cooldown after each birth
    this.reproductionCooldown = 8 + Math.random() * 12; // game-sec until first eligibility
    this.isAdult = false; // flips true once age >= maturity threshold

    this.selected = false;
    this.isDragged = false;
    this.facingX = 0;
    this.facingZ = 1;

    /** WildHorse this agent is currently riding, or null */
    this.mountedHorse = null;
    this._rideTimer = 0;

    /** Task role (gatherer, teacher, scout, carer) — set when Organisation is discovered */
    this.task = null;

    /** Carried items — max 4 slots, strings like 'herbs','mushrooms','berries','meat','flint','wood' */
    this.inventory = [];


    /** How often the agent re-evaluates its needs even mid-wander (game-sec) */
    this._needsCheckTimer = 2 + Math.random() * 3;
    /** Store last weatherMult so _decideAction can consider it */
    this._lastWeatherMult = 1.0;
    /** Cooldown before this agent can light another campfire (game-sec) */
    this._fireCooldown = 20 + Math.random() * 20;

    /** Throttle concept discovery checks — only run every 0.5 game-sec */
    this._discoverTimer = Math.random() * 0.5;

    /** Speech bubble: text to show above agent, or null */
    this.speechBubble = null;
    /** How many game-seconds the bubble stays visible */
    this.speechBubbleTimer = 0;

    /** How many game-seconds remain in the current performance session */
    this.performTimer = 0;

    /** Fishing session countdown (game-sec); active while state === FISHING */
    this.fishingTimer = 0;
    /** Set to true when walking to a fishing spot so _onArrival knows to start a session */
    this._fishingTrip = false;
  }

  static get TASKS() {
    return {
      gatherer: { icon: '🌾', name: 'Gatherer', gatherThreshold: 0.5, gatherBonus: 1.05 },
      teacher:  { icon: '📢', name: 'Teacher', seekSocial: true, spreadBonus: 1.1 },
      scout:    { icon: '🔭', name: 'Scout', wanderRadiusBonus: 3, discoveryBonus: 1.15 },
      carer:    { icon: '💚', name: 'Carer', restThreshold: 0.35, restBonus: 1.1 },
    };
  }

  /** Blend parent traits with small random mutation. Returns a plain object to copy onto the child. */
  static inheritTraits(parentA, parentB) {
    const blend = (a, b) => {
      const avg = (a + b) / 2;
      const mut = (Math.random() - 0.5) * 0.18;
      return Math.max(0.05, Math.min(0.95, avg + mut));
    };
    return {
      curiosity:       blend(parentA.curiosity,       parentB.curiosity),
      sociability:     blend(parentA.sociability,     parentB.sociability),
      industriousness: blend(parentA.industriousness, parentB.industriousness),
      courage:         blend(parentA.courage,         parentB.courage),
      creativity:      blend(parentA.creativity,      parentB.creativity),
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

    // ── Being dragged by the player ──────────────────────────────────────
    if (this.isDragged) return;

    // ── Horse riding: sync position to mount ──────────────────────────────
    if (this.mountedHorse) {
      if (this.mountedHorse.rider !== this) {
        // Someone cleared the horse's rider externally
        this.mountedHorse = null;
      } else {
        this.x       = this.mountedHorse.x;
        this.z       = this.mountedHorse.z;
        this.targetX = this.x;
        this.targetZ = this.z;
        this.facingX = this.mountedHorse.facingX;
        this.facingZ = this.mountedHorse.facingZ;
        this._rideTimer -= delta;
        if (this._rideTimer <= 0) this._dismount();
      }
    }

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
    if (this.knowledge.has('tree_house')) envMult = Math.max(1.0, envMult - 0.05);
    if (this.knowledge.has('temple')) envMult = Math.max(1.0, envMult - 0.04);
    if (this.knowledge.has('church')) envMult = Math.max(1.0, envMult - 0.04);

    // Drain needs — blight (set by DisasterSystem via world.disasterHungerMult) accelerates hunger
    const hungerMult = world.disasterHungerMult ?? 1.0;
    this.needs.hunger   = Math.max(0, this.needs.hunger   - HUNGER_DRAIN  * delta * hungerMult);
    this.needs.vitality = Math.max(0, this.needs.vitality - VITALITY_DRAIN * delta);
    // Medicine / herbalism slow vitality loss passively
    if (hasMedicine) {
      const vRegen = this.knowledge.has('herbalism') ? 0.0075 : 0.005;
      this.needs.vitality = Math.min(1, this.needs.vitality + vRegen * delta);
    }
    const isSleeping = this.state === AgentState.SLEEPING;
    if (!isSleeping) {
      this.needs.energy = Math.max(0, this.needs.energy - ENERGY_DRAIN * delta * envMult);
    }
    if (this.discoveryFlash > 0) this.discoveryFlash -= delta;
    if (this._fireCooldown > 0) this._fireCooldown -= delta;
    if (this.speechBubbleTimer > 0) {
      this.speechBubbleTimer -= delta;
      if (this.speechBubbleTimer <= 0) this.speechBubble = null;
    }

    // Store for use in _decideAction
    this._lastWeatherMult = envMult;

    // Fire-lighting: cold agent who knows fire will light a campfire on their tile
    if (hasFire && envMult >= 1.2 && this._fireCooldown <= 0) {
      const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
      if (tile && (tile.type === TileType.FOREST || tile.type === TileType.WOODLAND || tile.type === TileType.GRASS)) {
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
      if (this.knowledge.has('tree_house')) sleepMult *= 1.06;
      if (this.knowledge.has('temple')) sleepMult *= 1.04;
      if (this.knowledge.has('church')) sleepMult *= 1.04;
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

    // ── Fishing: sit at water's edge until the catch comes in ────────────
    if (this.state === AgentState.FISHING) {
      this.fishingTimer -= delta;
      if (this.fishingTimer <= 0) {
        let yield_ = 0.5;
        if (this.knowledge.has('stone_tools')) yield_ *= 1.2;
        if (this.knowledge.has('metal_tools')) yield_ *= 1.25;
        if (this.knowledge.has('cooking'))     yield_ *= 1.5;
        if (this.knowledge.has('pottery'))     yield_ *= 1.1;
        this.needs.hunger = Math.min(1.0, this.needs.hunger + yield_);
        this.state = AgentState.WANDERING;
        this._pickWanderTarget(world, allAgents);
      }
      this._trySocialise(delta, allAgents, conceptGraph);
      return;
    }

    // ── Performing: play music in place until the session ends ───────────
    if (this.state === AgentState.PERFORMING) {
      this.performTimer -= delta;
      if (this.performTimer <= 0) {
        this.state = AgentState.WANDERING;
        this._pickWanderTarget(world, allAgents);
      }
      // Spread knowledge faster to nearby listeners
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

    // ── Graze pause: sheep stops and grazes before moving on ─────────
    if (this.grazeTimer > 0) {
      this.grazeTimer -= delta;
      this._needsCheckTimer -= delta;
      if (this._needsCheckTimer <= 0) {
        this._needsCheckTimer = 3 + Math.random() * 4;
        this._decideAction(world, allAgents); // hunger/tiredness can cut grazing short
      }
      this._trySocialise(delta, allAgents, conceptGraph);
      return;
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
    // Fishing arrival: begin the fishing session
    if (this.state === AgentState.GATHERING && this._fishingTrip) {
      this._fishingTrip = false;
      this.state = AgentState.FISHING;
      this.fishingTimer = 3 + Math.random() * 4;
      return;
    }

    // Eating: arriving at food tile satisfies hunger
    if (this.state === AgentState.GATHERING) {
      const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
      if (tile && (tile.type === TileType.GRASS || tile.type === TileType.WOODLAND || tile.type === TileType.FOREST)) {
        let toolMult  = this.knowledge.has('stone_tools') ? 1.20 : 1.0;
        if (this.knowledge.has('metal_tools')) toolMult *= 1.25;
        if (this.knowledge.has('fishing')) toolMult *= 1.1;
        if (this.knowledge.has('animal_domestication')) toolMult *= 1.25;
        if (this.knowledge.has('herding')) toolMult *= 1.15;
        if (this.knowledge.has('hunting') && (tile.type === TileType.FOREST || tile.type === TileType.WOODLAND)) toolMult *= 1.35;
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

      // Herbs: medicine-knowers restore vitality
      if (tile && tile.herbs > 0.05 && this.knowledge.has('medicine')) {
        const healMult = this.knowledge.has('herbalism') ? 1.5 : 1.0;
        this.needs.vitality = Math.min(1, this.needs.vitality + 0.25 * healMult);
        tile.herbs = Math.max(0, tile.herbs - 0.15);
      }

      // Mushrooms: fallback food for any agent (no concept needed)
      if (tile && tile.mushrooms > 0.05) {
        this.needs.hunger = Math.min(1, this.needs.hunger + 0.20);
        tile.mushrooms = Math.max(0, tile.mushrooms - 0.12);
      }

      // Honey: agents who know honey_gathering eat from nearby bee hives
      if (this.knowledge.has('honey_gathering') && world.beeHives) {
        const nearHive = world.beeHives.some(h => Math.hypot(h.x - this.x, h.z - this.z) < 4);
        if (nearHive) {
          this.needs.hunger = Math.min(1, this.needs.hunger + 0.22);
        }
      }

      // Flint: one-time gather that boosts stone_tools discovery
      if (tile && tile.flint === 1 && !this.knowledge.has('stone_tools') && this.inventory.length < 4) {
        tile.flint = 0;
        this.inventory.push('flint');
      }

      // Pick up herbs to carry when already healthy and there's room
      if (tile && tile.herbs > 0.2 && this.knowledge.has('medicine') &&
          this.needs.vitality > 0.7 && this.inventory.length < 4) {
        this.inventory.push('herbs');
        tile.herbs = Math.max(0, tile.herbs - 0.15);
      }

      // Pick up mushrooms to carry when already fed
      if (tile && tile.mushrooms > 0.2 && this.needs.hunger > 0.65 && this.inventory.length < 4) {
        this.inventory.push('mushrooms');
        tile.mushrooms = Math.max(0, tile.mushrooms - 0.12);
      }

      // Woodcutting: fell a tree on FOREST tiles to yield a wood log
      if (tile && tile.type === TileType.FOREST &&
          this.knowledge.has('woodcutting') &&
          !tile.treeCut &&
          this.inventory.filter(i => i === 'wood').length < 2 &&
          this.inventory.length < 4 &&
          Math.random() < 0.55) {
        if (world.cutTree(tile.x, tile.z)) {
          this.inventory.push('wood');
          if (!world.woodcutEvents) world.woodcutEvents = [];
          world.woodcutEvents.push({ tx: tile.x, tz: tile.z, agentName: this.name });
        }
      }
      // Scavenge fallen branches from WOODLAND (no tree removed visually)
      if (tile && tile.type === TileType.WOODLAND &&
          this.knowledge.has('woodcutting') &&
          !this.inventory.includes('wood') &&
          this.inventory.length < 4 &&
          Math.random() < 0.35) {
        this.inventory.push('wood');
      }
    }

    // ── Charged materials: amber (forest), copper_ore (stone), lodestone (stone near mountain) ──
    if (this.inventory.length < 4 && world.chargedTiles?.size > 0) {
      const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
      if (tile) {
        const key = `${tile.x},${tile.z}`;
        const chargeData = world.chargedTiles?.get(key);

        // Amber: appears in charged forest tiles after lightning
        if (chargeData && chargeData.charge > 0.3 &&
            tile.type === TileType.FOREST &&
            world.chargedMaterials?.get(key) === 'amber' &&
            !this.inventory.includes('amber') &&
            Math.random() < 0.6) {
          this.inventory.push('amber');
          world.chargedMaterials.delete(key);
        }

        // Copper ore: appears in charged stone tiles after lightning
        if (chargeData && chargeData.charge > 0.3 &&
            tile.type === TileType.STONE &&
            world.chargedMaterials?.get(key) === 'copper_ore' &&
            this.inventory.filter(i => i === 'copper_ore').length < 1 &&
            Math.random() < 0.55) {
          this.inventory.push('copper_ore');
          world.chargedMaterials.delete(key);
        }
      }
    }

    // Lodestone: found on rare stone tiles near mountains (independent of lightning)
    if (this.inventory.length < 4 && !this.inventory.includes('lodestone') &&
        world.lodestoneDeposits?.size > 0) {
      const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
      if (tile && tile.type === TileType.STONE) {
        const key = `${tile.x},${tile.z}`;
        if (world.lodestoneDeposits.has(key) && Math.random() < 0.08) {
          this.inventory.push('lodestone');
          world.lodestoneDeposits.delete(key); // one per deposit
        }
      }
    }

    // ── Opportunistic foraging: pick up food to carry regardless of state ──
    // Agents stock up whenever they have inventory room and aren't stuffed.
    // Wandering agents have a lower chance so they don't fill up on junk mid-trip.
    const isGathering = this.state === AgentState.GATHERING;
    const forageTile = world.getTile(Math.floor(this.x), Math.floor(this.z));
    const foodInInv   = this.inventory.filter(i =>
      i === 'berries' || i === 'mushrooms' || i === 'meat' || i === 'eggs' || i === 'milk').length;

    if (forageTile && this.inventory.length < 4 && foodInInv < 3 && this.needs.hunger < 0.90) {
      const roll = Math.random();
      const chance = isGathering ? 1.0 : 0.40; // always grab during gathering, 40% while wandering

      // Berries from GRASS
      if (forageTile.type === TileType.GRASS && forageTile.resource > 0.3 &&
          this.inventory.filter(i => i === 'berries').length < 2 && roll < chance) {
        this.inventory.push('berries');
        forageTile.resource = Math.max(0, forageTile.resource - 0.10);
      }

      // Mushrooms from FOREST/WOODLAND
      if (forageTile.mushrooms > 0.2 &&
          this.inventory.filter(i => i === 'mushrooms').length < 2 && roll < chance) {
        this.inventory.push('mushrooms');
        forageTile.mushrooms = Math.max(0, forageTile.mushrooms - 0.12);
      }

      // Meat — hunters carry it back
      if ((forageTile.type === TileType.FOREST || forageTile.type === TileType.WOODLAND) &&
          this.knowledge.has('hunting') && this.needs.hunger > 0.55 &&
          this.inventory.filter(i => i === 'meat').length < 2 && roll < chance * 0.35) {
        this.inventory.push('meat');
      }
    }

    // Milk: collect from nearby cows whenever passing — any state, requires dairy
    if (this.knowledge.has('dairy') && world.cows?.length > 0 &&
        this.inventory.length < 4 && this.inventory.filter(i => i === 'milk').length < 2) {
      for (const cow of world.cows) {
        if (cow.milk < 0.5) continue;
        if (Math.hypot(cow.x - this.x, cow.z - this.z) <= 1.5) {
          cow.milk = Math.max(0, cow.milk - 0.5);
          cow.milkTimer = 30 + Math.random() * 30;
          this.inventory.push('milk');
          break;
        }
      }
    }

    // Eggs: collect from nearby nests whenever passing — any state
    if (this.knowledge.has('animal_domestication') && world.chickenNests &&
        this.inventory.length < 4 && this.inventory.filter(i => i === 'eggs').length < 2) {
      const cx = Math.floor(this.x);
      const cz = Math.floor(this.z);
      for (const [key, nest] of world.chickenNests) {
        if (nest.eggs <= 0) continue;
        const [nx, nz] = key.split(',').map(Number);
        if (Math.hypot(nx - cx, nz - cz) <= 1.5) {
          const take = this.knowledge.has('coop') ? Math.min(nest.eggs, 2) : 1;
          nest.eggs -= take;
          for (let e = 0; e < take; e++) this.inventory.push('eggs');
          break;
        }
      }
    }

    // After wandering to a spot, graze for a while before picking next target
    if (this.state === AgentState.WANDERING && Math.random() < 0.88) {
      this.grazeTimer = 4 + Math.random() * 8;
      return;
    }
    this._decideAction(world, allAgents);
  }

  _decideAction(world, allAgents = []) {
    const taskDef = this.task ? Agent.TASKS[this.task] : null;
    // Industrious agents gather sooner (higher threshold); lazy agents wait until critical
    const gatherThreshold = taskDef?.gatherThreshold ?? (0.18 + this.industriousness * 0.14);
    const restThreshold   = taskDef?.restThreshold   ?? 0.2;
    const envMult = this._lastWeatherMult ?? 1.0;

    // Critical hunger — eat from inventory first, otherwise seek food
    if (this.needs.hunger < gatherThreshold) {
      if (this.inventory.some(i => i === 'berries' || i === 'mushrooms' || i === 'meat' || i === 'eggs' || i === 'milk')) {
        this._useInventory(world); // consumes one food item immediately
        return;
      }
      this.grazeTimer = 0;
      this.state = AgentState.GATHERING;
      this._pickGatherTarget(world);
      return;
    }

    // Low energy — rest (clears any grazing)
    if (this.needs.energy < restThreshold) {
      this.grazeTimer = 0;
      this.state = AgentState.SLEEPING;
      this.restTimer = 10 + Math.random() * 8;
      return;
    }

    // Cold & exposed: proactively seek forest to discover fire, or seek shelter
    if (envMult >= 1.3 && !this.knowledge.has('fire') && !this.knowledge.has('shelter')) {
      const cx = Math.floor(this.x);
      const cz = Math.floor(this.z);
      const warmTile = world.findNearest(cx, cz, [TileType.FOREST, TileType.WOODLAND], 10);
      if (warmTile) {
        this.state = AgentState.WANDERING;
        this.targetX = warmTile.x + 0.5;
        this.targetZ = warmTile.z + 0.5;
        return;
      }
    }

    // Low vitality: use carried herbs first, otherwise seek a herb tile
    if (this.knowledge.has('medicine') && this.needs.vitality < 0.4) {
      if (this.inventory.includes('herbs')) {
        this._useInventory(world);
        return;
      }
      const target = this._pickHerbTarget(world);
      if (target) {
        this.state = AgentState.GATHERING;
        this.targetX = target.x + 0.5;
        this.targetZ = target.z + 0.5;
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

  // ── Inventory use ─────────────────────────────────────────────────────

  _useInventory(world) {
    // Eat carried food when hungry
    if (this.needs.hunger < 0.45) {
      for (const food of ['meat', 'milk', 'eggs', 'berries', 'mushrooms']) {
        const idx = this.inventory.indexOf(food);
        if (idx !== -1) {
          this.inventory.splice(idx, 1);
          const base = food === 'meat' ? 0.45 : food === 'milk' ? 0.40 : food === 'eggs' ? 0.35 : food === 'berries' ? 0.30 : 0.20;
          const cook = ((food === 'meat' || food === 'eggs') && this.knowledge.has('cooking')) ? 1.4 : 1.0;
          this.needs.hunger = Math.min(1, this.needs.hunger + base * cook);
          break;
        }
      }
    }

    // Use carried herbs to restore vitality
    if (this.needs.vitality < 0.5 && this.knowledge.has('medicine')) {
      const idx = this.inventory.indexOf('herbs');
      if (idx !== -1) {
        this.inventory.splice(idx, 1);
        const heal = this.knowledge.has('herbalism') ? 1.5 : 1.0;
        this.needs.vitality = Math.min(1, this.needs.vitality + 0.25 * heal);
      }
    }

    // Use carried wood to light a campfire on the current tile
    if (this.knowledge.has('fire') && this._fireCooldown <= 0 &&
        this._lastWeatherMult >= 1.2) {
      const idx = this.inventory.indexOf('wood');
      if (idx !== -1) {
        this.inventory.splice(idx, 1);
        this._fireCooldown = 45 + Math.random() * 30;
        if (!world.campfireEvents) world.campfireEvents = [];
        world.campfireEvents.push({ tx: Math.floor(this.x), tz: Math.floor(this.z), agentName: this.name });
      }
    }
  }

  // ── Target selection ──────────────────────────────────────────────────

  _pickWanderTarget(world, allAgents = []) {
    const taskDef = this.task ? Agent.TASKS[this.task] : null;
    const radiusBonus = taskDef?.wanderRadiusBonus ?? 0;
    let radius = 4 + Math.floor(this.curiosity * 3 + this.courage * 3) + radiusBonus;

    // Flock: sociable agents drift toward peers more often
    if (allAgents.length > 1 && Math.random() < 0.06 + this.sociability * 0.12) {
      const others = allAgents.filter(a => a !== this && a.health > 0);
      if (others.length > 0) {
        // Pick a random nearby agent to drift toward
        const nearby = others.filter(a => Math.hypot(a.x - this.x, a.z - this.z) < 12);
        const pick = nearby.length > 0 ? nearby[Math.floor(Math.random() * nearby.length)] : null;
        if (pick) {
          const ddx = pick.x - this.x;
          const ddz = pick.z - this.z;
          const dd = Math.hypot(ddx, ddz);
          if (dd > 2) {
            const step = Math.min(radius, dd * 0.5);
            const tx = Math.floor(this.x + (ddx / dd) * step);
            const tz = Math.floor(this.z + (ddz / dd) * step);
            if (world.canTraverse(tx, tz, this.knowledge)) {
              this.targetX = tx + 0.5;
              this.targetZ = tz + 0.5;
              return;
            }
          }
        }
      }
    }

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
    // Seek a cow to milk when hungry and knows dairy
    if (this.knowledge.has('dairy') && Math.random() < 0.35) {
      const cowTarget = this._pickCowTarget(world);
      if (cowTarget) {
        this.targetX = cowTarget.x;
        this.targetZ = cowTarget.z;
        return;
      }
    }
    // Seek egg nests when hungry and knows animal_domestication
    if (this.knowledge.has('animal_domestication') && Math.random() < 0.30) {
      const eggTarget = this._pickEggTarget(world);
      if (eggTarget) {
        this.targetX = eggTarget.x + 0.5;
        this.targetZ = eggTarget.z + 0.5;
        return;
      }
    }
    if (this.knowledge.has('fishing') && Math.random() < 0.45) {
      const fishTile = this._pickFishingTarget(world);
      if (fishTile) {
        this.targetX = fishTile.x + 0.5;
        this.targetZ = fishTile.z + 0.5;
        this._fishingTrip = true;
        return;
      }
    }
    this._fishingTrip = false;
    const tile = world.findNearest(cx, cz, [TileType.GRASS, TileType.WOODLAND, TileType.FOREST], 14);
    if (tile) {
      this.targetX = tile.x + 0.5;
      this.targetZ = tile.z + 0.5;
    } else {
      this._pickWanderTarget(world);
    }
  }

  _pickFishingTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const r = 10;
    let best = null;
    let bestDist = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.hypot(dx, dz);
        if (dist > r) continue;
        const tile = world.getTile(cx + dx, cz + dz);
        if (!tile) continue;
        const isBeach = tile.type === TileType.BEACH;
        const isWaterEdge = tile.type === TileType.GRASS &&
          world.hasAdjacentType(tile.x, tile.z, TileType.WATER);
        if ((isBeach || isWaterEdge) && world.canTraverse(tile.x, tile.z, this.knowledge)) {
          if (dist < bestDist) { bestDist = dist; best = tile; }
        }
      }
    }
    return best;
  }

  /** Find the nearest cow with milk available within radius 15. Returns {x,z} or null. */
  _pickCowTarget(world) {
    if (!world.cows?.length) return null;
    let best = null;
    let bestDist = Infinity;
    for (const cow of world.cows) {
      if (cow.milk < 0.5) continue;
      const dist = Math.hypot(cow.x - this.x, cow.z - this.z);
      if (dist < 15 && dist < bestDist) { bestDist = dist; best = cow; }
    }
    return best;
  }

  /** Find the nearest chicken nest with available eggs within radius 12. Returns {x,z} or null. */
  _pickEggTarget(world) {
    if (!world.chickenNests) return null;
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    let best = null;
    let bestDist = Infinity;
    for (const [key, nest] of world.chickenNests) {
      if (nest.eggs <= 0) continue;
      const [nx, nz] = key.split(',').map(Number);
      const dist = Math.hypot(nx - cx, nz - cz);
      if (dist < 12 && dist < bestDist) { bestDist = dist; best = { x: nx, z: nz }; }
    }
    return best;
  }

  /** Find nearest tile with herbs or mushrooms within radius 10. Returns the tile or null. */
  _pickHerbTarget(world) {
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const r = 10;
    let best = null;
    let bestDist = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.hypot(dx, dz);
        if (dist > r) continue;
        const tile = world.getTile(cx + dx, cz + dz);
        if (!tile) continue;
        if ((tile.herbs > 0.1) || (tile.mushrooms > 0.1)) {
          if (dist < bestDist) { bestDist = dist; best = tile; }
        }
      }
    }
    return best;
  }

  _dismount() {
    if (this.mountedHorse) {
      this.mountedHorse.rider = null;
      this.mountedHorse = null;
    }
    this._rideTimer = 0;
    this.state = AgentState.WANDERING;
  }

  // ── Concept discovery ─────────────────────────────────────────────────

  _tryDiscover(delta, world, conceptGraph, allAgents = []) {
    this._discoverTimer -= delta;
    if (this._discoverTimer > 0) return;
    this._discoverTimer = 0.5;

    const tile = world.getTile(Math.floor(this.x), Math.floor(this.z));
    if (!tile) return;

    // Hint: agents on grass who know shelter but not animal_domestication
    // occasionally wonder about the animals living nearby
    if (
      tile.type === TileType.GRASS &&
      this.knowledge.has('shelter') &&
      !this.knowledge.has('animal_domestication') &&
      !this.speechBubble &&
      Math.random() < 0.04
    ) {
      const hints = ['🐑?', '🐖?', '🐄?', '🐓?'];
      this.speechBubble = hints[Math.floor(Math.random() * hints.length)];
      this.speechBubbleTimer = 2.5;
    }

    // Hint: curious agents near charged tiles wonder about the invisible force
    if (
      world.chargedTiles?.size > 0 &&
      !this.speechBubble &&
      this.curiosity > 0.55 &&
      Math.random() < 0.06
    ) {
      const cx = Math.floor(this.x);
      const cz = Math.floor(this.z);
      const nearCharge = [...(world.chargedTiles?.entries() ?? [])].some(([key, data]) => {
        if (data.charge < 0.3) return false;
        const [kx, kz] = key.split(',').map(Number);
        return Math.hypot(kx - cx, kz - cz) < 3;
      });
      if (nearCharge) {
        const hints = ['✨?', '⚡?', '❓✨', '...?'];
        this.speechBubble = hints[Math.floor(Math.random() * hints.length)];
        this.speechBubbleTimer = 2.5;
      }
    }

    // Pass the throttle interval as effective delta so probability math stays correct
    // creativity gives a small bonus on top of curiosity
    const discovered = conceptGraph.checkDiscovery(this, tile, 0.5 * (1 + this.creativity * 0.3), world, allAgents);
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
        // Performers spread knowledge faster to nearby listeners
        const spreadMult = (this.state === AgentState.PERFORMING || other.state === AgentState.PERFORMING) ? 2.5 : 1;
        conceptGraph.trySpread(this, other, SOCIAL_COOLDOWN / spreadMult);
        // Show a speech bubble only if this agent knows language
        if (this.knowledge.has('language') && !this.speechBubble && Math.random() < 0.4) {
          this.speechBubble = '💬';
          this.speechBubbleTimer = 2.0 + Math.random();
        }
        if (dist < 3.5) this._tryReproduce(other, conceptGraph);
      }
    }
    this._tryPerform(allAgents);
  }

  // ── Music performance ─────────────────────────────────────────────────

  _tryPerform(allAgents) {
    if (!this.knowledge.has('music')) return;
    if (this.state === AgentState.PERFORMING) return;
    if (this.needs.hunger < 0.35 || this.needs.energy < 0.25) return;

    const nearby = allAgents.filter(
      a => a !== this && a.health > 0 && Math.hypot(a.x - this.x, a.z - this.z) < 5,
    );
    if (nearby.length < 1) return;

    // ~1 performance per ~80 game-seconds when near others
    if (Math.random() < 0.013) {
      this.state = AgentState.PERFORMING;
      this.performTimer = 8 + Math.random() * 10;
      this.grazeTimer = 0;
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
    conceptGraph.birthEvents.push({ x: cx, z: cz, parentName: this.name, parentA: this, parentB: other });
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
