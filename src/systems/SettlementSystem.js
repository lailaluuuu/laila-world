const SUFFIXES = ['ford', 'stead', 'haven', 'wick', 'vale', 'field', 'moor', 'ridge', 'holm', 'dale', 'mere', 'croft', 'burh', 'stow'];
const PREFIXES = ['New ', 'Old ', 'Great ', 'Little ', 'Upper ', 'Lower ', ''];

export const TIER_ICONS = { camp: '🏕️', hamlet: '🏘️', village: '🏙️' };

export class SettlementSystem {
  constructor() {
    /** @type {Array<{id,name,tier,members:Set<number>,x,z,age}>} */
    this.settlements = [];
    this._nextId = 1;
    this._checkTimer = 0;
    // How often (game-sec) we run the full cluster scan
    this._CHECK_INTERVAL = 5;
    // Radius in tiles within which agents count as clustering
    this._CLUSTER_RADIUS = 5;
    // How long (game-sec) agents must stay near each other before founding
    this._FORM_TIME = 30;
    // Pair timer: "minId,maxId" → accumulated game-seconds near each other
    this._clusterTimers = new Map();
    // Events to drain each frame
    this.events = [];
  }

  update(delta, agents) {
    const aliveIds = new Set(agents.filter(a => a.health > 0).map(a => a.id));

    // ── Remove dead members ──────────────────────────────────────────────
    for (const s of this.settlements) {
      for (const id of [...s.members]) {
        if (!aliveIds.has(id)) s.members.delete(id);
      }
    }

    // ── Disband empty settlements ────────────────────────────────────────
    for (const s of this.settlements) {
      if (s.members.size < 2) {
        this.events.push({ type: 'disbanded', settlement: s });
      }
    }
    this.settlements = this.settlements.filter(s => s.members.size >= 2);

    // ── Periodic cluster check ───────────────────────────────────────────
    this._checkTimer -= delta;
    if (this._checkTimer > 0) {
      // Still update positions/tiers every tick
      this._updateState(agents);
      return;
    }
    this._checkTimer = this._CHECK_INTERVAL;

    const alive = agents.filter(a => a.health > 0);

    // Clean stale timer keys
    for (const key of [...this._clusterTimers.keys()]) {
      const [idA, idB] = key.split(',').map(Number);
      if (!aliveIds.has(idA) || !aliveIds.has(idB)) this._clusterTimers.delete(key);
    }

    // Scan all pairs
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        const key = `${Math.min(a.id, b.id)},${Math.max(a.id, b.id)}`;

        if (dist < this._CLUSTER_RADIUS) {
          const t = (this._clusterTimers.get(key) ?? 0) + this._CHECK_INTERVAL;
          this._clusterTimers.set(key, t);

          if (t >= this._FORM_TIME) {
            this._clusterTimers.delete(key);
            const evt = this._mergeOrForm(a, b, alive);
            if (evt) this.events.push(evt);
          }
        } else {
          this._clusterTimers.delete(key);
        }
      }
    }

    this._updateState(agents);
  }

  _updateState(agents) {
    const alive = agents.filter(a => a.health > 0);
    for (const s of this.settlements) {
      const members = alive.filter(a => s.members.has(a.id));
      if (!members.length) continue;

      // Recalculate centroid
      s.x = members.reduce((sum, a) => sum + a.x, 0) / members.length;
      s.z = members.reduce((sum, a) => sum + a.z, 0) / members.length;
      s.age += this._CHECK_INTERVAL;

      // Upgrade tier
      const size = s.members.size;
      const prevTier = s.tier;
      if (size >= 10) s.tier = 'village';
      else if (size >= 5) s.tier = 'hamlet';
      else s.tier = 'camp';
      if (s.tier !== prevTier) {
        this.events.push({ type: 'tier_up', settlement: s });
      }
    }
  }

  _mergeOrForm(a, b, alive) {
    const sa = this.settlements.find(s => s.members.has(a.id));
    const sb = this.settlements.find(s => s.members.has(b.id));

    if (sa && sb) {
      if (sa === sb) return null;
      // Merge smaller into larger
      const [larger, smaller] = sa.members.size >= sb.members.size ? [sa, sb] : [sb, sa];
      for (const id of smaller.members) larger.members.add(id);
      this.settlements = this.settlements.filter(s => s !== smaller);
      return null;
    }
    if (sa) { sa.members.add(b.id); return null; }
    if (sb) { sb.members.add(a.id); return null; }

    // Found a brand-new settlement
    const settlement = {
      id: this._nextId++,
      name: this._generateName(a),
      tier: 'camp',
      members: new Set([a.id, b.id]),
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
      age: 0,
    };
    this.settlements.push(settlement);
    return { type: 'founded', settlement };
  }

  _generateName(agent) {
    const prefix = Math.random() < 0.35 ? PREFIXES[Math.floor(Math.random() * (PREFIXES.length - 1))] : '';
    const root = agent.name.slice(0, Math.min(4, agent.name.length));
    const suffix = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
    return prefix + root + suffix;
  }

  drainEvents() {
    const evts = this.events;
    this.events = [];
    return evts;
  }
}
