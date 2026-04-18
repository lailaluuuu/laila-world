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
  [TileType.MOUNTAIN]:   '#4a4a4a',
};

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
        ctx.fillStyle = TILE_COLOURS[tile.type] ?? '#444';
        ctx.fillRect(x * cellW, z * cellH, Math.ceil(cellW), Math.ceil(cellH));
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
