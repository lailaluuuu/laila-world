export class TimeSystem {
  constructor() {
    this.speed = 1;
    this.paused = false;
    this.gameTime = (8 / 24) * 120; // start at 08:00 (game-seconds)
    this.dayLength = 120; // real seconds per in-game day at 1x
  }

  /** Call once per frame with real elapsed seconds. Returns game-delta to simulate. */
  update(realDelta) {
    if (this.paused) return 0;
    // Cap real delta to avoid huge jumps after tab switching
    const capped = Math.min(realDelta, 0.1);
    const gameDelta = capped * this.speed;
    this.gameTime += gameDelta;
    return gameDelta;
  }

  setSpeed(speed) {
    if (speed === 0) {
      this.paused = true;
    } else {
      this.paused = false;
      this.speed = speed;
    }
  }

  get day() {
    return Math.floor(this.gameTime / this.dayLength) + 1;
  }

  get season() {
    const dayOfYear = Math.floor(this.gameTime / this.dayLength) % 40;
    if (dayOfYear < 10) return 'Spring';
    if (dayOfYear < 20) return 'Summer';
    if (dayOfYear < 30) return 'Autumn';
    return 'Winter';
  }

  /** 0–1 over the course of one day (0=midnight, 0.25=dawn, 0.5=noon, 0.75=dusk) */
  get timeOfDay() {
    return (this.gameTime % this.dayLength) / this.dayLength;
  }
}
