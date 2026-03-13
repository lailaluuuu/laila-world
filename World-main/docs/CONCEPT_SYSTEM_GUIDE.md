# Concept & Discovery System — Logic Guide

This guide explains how the concept/discovery system works across the World simulation: how concepts are defined, discovered, spread, and applied to agents and the world.

---

## 1. Overview

**Concepts** are technological or cultural discoveries that agents can learn. They are:

- **Discovered** — when an agent meets conditions and wins a random roll
- **Spread** — when agents socialize and teach each other
- **Applied** — they affect lifespan, movement, gathering, rest, and weather resistance

Concepts live in `data/concepts.json` and are processed by `ConceptGraph.js`. The actual gameplay effects are hardcoded in `Agent.js` and `World.js`.

---

## 2. Concept Data Structure

Each concept in `data/concepts.json` has this shape:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (e.g. `"fire"`, `"stone_tools"`) |
| `name` | string | Display name |
| `era` | number | 1 = early, 2 = advanced (display grouping) |
| `icon` | string | Emoji used in the UI |
| `description` | string | Flavor text shown in info panels |
| `prerequisites` | string[] | Concept IDs the agent must already know |
| `discovery_conditions` | object[] | Conditions that must all be true |
| `discovery_probability` | number | Base chance per game-second (before curiosity) |
| `spread_rate` | number | Chance per game-second when socializing |
| `effects` | object | Metadata; gameplay effects are hardcoded |

### Discovery Condition Types

`discovery_conditions` is an array of objects. **All** conditions must pass:

| Type | Value | Meaning |
|------|-------|---------|
| `tile_type` | `"GRASS"`, `"FOREST"`, `"STONE"`, `"WATER"`, `"MOUNTAIN"` | Agent must be standing on that tile |
| `has_concept` | concept id | Agent must already know that concept |
| `adjacent_to` | tile type | At least one orthogonally adjacent tile must be that type |

**Note:** The `population_nearby` type appears in `concepts.json` (e.g. Language) but is **not implemented** in `ConceptGraph._conditionsMet`. Concepts using it effectively have no location requirement.

---

## 3. Discovery Flow

### When Discovery Is Checked

Every game tick, each live agent calls `_tryDiscover()` in `Agent.js`, which:

1. Gets the agent’s current tile
2. Calls `conceptGraph.checkDiscovery(agent, tile, delta, world)`

### How `checkDiscovery` Works

`ConceptGraph.checkDiscovery()` iterates over all concepts in order:

1. **Skip** if the agent already knows the concept
2. **Skip** if prerequisites are not all met
3. **Skip** if discovery conditions are not met
4. **Roll** with probability: `discovery_probability × agent.curiosity × delta`
5. On success: grant the concept, push a discovery event, return the concept id

```text
P(discover) = discovery_probability × curiosity × delta
```

- `curiosity` is per-agent (0.3–0.8)

**Natural discovery (Fire):** When lightning strikes a forest tile during a storm, that tile (and adjacent tiles) burn for ~30–45 game-seconds. Agents on or next to a burning tile have fire discovery probability **×30** — representing the observation of lightning-caused fire in nature.
- `delta` is game-seconds since last tick
- Higher curiosity and longer tick ⇒ higher chance

### After a Discovery

- Agent enters `DISCOVERING` state briefly (1.5s)
- `discoveryFlash` triggers a visual glow
- A notification is shown: *"X discovered 🔥 Fire!"*

---

## 4. Knowledge Spreading

### When Spreading Is Checked

Each agent has a `socialTimer` (~4 game-sec cooldown). While wandering, resting, or arriving, they call `_trySocialise()` which:

1. Iterates over all other live agents within 5 tiles
2. For each pair, calls `conceptGraph.trySpread(this, other, SOCIAL_COOLDOWN)`

### How `trySpread` Works

For each concept:

1. If both know it or both don’t, skip
2. One is teacher, one is learner
3. `spreadRate = concept.spread_rate × deltaTime`
4. If teacher has Language: `spreadRate × 2`
5. Roll: if `Math.random() < spreadRate`, grant concept to learner

Spread events are not shown to the player (too frequent).

---

## 5. Where Effects Are Applied

The `effects` field in `concepts.json` is descriptive. Actual logic is in code.

### Agent.js — Lifespan

```javascript
ageBonus = (fire ? 0.15 : 0) + (shelter ? 0.10 : 0) + (cooking ? 0.20 : 0) + (medicine ? 0.25 : 0)
maxAgeEffective = maxAge × (1 + ageBonus)
```

Death when `age > maxAgeEffective`.

### Agent.js — Weather Protection

Energy drain from weather is multiplied by `envMult` (from `WeatherSystem.energyDrainMult`). Concepts reduce it:

- Fire: −0.25
- Shelter: −0.35
- Clothing: −0.20
- Housing: −0.20

Formula: `envMult = max(1.0, envMult - bonus)` for each. Effects stack.

### Agent.js — Rest Recovery

While resting:

- Shelter: rest efficiency × 1.5
- Weaving: rest efficiency × 1.2 (stacks with shelter)

Energy recovers faster with these concepts.

### Agent.js — Gathering / Eating

When arriving at GRASS or FOREST in `GATHERING` state:

- Hunger gain: `0.60 × toolMult × cookMult × tile.resource`
- Stone Tools: `toolMult = 1.20`
- Metal Tools: `toolMult × 1.25`
- Fishing: `toolMult × 1.1`
- Animal Domestication: `toolMult × 1.25`
- Herding: `toolMult × 1.15`
- Hunting: `toolMult × 1.35` (only when gathering from FOREST)
- Agriculture: `toolMult × 1.35` (only when gathering from GRASS)
- Cooking: `cookMult = 1.60`
- Pottery: `cookMult × 1.15`
- Preservation: `cookMult × 1.12`

Depletion: `0.28 / toolMult` (better tools ⇒ less depletion).

### Growth mechanics

- **Agriculture:** If any living agent knows it, world carrying capacity × 1.25.
- **Community:** Reproduction cooldown × 0.82 when either parent has it.
- **Writing:** On top of Language's 2× spread, teacher with Writing gives × 1.5.
- **Curiosity Culture:** Discovery probability × 1.2 for all concepts.
- **Rope:** Rest efficiency × 1.1 (stacks with Weaving).

### Tasks (Organisation)

When agents discover **Organisation** (prerequisite: Language + Community), they adopt a task role. Tasks influence behaviour and grant small bonuses:

| Task     | Behaviour                       | Bonus                         |
|----------|----------------------------------|-------------------------------|
| Gatherer | Gathers when hunger < 0.5        | +5% gather yield               |
| Teacher  | Seeks others to share knowledge | +10% spread rate when teaching |
| Scout    | Wanders further, explores more   | +15% discovery chance          |
| Carer    | Rests when energy < 0.35        | +10% rest recovery            |

Tasks are adopted when Organisation is discovered or spread. Each agent has at most one task.

### World.js — Movement / Traversal

`canTraverse(x, z, knowledge)`:

- WATER: requires `sailing`
- MOUNTAIN: requires `mountain_climbing`
- GRASS, FOREST, STONE: always traversable

Agents plan paths with `canTraverse`; water and mountains are blocked until the right concept is known.

---

## 6. Agent Needs & States

### Needs

- **Hunger** (0–1): drains over time; refilled by gathering
- **Energy** (0–1): drains while moving; recovers when resting

### States

| State | Trigger | Behavior |
|-------|---------|----------|
| WANDERING | Default | Pick random reachable tile |
| GATHERING | Hunger < 0.25 | Move to nearest GRASS/FOREST |
| RESTING | Energy < 0.2 | Recover energy, then wander |
| SOCIALIZING | — | (Transient; used during social checks) |
| DISCOVERING | Just discovered | Brief pause, then wander |

### Reproduction

When two adults are within 3.5 tiles and both have:

- Hunger ≥ 0.4  
- Energy ≥ 0.2  
- Reproduction cooldown expired  

A child spawns between them. Birth events are queued in `ConceptGraph.birthEvents` and processed in `main.js` (spawn, add to agents, notify).

---

## 7. Event & HUD Flow

### Concept Events

- `ConceptGraph.events` holds discovery and spread events
- `main.js` calls `drainEvents()` each frame and:
  - Shows notifications for discoveries
  - Triggers flash effects at agent positions
- Spread events are consumed but not shown

### Birth Events

- `birthEvents` are drained each frame
- For each, a new agent is created near the birth position (on GRASS/FOREST)
- Notification: *"X has a child — Y"*

### Discoveries Panel

- `conceptGraph.getDiscoveredConcepts()` returns concepts with `knownCount > 0`
- UI shows icon, name, and `knownCount / alive` for each discovered concept

---

## 8. Summary Diagram

```text
┌─────────────────────────────────────────────────────────────────┐
│                      data/concepts.json                          │
│  id, name, prerequisites, discovery_conditions, spread_rate…    │
└────────────────────────────┬────────────────────────────────────┘
                             │ loaded at init
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ConceptGraph                                │
│  checkDiscovery(agent, tile, delta, world) → conceptId | null   │
│  trySpread(agentA, agentB, deltaTime)                           │
│  knownBy: conceptId → Set<agentId>                              │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│     Agent.js    │  │    World.js      │  │    main.js      │
│  age, hunger,   │  │ canTraverse()    │  │ events, births, │
│  energy, rest,  │  │ sailing → water   │  │ HUD, notify     │
│  gather effects │  │ mountain_climb   │  │                  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## 9. Adding a New Concept

1. **Add to `concepts.json`**  
   Use a unique `id`, set `prerequisites` and `discovery_conditions`.

2. **Decide discovery conditions**  
   Use `tile_type`, `has_concept`, or `adjacent_to` (avoid `population_nearby` until implemented).

3. **Add gameplay effects**  
   Update:
   - `Agent.js` — lifespan, weather, rest, gathering multipliers
   - `World.js` — new traversal requirements (e.g. another terrain type)

4. **Tune probability**  
   - `discovery_probability`: ~0.0002–0.0006 typical
   - `spread_rate`: ~0.04–0.08 typical
