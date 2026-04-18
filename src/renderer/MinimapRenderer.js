/**
 * MinimapRenderer — 2D canvas overlay showing terrain and agent positions.
 * Toggle with 'M' key.
 */
import { TileType } from '../simulation/World.js';

const TILE_COLOURS = {
  [TileType.DEEP_WATER]: '#1a3a5c',
  [TileType.WATER]:      '#2b6cb0',
  [TileType.BEACH]:      '#c9a96e',
  [TileType.GRASS]:      '#4a7c3f',
  [TileType.WOODLAND]:   '#2d6a2d',
  [TileType.FOREST]:     '#1a4a1a',
  [TileType.DESERT]:     '#c8a84b',
  [TileType.STONE]:      '#7a7a7a',
  [TileType.MOUNTAIN]:   '#5a5060',
};

// Max elevation in the world (mountain peaks reach ~1.5)
const MAX_ELEV = 1.5;

export class MinimapRenderer {
  constructor(world, size = 160) {
    this.world = world;
    this.size  = size;
    this.visible = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width  = size;
    this.canvas.height = size;
    this.canvas.style.cssText = `
      position: fixed;
      bottom: 60px;
      right: 12px;
      width: ${size}px;
      height: ${size}px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(0,0,0,0.5);
      image-rendering: pixelated;
      z-index: 100;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._terrainCache = null;
    this._renderTerrain();
  }

  _renderTerrain() {
    const { width, height, tiles } = this.world;
    const cellW = this.size / width;
    const cellH = this.size / height;
    const ctx   = this.ctx;

    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const tile = tiles[z][x];
        if (!tile) continue;

        const px = x * cellW, pz = z * cellH;
        const pw = Math.ceil(cellW), ph = Math.ceil(cellH);
        const elev  = tile.elevation ?? 0;
        const layer = tile.layer ?? 0;

        // Base terrain colour
        ctx.fillStyle = TILE_COLOURS[tile.type] ?? '#444';
        ctx.fillRect(px, pz, pw, ph);

        // Elevation shading: brighter white overlay for higher ground
        // Layer-1 raised platforms get an extra strong boost so they pop
        const elevNorm = Math.min(elev / MAX_ELEV, 1);
        const brightness = layer === 1
          ? 0.30 + elevNorm * 0.25   // raised platforms: noticeably lighter
          : elevNorm * 0.40;          // hills/mountains: shaded by height
        if (brightness > 0.02) {
          ctx.fillStyle = `rgba(255,255,255,${brightness.toFixed(2)})`;
          ctx.fillRect(px, pz, pw, ph);
        }

        // Snow cap: mountains above ~80% of max elevation get a pale blue-white tint
        if (tile.type === TileType.MOUNTAIN && elevNorm > 0.75) {
          const snowAlpha = ((elevNorm - 0.75) / 0.25) * 0.45;
          ctx.fillStyle = `rgba(220,230,255,${snowAlpha.toFixed(2)})`;
          ctx.fillRect(px, pz, pw, ph);
        }

        // Hillshading: simulate NW light source using elevation difference to NW neighbour
        const nw = tiles[z - 1]?.[x - 1];
        if (nw) {
          const slope = (elev - (nw.elevation ?? 0)) * 3.5;
          if (slope > 0.01) {
            // facing the light — brighten
            ctx.fillStyle = `rgba(255,255,255,${Math.min(slope, 0.35).toFixed(2)})`;
            ctx.fillRect(px, pz, pw, ph);
          } else if (slope < -0.01) {
            // in shadow — darken
            ctx.fillStyle = `rgba(0,0,0,${Math.min(-slope, 0.30).toFixed(2)})`;
            ctx.fillRect(px, pz, pw, ph);
          }
        }
      }
    }
    this._terrainCache = ctx.getImageData(0, 0, this.size, this.size);
  }

  update(agents) {
    if (!this.visible) return;
    const { width, height } = this.world;
    const cellW = this.size / width;
    const cellH = this.size / height;
    const ctx   = this.ctx;

    if (this._terrainCache) ctx.putImageData(this._terrainCache, 0, 0);

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const agent of agents) {
      if (!agent || agent.health <= 0) continue;
      ctx.beginPath();
      ctx.arc(agent.x * cellW, agent.z * cellH, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  toggle() {
    this.visible = !this.visible;
    this.canvas.style.display = this.visible ? 'block' : 'none';
  }

  destroy() {
    this.canvas.remove();
  }
}
