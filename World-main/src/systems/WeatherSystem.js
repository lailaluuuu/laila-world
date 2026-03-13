const SEASON_WEIGHTS = {
  Spring: { CLEAR: 3, CLOUDY: 2, RAIN: 3, STORM: 1 },
  Summer: { CLEAR: 5, CLOUDY: 2, RAIN: 1, STORM: 0 },
  Autumn: { CLEAR: 2, CLOUDY: 3, RAIN: 3, STORM: 2 },
  Winter: { CLEAR: 1, CLOUDY: 2, RAIN: 2, STORM: 4 },
};

export const WEATHER_META = {
  CLEAR:  { label: '☀️ Clear',   energyMult: 1.00, sky: 0x5080a0, fog: 0.006 },
  CLOUDY: { label: '☁️ Cloudy',  energyMult: 1.05, sky: 0x607080, fog: 0.009 },
  RAIN:   { label: '🌧️ Rain',    energyMult: 1.30, sky: 0x4a5870, fog: 0.013 },
  STORM:  { label: '⛈️ Storm',   energyMult: 1.70, sky: 0x28303e, fog: 0.022 },
};

// Base temperature (°C) per season, modified by weather
const SEASON_TEMP  = { Spring: 13, Summer: 24, Autumn: 9, Winter: -5 };
const WEATHER_TEMP = { CLEAR: 4, CLOUDY: 0, RAIN: -4, STORM: -10 };

export class WeatherSystem {
  constructor() {
    this.current  = 'CLEAR';
    this._season  = 'Spring';
    this._timer   = 0;
    this._duration = 50; // game-sec until first weather change
  }

  update(delta, season) {
    this._season = season;
    this._timer += delta;
    if (this._timer >= this._duration) {
      this._timer = 0;
      this._transition(season);
    }
  }

  _transition(season) {
    const weights = SEASON_WEIGHTS[season] ?? SEASON_WEIGHTS.Spring;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [key, val] of Object.entries(weights)) {
      r -= val;
      if (r <= 0) { this.current = key; break; }
    }
    this._duration = 25 + Math.random() * 55;
  }

  /** Current temperature in °C (season base + weather modifier) */
  get temperature() {
    return (SEASON_TEMP[this._season] ?? 13) + (WEATHER_TEMP[this.current] ?? 0);
  }

  /** Temperature label with icon */
  get tempLabel() {
    const t = this.temperature;
    const icon = t <= -5 ? '❄️' : t <= 4 ? '🥶' : t <= 16 ? '🌤️' : t <= 26 ? '☀️' : '🌡️';
    return `${icon} ${t}°C`;
  }

  get meta()            { return WEATHER_META[this.current]; }
  get energyDrainMult() { return this.meta.energyMult; }
  get label()           { return this.meta.label; }
  get isRaining()       { return this.current === 'RAIN' || this.current === 'STORM'; }
  get isStorm()         { return this.current === 'STORM'; }
}
