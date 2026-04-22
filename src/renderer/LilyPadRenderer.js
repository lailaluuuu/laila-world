/**
 * LilyPadRenderer — decorative lily pads scattered on water tiles.
 *
 * Uses a seeded per-tile hash to place 0–3 pads per water tile at
 * consistent positions across sessions. Some pads carry a small flower.
 */
import * as THREE from 'three';
import { TileType, TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

// Lily pad colours — a few natural green variants
const PAD_COLORS  = [0x4a8c3f, 0x3d7a38, 0x56a048, 0x3f6e32];
const FLOWER_COLS = [0xffffff, 0xf5e8c0, 0xf4b8c8];  // white, cream, pale pink

function hash(n) {
  n = (n ^ (n >> 16)) * 0x45d9f3b;
  n = (n ^ (n >> 16)) * 0x45d9f3b;
  return (n ^ (n >> 16)) >>> 0;
}
function tileRng(tx, tz, idx) {
  return hash(hash(tx * 73856093 ^ tz * 19349663) + idx) / 0x100000000;
}

export class LilyPadRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this._group = new THREE.Group();
    scene.add(this._group);
    this._build();
  }

  _build() {
    const { world } = this;

    // Shared geometries — instancing per size/flower variant
    const PAD_SEGS = 14;
    const padGeoS  = new THREE.CircleGeometry(0.18, PAD_SEGS);   // small
    const padGeoM  = new THREE.CircleGeometry(0.26, PAD_SEGS);   // medium
    const padGeoL  = new THREE.CircleGeometry(0.34, PAD_SEGS);   // large
    const padGeos  = [padGeoS, padGeoM, padGeoL];

    // Notch: two triangles cut from the rim to make a V-gap
    // We simply use a small dark overlay to suggest the gap
    const notchGeo  = new THREE.CircleGeometry(0.04, 3);
    const flowerGeo = new THREE.CylinderGeometry(0.040, 0.030, 0.06, 7);
    const petalGeo  = new THREE.SphereGeometry(0.032, 5, 3);

    for (let tz = 0; tz < world.height; tz++) {
      for (let tx = 0; tx < world.width; tx++) {
        const tile = world.tiles?.[tz]?.[tx];
        if (!tile) continue;
        if (tile.type !== TileType.WATER && tile.type !== TileType.DEEP_WATER) continue;

        const count = Math.floor(tileRng(tx, tz, 0) * 3.5);  // 0–3 pads
        if (count === 0) continue;

        const surfY = TerrainRenderer.surfaceY(tile.type) + 0.015;

        for (let i = 0; i < count; i++) {
          const px = tx * TILE_SIZE + tileRng(tx, tz, i * 4 + 1) * TILE_SIZE * 0.88;
          const pz = tz * TILE_SIZE + tileRng(tx, tz, i * 4 + 2) * TILE_SIZE * 0.88;

          const sizeIdx = Math.floor(tileRng(tx, tz, i * 4 + 3) * 3);
          const colIdx  = Math.floor(tileRng(tx, tz, i * 4 + 4) * PAD_COLORS.length);
          const rot     = tileRng(tx, tz, i * 4 + 5) * Math.PI * 2;

          const padMat  = new THREE.MeshLambertMaterial({
            color: PAD_COLORS[colIdx],
            side: THREE.DoubleSide,
          });
          const pad = new THREE.Mesh(padGeos[sizeIdx], padMat);
          pad.rotation.x = -Math.PI / 2;
          pad.rotation.z = rot;
          pad.position.set(px, surfY, pz);
          pad.receiveShadow = true;
          this._group.add(pad);

          // Notch hint (very dark tiny circle at edge to suggest the V-cut)
          const notchMat = new THREE.MeshLambertMaterial({ color: 0x1a3a18, side: THREE.DoubleSide });
          const notch = new THREE.Mesh(notchGeo, notchMat);
          const r = [0.16, 0.23, 0.31][sizeIdx];
          notch.rotation.x = -Math.PI / 2;
          notch.position.set(px + Math.cos(rot) * r, surfY + 0.001, pz + Math.sin(rot) * r);
          this._group.add(notch);

          // ~30% chance of a flower
          if (tileRng(tx, tz, i * 4 + 6) < 0.30) {
            const fColIdx = Math.floor(tileRng(tx, tz, i * 4 + 7) * FLOWER_COLS.length);
            const fMat    = new THREE.MeshLambertMaterial({ color: FLOWER_COLS[fColIdx] });
            const yMat    = new THREE.MeshLambertMaterial({ color: 0xf5d020 });  // yellow centre

            // 4-6 petals arranged radially
            const petalCount = 4 + Math.floor(tileRng(tx, tz, i * 4 + 8) * 3);
            for (let p = 0; p < petalCount; p++) {
              const pa = (p / petalCount) * Math.PI * 2;
              const pr = 0.046;
              const petal = new THREE.Mesh(petalGeo, fMat);
              petal.position.set(px + Math.cos(pa) * pr, surfY + 0.04, pz + Math.sin(pa) * pr);
              petal.scale.set(1, 0.55, 1);
              this._group.add(petal);
            }
            // Yellow centre
            const centre = new THREE.Mesh(flowerGeo, yMat);
            centre.position.set(px, surfY + 0.05, pz);
            this._group.add(centre);
          }
        }
      }
    }
  }

  dispose() {
    this._group.traverse(obj => {
      obj.geometry?.dispose();
      obj.material?.dispose();
    });
    this.scene.remove(this._group);
  }
}
