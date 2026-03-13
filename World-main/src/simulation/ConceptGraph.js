export class ConceptGraph {
  constructor(conceptsData) {
    /** @type {Map<string, Object>} */
    this.concepts = new Map(conceptsData.map(c => [c.id, c]));

    /** conceptId → Set of agent IDs that know it */
    this.knownBy = new Map([...this.concepts.keys()].map(id => [id, new Set()]));

    /** Events to be consumed by main.js each frame */
    this.events = [];

    /** Birth events: { x, z, parentName } */
    this.birthEvents = [];
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  /**
   * Check whether this agent can discover any concept given their current tile.
   * Returns the concept ID if a discovery occurred, otherwise null.
   */
  checkDiscovery(agent, tile, delta, world, allAgents = []) {
    for (const [id, concept] of this.concepts) {
      if (agent.knowledge.has(id)) continue;
      if (!this._prerequisitesMet(agent, concept)) continue;
      if (!this._conditionsMet(agent, tile, concept, world, allAgents)) continue;

      let prob = concept.discovery_probability * agent.curiosity * delta;
      if (agent.knowledge.has('curiosity_culture')) prob *= 1.2;
      if (agent.task === 'scout') prob *= 1.15;
      // Fire: lightning-struck forest greatly boosts discovery
      if (id === 'fire' && world.naturalFires) {
        const key = `${tile.x},${tile.z}`;
        const adj = [[0,0],[1,0],[-1,0],[0,1],[0,-1]];
        const nearFire = adj.some(([dx, dz]) =>
          world.naturalFires.has(`${tile.x + dx},${tile.z + dz}`)
        );
        if (nearFire) prob *= 30;
      }
      if (Math.random() < prob) {
        this._grant(agent, id);
        this.events.push({ type: 'discovery', agentId: agent.id, agentName: agent.name, conceptId: id });
        return id;
      }
    }
    return null;
  }

  /**
   * Attempt to spread knowledge from agent A to agent B (and vice-versa).
   * @param {number} deltaTime - effective game-seconds since last social check
   */
  trySpread(agentA, agentB, deltaTime = 5) {
    for (const [id, concept] of this.concepts) {
      const aKnows = agentA.knowledge.has(id);
      const bKnows = agentB.knowledge.has(id);
      if (aKnows === bKnows) continue; // nothing to share

      const learner  = aKnows ? agentB : agentA;
      const teacher  = aKnows ? agentA : agentB;

      // spread_rate is per game-second; scale by the time window between checks
      let spreadRate = concept.spread_rate * deltaTime;
      if (teacher.knowledge.has('language')) spreadRate *= 2;
      if (teacher.knowledge.has('writing')) spreadRate *= 1.5;
      if (teacher.task === 'teacher') spreadRate *= 1.1;

      if (Math.random() < spreadRate) {
        this._grant(learner, id);
        this.events.push({ type: 'spread', agentId: learner.id, agentName: learner.name, conceptId: id, teacherId: teacher.id });
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /**
   * @param {Set<number>} [aliveAgentIds] - If provided, knownCount only counts living agents
   */
  getDiscoveredConcepts(aliveAgentIds = null) {
    const result = [];
    for (const [id, agentIds] of this.knownBy) {
      const count = aliveAgentIds
        ? [...agentIds].filter(aid => aliveAgentIds.has(aid)).length
        : agentIds.size;
      if (count > 0) {
        result.push({ ...this.concepts.get(id), knownCount: count });
      }
    }
    return result;
  }

  agentKnows(agent, conceptId) {
    return agent.knowledge.has(conceptId);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  _grant(agent, conceptId) {
    agent.knowledge.add(conceptId);
    this.knownBy.get(conceptId)?.add(agent.id);
  }

  _prerequisitesMet(agent, concept) {
    return (concept.prerequisites ?? []).every(p => agent.knowledge.has(p));
  }

  _conditionsMet(agent, tile, concept, world, allAgents = []) {
    for (const cond of (concept.discovery_conditions ?? [])) {
      if (cond.type === 'tile_type' && tile.type !== cond.value) return false;
      if (cond.type === 'has_concept' && !agent.knowledge.has(cond.value)) return false;
      if (cond.type === 'adjacent_to' && (!world || !world.hasAdjacentType(tile.x, tile.z, cond.value))) return false;
      if (cond.type === 'population_nearby') {
        // Count live agents within 6 tiles
        const count = allAgents.filter(a =>
          a !== agent && a.health > 0 &&
          Math.hypot(a.x - agent.x, a.z - agent.z) < 6
        ).length;
        if (count < cond.value) return false;
      }
    }
    return true;
  }

  /** Drain and return all queued events since last call */
  drainEvents() {
    const evts = this.events;
    this.events = [];
    return evts;
  }

  /** Drain and return all queued birth events since last call */
  drainBirthEvents() {
    const evts = this.birthEvents;
    this.birthEvents = [];
    return evts;
  }
}
