const DISASTERS = [
  {
    type: 'drought',
    name: 'Drought',
    icon: '🌵',
    description: 'The rains have stopped. The land dries out and food grows scarce.',
    duration: 60,
    resourceRegenMult: 0.2,
  },
  {
    type: 'blight',
    name: 'Blight',
    icon: '🍄',
    description: 'A creeping rot spreads through the harvest. Hunger strikes faster.',
    duration: 45,
    hungerDrainMult: 1.6,
  },
  {
    type: 'flood',
    name: 'Flood',
    icon: '🌊',
    description: 'Rising waters flood the coast. The beaches are submerged.',
    duration: 35,
    floodsBeach: true,
  },
];

export class DisasterSystem {
  constructor() {
    /** Current active disaster, or null */
    this.active = null;
    /** Game-seconds until next disaster check */
    this._timer = 80 + Math.random() * 80;
    this.events = [];
  }

  update(delta, gameTime) {
    if (this.active) {
      if (gameTime >= this.active.endGameTime) {
        const ended = this.active;
        this.active = null;
        this.events.push({ type: 'end', disaster: ended });
      }
      return;
    }

    this._timer -= delta;
    if (this._timer > 0) return;
    this._timer = 120 + Math.random() * 160;

    if (Math.random() > 0.30) return; // 30% chance when timer fires

    const chosen = DISASTERS[Math.floor(Math.random() * DISASTERS.length)];
    this.active = { ...chosen, endGameTime: gameTime + chosen.duration };
    this.events.push({ type: 'start', disaster: this.active });
  }

  /** Resource regeneration multiplier (drought: 0.2, else 1.0) */
  get resourceRegenMult() {
    return this.active?.type === 'drought' ? (this.active.resourceRegenMult ?? 0.2) : 1.0;
  }

  /** Hunger drain multiplier (blight: 2.2, else 1.0) */
  get hungerDrainMult() {
    return this.active?.type === 'blight' ? (this.active.hungerDrainMult ?? 2.2) : 1.0;
  }

  /** True when beaches are flooded and impassable */
  get isFloodActive() {
    return this.active?.type === 'flood';
  }

  /** Fraction of disaster elapsed (0–1), or 0 if none active */
  progressFraction(gameTime) {
    if (!this.active) return 0;
    const total = this.active.duration;
    const elapsed = gameTime - (this.active.endGameTime - total);
    return Math.max(0, Math.min(1, elapsed / total));
  }

  drainEvents() {
    const evts = this.events;
    this.events = [];
    return evts;
  }
}
