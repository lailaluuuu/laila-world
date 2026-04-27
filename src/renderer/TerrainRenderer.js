import * as THREE from 'three';
import { TileType, TILE_SIZE } from '../simulation/World.js';

// Height grid for getHeightAt() bilinear queries — populated by _buildTerrainMesh
let _heightGrid = null, _heightNX = 0, _heightNZ = 0;

/** How far elevated (layer=1) platforms float above ground level */
export const ELEVATED_HEIGHT = 1.8;

// Visual height of each tile type (the box's Y scale)
const TILE_HEIGHT = {
  [TileType.DEEP_WATER]: 0.02,
  [TileType.WATER]:    0.05,
  [TileType.BEACH]:    0.07,
  [TileType.GRASS]:    0.14,
  [TileType.WOODLAND]: 0.17,
  [TileType.FOREST]:   0.24,
  [TileType.DESERT]:   0.14,
  [TileType.STONE]:    0.34,
  [TileType.MOUNTAIN]: 1.50,
};

// Base colours per tile type (HSL for easy variation)
const TILE_COLOR_HSL = {
  [TileType.DEEP_WATER]: [215, 80, 30],
  [TileType.WATER]:    [208, 82, 55],
  [TileType.BEACH]:    [ 46, 68, 74],  // warm sandy
  [TileType.GRASS]:    [ 94, 62, 50],
  [TileType.WOODLAND]: [112, 58, 40],
  [TileType.FOREST]:   [132, 66, 30],
  [TileType.DESERT]:   [ 38, 52, 62],  // dry tan
  [TileType.STONE]:    [ 28, 22, 62],
  [TileType.MOUNTAIN]: [215, 18, 68],
};

const GAP = 0.08; // gap between tiles

/** Rolling-hill strength per tile type for smooth terrain topology (mesh + river ribbons stay in sync). */
const TERRAIN_TOPOLOGY_HILL_AMP = {
  [TileType.DEEP_WATER]: 0,
  [TileType.WATER]:      0,
  [TileType.BEACH]:      0.04,
  [TileType.GRASS]:      0.30,
  [TileType.WOODLAND]:   0.32,
  [TileType.FOREST]:     0.26,
  [TileType.DESERT]:     0.18,
  [TileType.STONE]:      0.12,
  [TileType.MOUNTAIN]:   0,
};

/** Multi-octave smooth noise for terrain topology; range ≈ [-1, 1]. */
function terrainTopologyHillNoise(wx, wz, seed) {
  const s = seed * 0.137;
  return (
    Math.sin(wx * 0.09 + s * 1.30) * Math.cos(wz * 0.07 + s * 0.90) * 0.50 +
    Math.sin(wx * 0.18 + s * 0.60) * Math.cos(wz * 0.14 + s * 1.40) * 0.30 +
    Math.sin(wx * 0.35 + s * 1.70) * Math.cos(wz * 0.29 + s * 0.50) * 0.20
  );
}

export class TerrainRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this._meshes = []; // tracked for dispose()
    this._animatedAnimals = []; // { mesh, instances: [{baseX,baseY,baseZ,scale,rotY,seed}], config }
    this._animTime = 0;
    this._waterTimeUniforms = []; // water shader uniform sets, updated each frame
    /** "x,z" → {tMesh, fMesh, index, origT, origF} — only populated for FOREST trees */
    this._treeInstanceMap = new Map();
    this._build();
  }

  /** Remove all terrain meshes and free GPU memory */
  dispose() {
    for (const mesh of this._meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this._meshes = [];
    this._animatedAnimals = [];
    this._waterTimeUniforms = [];
    if (this._tumbleweeds) {
      for (const tw of this._tumbleweeds) this.scene.remove(tw.group);
      this._tumbleweeds = [];
    }
    if (this._twGeom) { this._twGeom.dispose(); this._twGeom = null; }
    if (this._twMat)  { this._twMat.dispose();  this._twMat = null; }
    if (this._ladderMeshes) {
      for (const m of this._ladderMeshes) {
        this.scene.remove(m);
        m.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
      }
      this._ladderMeshes = [];
    }
    this._renderedLadderCount = 0;
  }

  _build() {
    // Group tiles by type for instanced rendering
    const buckets = {
      [TileType.DEEP_WATER]: [],
      [TileType.WATER]:    [],
      [TileType.BEACH]:    [],
      [TileType.GRASS]:    [],
      [TileType.WOODLAND]: [],
      [TileType.FOREST]:   [],
      [TileType.DESERT]:   [],
      [TileType.STONE]:    [],
      [TileType.MOUNTAIN]: [],
    };

    for (let z = 0; z < this.world.height; z++) {
      for (let x = 0; x < this.world.width; x++) {
        buckets[this.world.tiles[z][x].type].push(this.world.tiles[z][x]);
      }
    }

    for (const [type, tiles] of Object.entries(buckets)) {
      // Smooth terrain mesh handles all ground and water tiles.
      // Only render instanced geometry for mountain cones and elevated (layer=1) stone platforms.
      let renderTiles = tiles;
      if (type === TileType.STONE) {
        renderTiles = tiles.filter(t => (t.layer ?? 0) === 1);
      } else if (type !== TileType.MOUNTAIN) {
        continue; // handled by _buildTerrainMesh / _buildWaterSurface
      }
      if (renderTiles.length === 0) continue;

      const baseH = TILE_HEIGHT[type];
      const [h, s, l] = TILE_COLOR_HSL[type];
      const isMountain = type === TileType.MOUNTAIN;

      // Mountains use tapered cones for a peak shape; elevated stone uses boxes
      const geom = isMountain
        ? new THREE.ConeGeometry(0.92, 1.5, 8)
        : new THREE.BoxGeometry(TILE_SIZE - GAP, 1, TILE_SIZE - GAP);
      const mat  = new THREE.MeshLambertMaterial();
      const mesh = new THREE.InstancedMesh(geom, mat, renderTiles.length);
      mesh.receiveShadow = true;

      const dummy = new THREE.Object3D();
      const color = new THREE.Color();

      renderTiles.forEach((tile, i) => {
        const hVariation = baseH + tile.elevation * 0.08;
        const lVariation = l + (Math.sin(tile.x * 3.1 + tile.z * 2.7) * 0.5 + 0.5) * 6 - 3;
        const layerOffset = (tile.layer ?? 0) === 1 ? ELEVATED_HEIGHT : 0;

        if (isMountain) {
          // Cone: base at y=0, tip at y=height; geom is centered, so position at half-height
          const widthVar = 0.85 + this._rng(tile.x, tile.z, 14) * 0.25;
          const tiltX = (this._rng(tile.x, tile.z, 15) - 0.5) * 0.12;
          const tiltZ = (this._rng(tile.x, tile.z, 16) - 0.5) * 0.12;
          dummy.position.set(
            tile.x * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x, tile.z, 17) - 0.5) * 0.15,
            layerOffset + hVariation / 2,
            tile.z * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x, tile.z, 18) - 0.5) * 0.15,
          );
          dummy.scale.set(widthVar, hVariation / 1.5, widthVar);
          dummy.rotation.set(tiltX, this._rng(tile.x, tile.z, 19) * 0.08, tiltZ);
          dummy.updateMatrix();
        } else {
          dummy.position.set(
            tile.x * TILE_SIZE + TILE_SIZE / 2,
            layerOffset + hVariation / 2,
            tile.z * TILE_SIZE + TILE_SIZE / 2,
          );
          dummy.scale.set(1, hVariation, 1);
          dummy.updateMatrix();
        }
        mesh.setMatrixAt(i, dummy.matrix);

        color.setHSL(h / 360, s / 100, Math.max(0.05, Math.min(0.95, lVariation / 100)));
        mesh.setColorAt(i, color);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
      this._meshes.push(mesh);
    }

    this._buildTerrainMesh();
    this._buildRivers();
    this._buildVegetation(buckets);
    this._buildAnimals(buckets);
    this._buildGlaciers(buckets[TileType.STONE], buckets[TileType.MOUNTAIN]);
    this._buildWaterSurface(buckets[TileType.WATER], buckets[TileType.DEEP_WATER]);
    this._buildTumbleweeds(buckets[TileType.DESERT]);
    this._buildCliffWalls();
    this._ladderMeshes = [];
    this._renderedLadderCount = 0;
  }

  /** Spawns a handful of tumbleweeds that roll across desert tiles. */
  _buildTumbleweeds(desertTiles) {
    if (!desertTiles?.length) return;

    const COUNT  = Math.min(7, Math.max(3, Math.floor(desertTiles.length * 0.04)));
    const surfY  = TerrainRenderer.surfaceY(TileType.DESERT);

    // Three mutually perpendicular tori create the classic tangled-branch look
    this._twGeom = new THREE.TorusGeometry(0.17, 0.019, 5, 11);
    this._twMat  = new THREE.MeshLambertMaterial({ color: 0xbf9c45 });
    this._tumbleweeds = [];

    // Pick evenly spread starting tiles using the deterministic rng
    const step = Math.floor(desertTiles.length / COUNT);
    for (let i = 0; i < COUNT; i++) {
      const tile = desertTiles[(i * step + Math.floor(this._rng(i, 0, 20) * step)) % desertTiles.length];

      const group = new THREE.Group();
      // Ring 1: default (XY plane)
      group.add(new THREE.Mesh(this._twGeom, this._twMat));
      // Ring 2: horizontal (XZ plane)
      const r2 = new THREE.Mesh(this._twGeom, this._twMat);
      r2.rotation.x = Math.PI / 2;
      group.add(r2);
      // Ring 3: vertical, perpendicular to ring 1 (YZ plane)
      const r3 = new THREE.Mesh(this._twGeom, this._twMat);
      r3.rotation.y = Math.PI / 2;
      group.add(r3);

      const sc = 0.55 + this._rng(i, 0, 30) * 0.55;
      group.scale.setScalar(sc);

      const wx = tile.x * TILE_SIZE + TILE_SIZE / 2;
      const wz = tile.z * TILE_SIZE + TILE_SIZE / 2;
      group.position.set(wx, surfY + 0.19 * sc, wz);

      // Initial random drift direction
      const ang = this._rng(i, 0, 31) * Math.PI * 2;
      const spd = 0.4 + this._rng(i, 0, 32) * 0.8;

      this.scene.add(group);
      this._tumbleweeds.push({
        group, sc,
        x: wx, z: wz,
        vx: Math.cos(ang) * spd,
        vz: Math.sin(ang) * spd,
        windTimer: this._rng(i, 0, 33) * 4,
      });
    }
  }

  /** Builds an animated water surface mesh layered above the flat tile boxes. */
  _buildWaterSurface(shallowTiles, deepTiles) {
    const allTiles = [...shallowTiles, ...deepTiles];
    if (allTiles.length === 0) return;

    // 4×4 vertex grid per tile gives smooth wave interpolation (vertices 0.5 units apart)
    const SEGS = 4;
    const W = TILE_SIZE - GAP;
    const vertsPerTile   = (SEGS + 1) * (SEGS + 1);
    const indicesPerTile = SEGS * SEGS * 6;

    const positions = new Float32Array(allTiles.length * vertsPerTile * 3);
    const indices   = new Uint32Array(allTiles.length * indicesPerTile);
    let vi = 0, ii = 0, baseVertex = 0;

    for (const tile of allTiles) {
      const cx = tile.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = TILE_HEIGHT[tile.type] + 0.003; // just above tile top
      const cz = tile.z * TILE_SIZE + TILE_SIZE / 2;

      for (let row = 0; row <= SEGS; row++) {
        for (let col = 0; col <= SEGS; col++) {
          positions[vi++] = cx + (col / SEGS - 0.5) * W;
          positions[vi++] = cy;
          positions[vi++] = cz + (row / SEGS - 0.5) * W;
        }
      }
      for (let row = 0; row < SEGS; row++) {
        for (let col = 0; col < SEGS; col++) {
          const a = baseVertex + row * (SEGS + 1) + col;
          const b = a + 1, c = a + SEGS + 1, d = c + 1;
          indices[ii++] = a; indices[ii++] = b; indices[ii++] = c;
          indices[ii++] = b; indices[ii++] = d; indices[ii++] = c;
        }
      }
      baseVertex += vertsPerTile;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    const uniforms = {
      time:         { value: 0 },
      shallowColor: { value: new THREE.Color().setHSL(208 / 360, 0.88, 0.60) },
      deepColor:    { value: new THREE.Color().setHSL(215 / 360, 0.92, 0.20) },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        uniform float time;
        varying vec3 vPos;
        void main() {
          vPos = position;
          vec3 p = position;
          p.y += sin(p.x * 2.1 + time * 1.3) * 0.018
               + sin(p.z * 1.7 + time * 0.9) * 0.014
               + sin((p.x + p.z) * 1.4 + time * 1.6) * 0.008;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 shallowColor;
        uniform vec3 deepColor;
        varying vec3 vPos;
        void main() {
          // Analytical normal matching the vertex wave function
          float dfdx = cos(vPos.x * 2.1 + time * 1.3) * (2.1 * 0.018)
                     + cos((vPos.x + vPos.z) * 1.4 + time * 1.6) * (1.4 * 0.008);
          float dfdz = cos(vPos.z * 1.7 + time * 0.9) * (1.7 * 0.014)
                     + cos((vPos.x + vPos.z) * 1.4 + time * 1.6) * (1.4 * 0.008);
          vec3 N = normalize(vec3(-dfdx, 1.0, -dfdz));

          vec3 viewDir = normalize(cameraPosition - vPos);

          // Fresnel: glancing angles show deep dark colour and are more opaque
          float fresnel = pow(1.0 - max(0.0, dot(viewDir, N)), 4.0);

          // Blinn-Phong specular (fixed noon-ish sun so it always sparkles)
          vec3 sunDir  = normalize(vec3(0.5, 1.8, 0.4));
          vec3 halfDir = normalize(sunDir + viewDir);
          float spec   = pow(max(0.0, dot(N, halfDir)), 80.0) * 1.2;

          // Tiny high-frequency shimmer (evaluated per-fragment, no vertex aliasing)
          float shimmer = sin(vPos.x * 6.3 + time * 3.4) * sin(vPos.z * 5.1 + time * 2.7) * 0.04;

          vec3 color = mix(shallowColor, deepColor, fresnel * 0.65);
          color += vec3(spec) + shimmer;

          float alpha = 0.76 + fresnel * 0.16;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite:  false,
    });

    this._waterTimeUniforms.push(uniforms);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 1; // after opaque tiles
    this.scene.add(mesh);
    this._meshes.push(mesh);
  }

  // Deterministic per-tile pseudo-random (no Math.random — stable across redraws)
  _rng(x, z, offset = 0) {
    return Math.sin(x * 127.1 + z * 311.7 + offset * 74.5) * 0.5 + 0.5;
  }

  _buildVegetation(buckets) {
    const dummy = new THREE.Object3D();

    // ── Berry bushes on GRASS tiles ───────────────────────────────────────
    const grassFood = buckets[TileType.GRASS].filter(t => this._rng(t.x, t.z) < 0.55);
    if (grassFood.length > 0) {
      const bushGeom = new THREE.SphereGeometry(0.22, 6, 5);
      const bushMat  = new THREE.MeshLambertMaterial({ color: 0x4ade80 });
      const bushMesh = new THREE.InstancedMesh(bushGeom, bushMat, grassFood.length);
      const surfY = TerrainRenderer.surfaceY(TileType.GRASS);

      // Split bushes: ~35% get blueberries, ~25% get strawberries, rest plain
      const berryTiles      = grassFood.filter(t => this._rng(t.x, t.z, 41) < 0.35);
      const strawberryTiles = grassFood.filter(t => this._rng(t.x, t.z, 41) >= 0.35 && this._rng(t.x, t.z, 41) < 0.60);

      grassFood.forEach((tile, i) => {
        const ox = (this._rng(tile.x, tile.z, 1) - 0.5) * 0.9;
        const oz = (this._rng(tile.x, tile.z, 2) - 0.5) * 0.9;
        dummy.position.set(
          tile.x * TILE_SIZE + TILE_SIZE / 2 + ox,
          surfY + 0.16,
          tile.z * TILE_SIZE + TILE_SIZE / 2 + oz,
        );
        dummy.scale.set(1, 0.7, 1);
        dummy.updateMatrix();
        bushMesh.setMatrixAt(i, dummy.matrix);
      });
      // Initialise per-instance colours (used by updateVegetation for resource tinting)
      const _bc = new THREE.Color(0x4ade80);
      for (let _i = 0; _i < grassFood.length; _i++) bushMesh.setColorAt(_i, _bc);
      if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;

      bushMesh.castShadow = true;
      bushMesh.receiveShadow = true;
      bushMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(bushMesh);
      this._meshes.push(bushMesh);
      this._bushMesh = bushMesh;
      this._grassFoodTiles = grassFood;

      // ── Blueberries: 3 tiny dark-blue/purple spheres per berry bush ───────
      if (berryTiles.length > 0) {
        const berryGeom = new THREE.SphereGeometry(0.048, 6, 5);
        const berryMat  = new THREE.MeshStandardMaterial({ color: 0x3d2b9e, roughness: 0.55, metalness: 0.0 });
        // Spawn 3 clusters per tile using separate offsets
        for (let ci = 0; ci < 3; ci++) {
          const bMesh = new THREE.InstancedMesh(berryGeom, berryMat, berryTiles.length);
          berryTiles.forEach((tile, i) => {
            const ox = (this._rng(tile.x, tile.z, 1) - 0.5) * 0.9;
            const oz = (this._rng(tile.x, tile.z, 2) - 0.5) * 0.9;
            const bx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox + (this._rng(tile.x + ci, tile.z, 51) - 0.5) * 0.28;
            const bz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz + (this._rng(tile.x, tile.z + ci, 52) - 0.5) * 0.28;
            dummy.position.set(bx, surfY + 0.28 + this._rng(tile.x, tile.z + ci, 53) * 0.06, bz);
            dummy.scale.set(1, 0.84, 1); // slightly oblate — flattened like real blueberries
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            bMesh.setMatrixAt(i, dummy.matrix);
          });
          bMesh.instanceMatrix.needsUpdate = true;
          this.scene.add(bMesh);
          this._meshes.push(bMesh);
        }
      }

      // ── Strawberries: 3 tiny red teardrops per strawberry bush ─────────────
      if (strawberryTiles.length > 0) {
        const strawGeom  = new THREE.ConeGeometry(0.042, 0.085, 5);
        const strawMat   = new THREE.MeshStandardMaterial({ color: 0xd41822, roughness: 0.30, metalness: 0.05 });
        const calyxGeom  = new THREE.ConeGeometry(0.040, 0.020, 5);
        const calyxMat   = new THREE.MeshStandardMaterial({ color: 0x2d6a2d, roughness: 0.65, metalness: 0.0 });
        for (let ci = 0; ci < 3; ci++) {
          const sMesh = new THREE.InstancedMesh(strawGeom, strawMat, strawberryTiles.length);
          const cMesh = new THREE.InstancedMesh(calyxGeom, calyxMat, strawberryTiles.length);
          strawberryTiles.forEach((tile, i) => {
            const ox  = (this._rng(tile.x, tile.z, 1) - 0.5) * 0.9;
            const oz  = (this._rng(tile.x, tile.z, 2) - 0.5) * 0.9;
            const sx  = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox + (this._rng(tile.x + ci, tile.z, 61) - 0.5) * 0.26;
            const sz  = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz + (this._rng(tile.x, tile.z + ci, 62) - 0.5) * 0.26;
            const sy  = surfY + 0.27 + this._rng(tile.x, tile.z + ci, 63) * 0.05;
            const yRot = this._rng(tile.x + ci, tile.z, 64) * Math.PI * 2;
            // Berry — tip points downward
            dummy.position.set(sx, sy, sz);
            dummy.rotation.set(Math.PI, yRot, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            sMesh.setMatrixAt(i, dummy.matrix);
            // Calyx — green leaf crown sits at the flat (top) end of the inverted cone
            dummy.position.set(sx, sy + 0.043, sz);
            dummy.rotation.set(0, yRot, 0); // upright, same twist
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            cMesh.setMatrixAt(i, dummy.matrix);
          });
          sMesh.instanceMatrix.needsUpdate = true;
          cMesh.instanceMatrix.needsUpdate = true;
          this.scene.add(sMesh);
          this.scene.add(cMesh);
          this._meshes.push(sMesh, cMesh);
        }
      }
    }

    // ── Trees on FOREST tiles ─────────────────────────────────────────────
    const forestTrees = buckets[TileType.FOREST].filter(t => this._rng(t.x, t.z) < 0.82);
    if (forestTrees.length > 0) {
      const surfY = TerrainRenderer.surfaceY(TileType.FOREST);

      // ── Shared geometries ───────────────────────────────────────────────
      const normalTrunkGeom  = new THREE.CylinderGeometry(0.08, 0.11, 0.38, 5);
      const tallTrunkGeom    = new THREE.CylinderGeometry(0.06, 0.09, 0.55, 5);
      const birchTrunkGeom   = new THREE.CylinderGeometry(0.045, 0.06, 0.50, 5);
      const cherryTrunkGeom  = new THREE.CylinderGeometry(0.07, 0.10, 0.40, 5);
      const willowTrunkGeom  = new THREE.CylinderGeometry(0.09, 0.13, 0.42, 5);
      const pineGeom         = new THREE.ConeGeometry(0.33, 0.78, 6);
      const darkFirGeom      = new THREE.ConeGeometry(0.24, 1.08, 7);
      const spruceGeom       = new THREE.ConeGeometry(0.20, 0.95, 8);
      const roundGeom        = new THREE.SphereGeometry(0.36, 7, 5);
      const cherryGeom       = new THREE.SphereGeometry(0.42, 8, 5);
      const cherryDeepGeom   = new THREE.SphereGeometry(0.46, 9, 6);
      const cherryWispGeom   = new THREE.SphereGeometry(0.38, 8, 5);
      const birchGeom        = new THREE.SphereGeometry(0.22, 6, 5);
      const wideGeom         = new THREE.SphereGeometry(0.40, 8, 5);
      const narrowGeom       = new THREE.SphereGeometry(0.26, 6, 5);

      // ── Helper: create + register one tree variant ──────────────────────
      // trunkHalfH: half the trunk cylinder height — trunk center sits here above surfY
      // foliageY: where the foliage centre sits above surfY (should = trunkH + foliage_half_height)
      // fsx/fsy/fsz: per-axis foliage scale multipliers (for flattening etc.)
      const addTreeVariant = (tiles, tGeom, tColor, fGeom, fColor, foliageY,
        { scaleMin = 0.85, scaleMax = 1.22, fsx = 1, fsy = 1, fsz = 1, trunkHalfH = 0.19 } = {}) => {
        if (!tiles.length) return;
        const tMat = new THREE.MeshLambertMaterial({ color: tColor });
        const fMat = new THREE.MeshLambertMaterial({ color: fColor });
        const tMesh = new THREE.InstancedMesh(tGeom, tMat, tiles.length);
        const fMesh = new THREE.InstancedMesh(fGeom, fMat, tiles.length);
        tiles.forEach((tile, i) => {
          const ox = (this._rng(tile.x, tile.z, 3) - 0.5) * 0.7;
          const oz = (this._rng(tile.x, tile.z, 4) - 0.5) * 0.7;
          const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc = scaleMin + this._rng(tile.x, tile.z, 7) * (scaleMax - scaleMin);
          const ry = this._rng(tile.x, tile.z, 8) * Math.PI * 2;
          dummy.rotation.set(0, ry, 0);
          dummy.position.set(cx, surfY + trunkHalfH * sc, cz);
          dummy.scale.set(sc, sc, sc);
          dummy.updateMatrix();
          tMesh.setMatrixAt(i, dummy.matrix);
          const origT = dummy.matrix.clone();
          dummy.position.set(cx, surfY + foliageY * sc, cz);
          dummy.scale.set(sc * fsx, sc * fsy, sc * fsz);
          dummy.updateMatrix();
          fMesh.setMatrixAt(i, dummy.matrix);
          const origF = dummy.matrix.clone();
          this._treeInstanceMap.set(`${tile.x},${tile.z}`, { tMesh, fMesh, index: i, origT, origF });
        });
        tMesh.castShadow = true;
        fMesh.castShadow = true;
        fMesh.receiveShadow = true;
        tMesh.instanceMatrix.needsUpdate = true;
        fMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(tMesh, fMesh);
        this._meshes.push(tMesh, fMesh);
      };

      // ── Assign each tile a tree type via biome regions ───────────────────
      // Sample at a coarse grid (~5-tile cells) so neighbouring tiles share
      // a type, then add a small per-tile jitter to soften region edges.
      const grp = { pine: [], oak: [], cherry: [], cherryDeep: [], cherryWhite: [],
                    autOrange: [], autRed: [], autGold: [], darkFir: [], birch: [],
                    maple: [], willow: [], poplar: [], jacaranda: [], teal: [],
                    autPurple: [], spruce: [], lime: [] };
      forestTrees.forEach(tile => {
        const rx = Math.floor(tile.x / 5);
        const rz = Math.floor(tile.z / 5);
        const region = this._rng(rx, rz, 99);
        const jitter = (this._rng(tile.x, tile.z, 17) - 0.5) * 0.18;
        const r = Math.max(0, Math.min(0.9999, region + jitter));
        if      (r < 0.08) grp.pine.push(tile);
        else if (r < 0.16) grp.oak.push(tile);
        else if (r < 0.24) grp.cherry.push(tile);
        else if (r < 0.31) grp.cherryDeep.push(tile);
        else if (r < 0.37) grp.cherryWhite.push(tile);
        else if (r < 0.43) grp.autOrange.push(tile);
        else if (r < 0.49) grp.autRed.push(tile);
        else if (r < 0.55) grp.autGold.push(tile);
        else if (r < 0.63) grp.darkFir.push(tile);
        else if (r < 0.69) grp.birch.push(tile);
        else if (r < 0.75) grp.maple.push(tile);
        else if (r < 0.80) grp.willow.push(tile);
        else if (r < 0.85) grp.poplar.push(tile);
        else if (r < 0.89) grp.jacaranda.push(tile);
        else if (r < 0.93) grp.teal.push(tile);
        else if (r < 0.96) grp.autPurple.push(tile);
        else if (r < 0.98) grp.spruce.push(tile);
        else               grp.lime.push(tile);
      });

      // Pine — classic dark-green cone; cone base naturally overlaps trunk top
      addTreeVariant(grp.pine,      normalTrunkGeom, 0x78350f, pineGeom,    0x166534, 0.72);
      // Oak — medium green round canopy sitting on trunk
      addTreeVariant(grp.oak,       normalTrunkGeom, 0x6b3a1f, roundGeom,   0x2d7530, 0.72);
      // Cherry blossom — soft pink, wide flattened dome
      addTreeVariant(grp.cherry,      cherryTrunkGeom, 0x5c2810, cherryGeom,     0xffacc5, 0.70,
        { scaleMin: 0.80, scaleMax: 1.10, fsx: 1.22, fsy: 0.78, fsz: 1.22, trunkHalfH: 0.20 });
      // Cherry blossom deep — vivid hot pink, larger fuller canopy
      addTreeVariant(grp.cherryDeep,  cherryTrunkGeom, 0x4a1a08, cherryDeepGeom, 0xff4fa0, 0.74,
        { scaleMin: 0.85, scaleMax: 1.18, fsx: 1.28, fsy: 0.82, fsz: 1.28, trunkHalfH: 0.20 });
      // Cherry blossom white — nearly-white blush wispy crown
      addTreeVariant(grp.cherryWhite, cherryTrunkGeom, 0x6b3828, cherryWispGeom, 0xffe8f2, 0.65,
        { scaleMin: 0.75, scaleMax: 1.08, fsx: 1.15, fsy: 0.72, fsz: 1.15, trunkHalfH: 0.20 });
      // Bright leaf green (was autumn orange)
      addTreeVariant(grp.autOrange, normalTrunkGeom, 0x6b3a1f, roundGeom,   0x4aab3a, 0.72);
      // Deep forest green (was autumn red)
      addTreeVariant(grp.autRed,    normalTrunkGeom, 0x5a2010, roundGeom,   0x1e5c2a, 0.72);
      // Yellow-green (was autumn gold)
      addTreeVariant(grp.autGold,   normalTrunkGeom, 0x6b3a1f, roundGeom,   0x8ec027, 0.72);
      // Dark fir — tall narrow dark evergreen; trunkHalfH=0.275, foliage touches top
      addTreeVariant(grp.darkFir,   tallTrunkGeom,   0x5c2a0e, darkFirGeom, 0x0d4a22, 1.06,
        { scaleMin: 0.90, scaleMax: 1.38, trunkHalfH: 0.275 });
      // Birch — slender pale trunk, small bright canopy
      addTreeVariant(grp.birch,     birchTrunkGeom,  0xc8b48a, birchGeom,   0x85c46a, 0.68,
        { scaleMin: 0.75, scaleMax: 1.05, trunkHalfH: 0.25 });
      // Rich green (was maple red)
      addTreeVariant(grp.maple,     normalTrunkGeom, 0x6b2c10, roundGeom,   0x2e7d32, 0.72,
        { scaleMin: 0.88, scaleMax: 1.25, fsx: 1.15, fsy: 0.90, fsz: 1.15 });
      // Willow — wide drooping olive-sage canopy
      addTreeVariant(grp.willow,    willowTrunkGeom, 0x5a3c18, wideGeom,    0x8b9e3a, 0.62,
        { scaleMin: 0.90, scaleMax: 1.30, fsx: 1.65, fsy: 0.52, fsz: 1.65, trunkHalfH: 0.21 });
      // Poplar — tall slender bright-green column
      addTreeVariant(grp.poplar,    tallTrunkGeom,   0x5c3010, narrowGeom,  0x3d8b37, 1.02,
        { scaleMin: 0.92, scaleMax: 1.40, fsx: 0.55, fsy: 1.85, fsz: 0.55, trunkHalfH: 0.275 });
      // Sage green wide canopy (was jacaranda lavender)
      addTreeVariant(grp.jacaranda, cherryTrunkGeom, 0x4a2010, wideGeom,    0x6aaa5a, 0.65,
        { scaleMin: 0.80, scaleMax: 1.15, fsx: 1.35, fsy: 0.68, fsz: 1.35, trunkHalfH: 0.20 });
      // Teal-green globe
      addTreeVariant(grp.teal,      normalTrunkGeom, 0x3d2a10, roundGeom,   0x0d9488, 0.72,
        { scaleMin: 0.82, scaleMax: 1.20 });
      // Dark pink cherry blossom (was autumn purple)
      addTreeVariant(grp.autPurple, cherryTrunkGeom, 0x4a1a08, cherryGeom,  0xe0629e, 0.70,
        { scaleMin: 0.82, scaleMax: 1.18, fsx: 1.18, fsy: 0.80, fsz: 1.18, trunkHalfH: 0.20 });
      // Spruce — narrow blue-green cone
      addTreeVariant(grp.spruce,    tallTrunkGeom,   0x4a2a0a, spruceGeom,  0x2f7a4f, 1.00,
        { scaleMin: 0.92, scaleMax: 1.35, trunkHalfH: 0.275 });
      // Lime — bright acid-green round canopy
      addTreeVariant(grp.lime,      normalTrunkGeom, 0x5c3010, roundGeom,   0x65a30d, 0.72,
        { scaleMin: 0.80, scaleMax: 1.15 });

      // ── Fruits scattered within canopies ──────────────────────────────────
      // Helper: place up to maxF small fruit spheres within a canopy
      const addFruits = (tiles, fruitGeom, fruitMat, foliageY, canopyR, maxF, rngBase,
        { scaleMin: sm = 0.85, scaleMax: sx = 1.22, stemGeom = null, stemMat = null, fruitR = 0 } = {}) => {
        if (!tiles.length) return;
        const fMesh = new THREE.InstancedMesh(fruitGeom, fruitMat, tiles.length * maxF);
        const stMesh = (stemGeom && stemMat)
          ? new THREE.InstancedMesh(stemGeom, stemMat, tiles.length * maxF)
          : null;
        let fi = 0;
        tiles.forEach(tile => {
          const ox  = (this._rng(tile.x, tile.z, 3) - 0.5) * 0.7;
          const oz  = (this._rng(tile.x, tile.z, 4) - 0.5) * 0.7;
          const cx  = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz  = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc  = sm + this._rng(tile.x, tile.z, 7) * (sx - sm);
          const num = 2 + Math.floor(this._rng(tile.x, tile.z, rngBase) * (maxF - 1));
          for (let k = 0; k < maxF; k++) {
            if (k < num) {
              const angle = this._rng(tile.x, tile.z, rngBase + 1 + k) * Math.PI * 2;
              const rad   = this._rng(tile.x, tile.z, rngBase + 10 + k) * canopyR * sc * 0.85;
              const fy    = foliageY * sc
                          + (this._rng(tile.x, tile.z, rngBase + 20 + k) - 0.5) * canopyR * sc * 0.75;
              const fx = cx + Math.cos(angle) * rad;
              const fz = cz + Math.sin(angle) * rad;
              dummy.position.set(fx, surfY + fy, fz);
              dummy.rotation.set(0, angle, 0);
              dummy.scale.setScalar(sc * 0.72);
              dummy.updateMatrix();
              fMesh.setMatrixAt(fi, dummy.matrix);
              if (stMesh) {
                // Stem sprouts from the top of the fruit
                dummy.position.set(fx, surfY + fy + fruitR * sc * 0.72 + 0.013, fz);
                dummy.rotation.set(0, 0, 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                stMesh.setMatrixAt(fi, dummy.matrix);
              }
            } else {
              dummy.scale.setScalar(0); dummy.updateMatrix();
              fMesh.setMatrixAt(fi, dummy.matrix);
              if (stMesh) stMesh.setMatrixAt(fi, dummy.matrix);
            }
            fi++;
          }
        });
        fMesh.castShadow = true;
        fMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(fMesh);
        this._meshes.push(fMesh);
        if (stMesh) {
          stMesh.instanceMatrix.needsUpdate = true;
          this.scene.add(stMesh);
          this._meshes.push(stMesh);
        }
      };

      const appleGeom       = new THREE.SphereGeometry(0.050, 7, 6);
      const cherryFruitGeom = new THREE.SphereGeometry(0.038, 7, 6);
      const limeFruitGeom   = new THREE.SphereGeometry(0.052, 6, 5);
      const appleMat        = new THREE.MeshStandardMaterial({ color: 0xcc1f1f, roughness: 0.18, metalness: 0.05 }); // glossy red apple
      const cherryMat       = new THREE.MeshStandardMaterial({ color: 0x6d0000, roughness: 0.08, metalness: 0.06 }); // deep glossy cherry
      const cherryDeepMat   = new THREE.MeshStandardMaterial({ color: 0x480018, roughness: 0.08, metalness: 0.06 }); // wine cherry
      const cherryWhiteMat  = new THREE.MeshStandardMaterial({ color: 0xaa3333, roughness: 0.10, metalness: 0.05 }); // blush cherry
      const limeMat         = new THREE.MeshStandardMaterial({ color: 0x3a9e3a, roughness: 0.22, metalness: 0.0  }); // natural lime green

      const appleStemGeom = new THREE.CylinderGeometry(0.007, 0.007, 0.026, 3);
      const appleStemMat  = new THREE.MeshStandardMaterial({ color: 0x4a2808, roughness: 0.9, metalness: 0.0 });

      // Apples on oak trees — 3–6 per tree, within round canopy (r=0.36, fY=0.80)
      addFruits(grp.oak,        appleGeom,       appleMat,       0.80, 0.36, 6, 200,
        { stemGeom: appleStemGeom, stemMat: appleStemMat, fruitR: 0.050 });
      // Cherries on cherry blossom trees — 4–7 per tree
      addFruits(grp.cherry,     cherryFruitGeom, cherryMat,      0.78, 0.42, 7, 210,
        { scaleMin: 0.80, scaleMax: 1.10 });
      addFruits(grp.cherryDeep, cherryFruitGeom, cherryDeepMat,  0.80, 0.46, 7, 220,
        { scaleMin: 0.85, scaleMax: 1.18 });
      addFruits(grp.cherryWhite,cherryFruitGeom, cherryWhiteMat, 0.76, 0.38, 5, 230,
        { scaleMin: 0.75, scaleMax: 1.08 });
      // Limes on lime trees — 3–5 per tree
      addFruits(grp.lime,       limeFruitGeom,   limeMat,        0.80, 0.36, 5, 240,
        { scaleMin: 0.80, scaleMax: 1.15 });

      // ── Tree stumps (one per forest tile; hidden until tree is cut) ──────
      const stumpGeom = new THREE.CylinderGeometry(0.07, 0.11, 0.06, 6);
      const stumpMat  = new THREE.MeshLambertMaterial({ color: 0x7c4a1f });
      const stumpMesh = new THREE.InstancedMesh(stumpGeom, stumpMat, forestTrees.length);
      const stumpZero = new THREE.Object3D();
      stumpZero.scale.setScalar(0);
      stumpZero.updateMatrix();
      const zeroMatrix = stumpZero.matrix.clone();
      const stumpMap = new Map(); // "x,z" → instanceIndex
      forestTrees.forEach((tile, i) => {
        const ox = (this._rng(tile.x, tile.z, 3) - 0.5) * 0.7; // same jitter as tree trunk
        const oz = (this._rng(tile.x, tile.z, 4) - 0.5) * 0.7;
        const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
        const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
        // Store the visible matrix; will be shown when tile.treeCut === true
        stumpZero.scale.setScalar(1);
        stumpZero.position.set(cx, surfY + 0.03, cz);
        stumpZero.rotation.set(0, this._rng(tile.x, tile.z, 8) * Math.PI * 2, 0);
        stumpZero.updateMatrix();
        const origStump = stumpZero.matrix.clone();
        stumpMesh.setMatrixAt(i, zeroMatrix); // hidden by default
        stumpMap.set(`${tile.x},${tile.z}`, { index: i, origStump });
      });
      stumpMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(stumpMesh);
      this._meshes.push(stumpMesh);
      this._stumpMesh = stumpMesh;
      this._stumpMap  = stumpMap;
    }

    // ── Trees on WOODLAND tiles (open, scattered — 2–3 per tile) ─────────
    const woodlandTiles = (buckets[TileType.WOODLAND] ?? []).filter(t => this._rng(t.x, t.z, 10) < 0.88);
    if (woodlandTiles.length > 0) {
      const wSurfY = TerrainRenderer.surfaceY(TileType.WOODLAND);
      const wDummy = new THREE.Object3D();

      // Expand each tile into 2–3 tree entries
      const oakEntries   = [];
      const birchEntries = [];
      woodlandTiles.forEach(tile => {
        const count = 2 + (this._rng(tile.x, tile.z, 400) < 0.50 ? 1 : 0);
        for (let ti = 0; ti < count; ti++) {
          const entry = { tile, ti };
          if (this._rng(tile.x + ti * 7, tile.z, 401) < 0.62) {
            oakEntries.push(entry);
          } else {
            birchEntries.push(entry);
          }
        }
      });

      // Oak woodland trees
      if (oakEntries.length > 0) {
        const trunkGeom  = new THREE.CylinderGeometry(0.07, 0.10, 0.34, 5);
        const canopyGeom = new THREE.SphereGeometry(0.30, 7, 5);
        const trunkMat   = new THREE.MeshLambertMaterial({ color: 0x6b3a1f });
        const canopyMat  = new THREE.MeshLambertMaterial({ color: 0x3a8c40 });
        const tMesh = new THREE.InstancedMesh(trunkGeom,  trunkMat,  oakEntries.length);
        const fMesh = new THREE.InstancedMesh(canopyGeom, canopyMat, oakEntries.length);
        oakEntries.forEach(({ tile, ti }, i) => {
          const ox = (this._rng(tile.x + ti * 7, tile.z,        402) - 0.5) * 1.4;
          const oz = (this._rng(tile.x,           tile.z + ti * 7, 403) - 0.5) * 1.4;
          const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc = 0.75 + this._rng(tile.x + ti, tile.z, 404) * 0.35;
          wDummy.rotation.set(0, this._rng(tile.x + ti, tile.z, 405) * Math.PI * 2, 0);
          wDummy.position.set(cx, wSurfY + 0.17 * sc, cz);
          wDummy.scale.setScalar(sc);
          wDummy.updateMatrix();
          tMesh.setMatrixAt(i, wDummy.matrix);
          wDummy.position.set(cx, wSurfY + 0.60 * sc, cz);
          wDummy.scale.setScalar(sc);
          wDummy.updateMatrix();
          fMesh.setMatrixAt(i, wDummy.matrix);
        });
        tMesh.castShadow = fMesh.castShadow = true;
        fMesh.receiveShadow = true;
        tMesh.instanceMatrix.needsUpdate = fMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(tMesh, fMesh);
        this._meshes.push(tMesh, fMesh);
      }

      // Birch woodland trees
      if (birchEntries.length > 0) {
        const trunkGeom  = new THREE.CylinderGeometry(0.040, 0.055, 0.44, 5);
        const canopyGeom = new THREE.SphereGeometry(0.18, 6, 4);
        const trunkMat   = new THREE.MeshLambertMaterial({ color: 0xc8b48a });
        const canopyMat  = new THREE.MeshLambertMaterial({ color: 0x90d070 });
        const tMesh = new THREE.InstancedMesh(trunkGeom,  trunkMat,  birchEntries.length);
        const fMesh = new THREE.InstancedMesh(canopyGeom, canopyMat, birchEntries.length);
        birchEntries.forEach(({ tile, ti }, i) => {
          const ox = (this._rng(tile.x + ti * 11, tile.z,         406) - 0.5) * 1.4;
          const oz = (this._rng(tile.x,            tile.z + ti * 11, 407) - 0.5) * 1.4;
          const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc = 0.70 + this._rng(tile.x + ti, tile.z, 408) * 0.30;
          wDummy.rotation.set(0, this._rng(tile.x + ti, tile.z, 409) * Math.PI * 2, 0);
          wDummy.position.set(cx, wSurfY + 0.22 * sc, cz);
          wDummy.scale.setScalar(sc);
          wDummy.updateMatrix();
          tMesh.setMatrixAt(i, wDummy.matrix);
          wDummy.position.set(cx, wSurfY + 0.60 * sc, cz);
          wDummy.scale.setScalar(sc);
          wDummy.updateMatrix();
          fMesh.setMatrixAt(i, wDummy.matrix);
        });
        tMesh.castShadow = fMesh.castShadow = true;
        fMesh.receiveShadow = true;
        tMesh.instanceMatrix.needsUpdate = fMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(tMesh, fMesh);
        this._meshes.push(tMesh, fMesh);
      }
    }

    // ── Rocks on STONE tiles ──────────────────────────────────────────────
    const stoneTiles = buckets[TileType.STONE].filter(t => this._rng(t.x, t.z, 5) < 0.50);
    if (stoneTiles.length > 0) {
      const rockGeom = new THREE.DodecahedronGeometry(0.18, 0);
      const rockMat  = new THREE.MeshLambertMaterial({ color: 0x8a9aaa });
      const rockMesh = new THREE.InstancedMesh(rockGeom, rockMat, stoneTiles.length);

      stoneTiles.forEach((tile, i) => {
        const ox    = (this._rng(tile.x, tile.z, 6) - 0.5) * 0.8;
        const oz    = (this._rng(tile.x, tile.z, 7) - 0.5) * 0.8;
        const scale = 0.55 + this._rng(tile.x, tile.z, 8) * 0.9;
        dummy.position.set(
          tile.x * TILE_SIZE + TILE_SIZE / 2 + ox,
          TerrainRenderer.surfaceY(tile) + 0.12,
          tile.z * TILE_SIZE + TILE_SIZE / 2 + oz,
        );
        dummy.scale.setScalar(scale);
        dummy.rotation.y = this._rng(tile.x, tile.z, 9) * Math.PI * 2;
        dummy.updateMatrix();
        rockMesh.setMatrixAt(i, dummy.matrix);
      });

      rockMesh.castShadow = true;
      rockMesh.receiveShadow = true;
      rockMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(rockMesh);
      this._meshes.push(rockMesh);
    }

    // ── Trees on elevated STONE hills (layer=1 platforms) ────────────────
    // ~28% of raised tiles get a tree or two — sparse windswept conifers
    const hillTreeTiles = buckets[TileType.STONE]
      .filter(t => (t.layer ?? 0) === 1 && this._rng(t.x, t.z, 500) < 0.28);
    if (hillTreeTiles.length > 0) {
      const hEntries = [];
      hillTreeTiles.forEach(tile => {
        const count = 1 + (this._rng(tile.x, tile.z, 501) < 0.40 ? 1 : 0);
        for (let ti = 0; ti < count; ti++) hEntries.push({ tile, ti });
      });

      // Windswept conifer: narrow trunk, compact pointed crown
      const hTrunkGeom  = new THREE.CylinderGeometry(0.05, 0.08, 0.32, 5);
      const hCanopyGeom = new THREE.ConeGeometry(0.22, 0.50, 7);
      const hTrunkMat   = new THREE.MeshLambertMaterial({ color: 0x5c3210 });
      const hCanopyMat  = new THREE.MeshLambertMaterial({ color: 0x2a5c30 });
      const hTMesh = new THREE.InstancedMesh(hTrunkGeom,  hTrunkMat,  hEntries.length);
      const hFMesh = new THREE.InstancedMesh(hCanopyGeom, hCanopyMat, hEntries.length);
      const hDummy = new THREE.Object3D();
      hEntries.forEach(({ tile, ti }, i) => {
        const ox = (this._rng(tile.x + ti * 9, tile.z,         502) - 0.5) * 1.2;
        const oz = (this._rng(tile.x,           tile.z + ti * 9, 503) - 0.5) * 1.2;
        const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
        const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
        const sc = 0.70 + this._rng(tile.x + ti, tile.z, 504) * 0.40;
        const surfY = TerrainRenderer.surfaceY(tile);
        // slight lean — windswept feel
        const leanX = (this._rng(tile.x, tile.z + ti, 505) - 0.5) * 0.18;
        const leanZ = (this._rng(tile.x + ti, tile.z, 506) - 0.5) * 0.18;
        hDummy.rotation.set(leanX, this._rng(tile.x + ti, tile.z, 507) * Math.PI * 2, leanZ);
        hDummy.position.set(cx, surfY + 0.16 * sc, cz);
        hDummy.scale.setScalar(sc);
        hDummy.updateMatrix();
        hTMesh.setMatrixAt(i, hDummy.matrix);
        hDummy.position.set(cx, surfY + 0.52 * sc, cz);
        hDummy.updateMatrix();
        hFMesh.setMatrixAt(i, hDummy.matrix);
      });
      hTMesh.castShadow = hFMesh.castShadow = true;
      hFMesh.receiveShadow = true;
      hTMesh.instanceMatrix.needsUpdate = hFMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(hTMesh, hFMesh);
      this._meshes.push(hTMesh, hFMesh);
    }

    // ── Beach pebbles & shells on BEACH tiles ────────────────────────────
    const beachTiles = (buckets[TileType.BEACH] ?? []).filter(t => this._rng(t.x, t.z, 60) < 0.60);
    if (beachTiles.length > 0) {
      const pebbleGeom = new THREE.DodecahedronGeometry(0.055, 0);
      const shellGeom  = new THREE.SphereGeometry(0.042, 4, 3);
      const pebbleMat  = new THREE.MeshLambertMaterial({ color: 0xd4c9a8 });
      const shellMat   = new THREE.MeshLambertMaterial({ color: 0xf0d0b0 });
      // up to 3 pebbles + 1 shell per tile
      const maxPer = 3;
      const pebbleMesh = new THREE.InstancedMesh(pebbleGeom, pebbleMat, beachTiles.length * maxPer);
      const shellMesh  = new THREE.InstancedMesh(shellGeom,  shellMat,  beachTiles.length);
      const surfY = TerrainRenderer.surfaceY(TileType.BEACH);
      let pi = 0, si = 0;
      beachTiles.forEach(tile => {
        const bx = tile.x * TILE_SIZE + TILE_SIZE / 2;
        const bz = tile.z * TILE_SIZE + TILE_SIZE / 2;
        for (let k = 0; k < maxPer; k++) {
          const ox = (this._rng(tile.x, tile.z, 61 + k) - 0.5) * 1.6;
          const oz = (this._rng(tile.x, tile.z, 64 + k) - 0.5) * 1.6;
          const sc = 0.5 + this._rng(tile.x, tile.z, 67 + k) * 0.8;
          dummy.position.set(bx + ox, surfY + 0.03, bz + oz);
          dummy.scale.setScalar(sc);
          dummy.rotation.y = this._rng(tile.x, tile.z, 70 + k) * Math.PI * 2;
          dummy.updateMatrix();
          pebbleMesh.setMatrixAt(pi++, dummy.matrix);
        }
        // shell
        const sx = (this._rng(tile.x, tile.z, 73) - 0.5) * 1.4;
        const sz = (this._rng(tile.x, tile.z, 74) - 0.5) * 1.4;
        dummy.position.set(bx + sx, surfY + 0.02, bz + sz);
        dummy.scale.setScalar(0.6 + this._rng(tile.x, tile.z, 75) * 0.7);
        dummy.rotation.set(this._rng(tile.x, tile.z, 76) * 0.4, this._rng(tile.x, tile.z, 77) * Math.PI * 2, 0);
        dummy.updateMatrix();
        shellMesh.setMatrixAt(si++, dummy.matrix);
      });
      pebbleMesh.count = pi;
      shellMesh.count  = si;
      pebbleMesh.instanceMatrix.needsUpdate = true;
      shellMesh.instanceMatrix.needsUpdate  = true;
      this.scene.add(pebbleMesh, shellMesh);
      this._meshes.push(pebbleMesh, shellMesh);
    }

    // ── Palm trees & coconuts on BEACH tiles ─────────────────────────────
    const palmTiles = (buckets[TileType.BEACH] ?? []).filter(t => this._rng(t.x, t.z, 85) < 0.28);
    if (palmTiles.length > 0) {
      const surfY         = TerrainRenderer.surfaceY(TileType.BEACH);
      const palmTrunkGeom = new THREE.CylinderGeometry(0.045, 0.075, 0.88, 7);
      const palmCrownGeom = new THREE.SphereGeometry(0.28, 8, 5);
      const coconutGeom   = new THREE.SphereGeometry(0.065, 5, 4);
      const palmTrunkMat  = new THREE.MeshLambertMaterial({ color: 0x9b8060 });
      const palmCrownMat  = new THREE.MeshLambertMaterial({ color: 0x22c55e });
      const coconutMat    = new THREE.MeshLambertMaterial({ color: 0x3a2618 });

      const palmTrunkMesh = new THREE.InstancedMesh(palmTrunkGeom, palmTrunkMat, palmTiles.length);
      const palmCrownMesh = new THREE.InstancedMesh(palmCrownGeom, palmCrownMat, palmTiles.length);
      const maxCoconuts   = 3;
      const coconutMesh   = new THREE.InstancedMesh(coconutGeom, coconutMat, palmTiles.length * maxCoconuts);
      let ci = 0;

      palmTiles.forEach((tile, i) => {
        const ox      = (this._rng(tile.x, tile.z, 86) - 0.5) * 0.8;
        const oz      = (this._rng(tile.x, tile.z, 87) - 0.5) * 0.8;
        const cx      = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
        const cz      = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
        const sc      = 0.82 + this._rng(tile.x, tile.z, 88) * 0.42;
        const ry      = this._rng(tile.x, tile.z, 89) * Math.PI * 2;
        const lean    = 0.08 + this._rng(tile.x, tile.z, 92) * 0.13;
        const trunkH  = 0.88 * sc;
        // Top of trunk shifts slightly in the lean direction
        const leanX   = Math.sin(ry) * lean * trunkH * 0.5;
        const leanZ   = Math.cos(ry) * lean * trunkH * 0.5;
        const topX    = cx + leanX;
        const topZ    = cz + leanZ;
        const topY    = surfY + trunkH;

        // Trunk
        dummy.position.set(cx + leanX * 0.5, surfY + trunkH * 0.5, cz + leanZ * 0.5);
        dummy.rotation.set(lean, ry, 0);
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        palmTrunkMesh.setMatrixAt(i, dummy.matrix);

        // Crown — wide flat frond burst
        dummy.position.set(topX, topY + 0.11 * sc, topZ);
        dummy.rotation.set(0, ry, 0);
        dummy.scale.set(sc * 1.9, sc * 0.26, sc * 1.9);
        dummy.updateMatrix();
        palmCrownMesh.setMatrixAt(i, dummy.matrix);

        // Coconuts — 2 or 3 clustered just below the crown
        const numCoconuts = 2 + (this._rng(tile.x, tile.z, 93) < 0.5 ? 1 : 0);
        for (let k = 0; k < maxCoconuts; k++) {
          if (k < numCoconuts) {
            const angle = (k / numCoconuts) * Math.PI * 2 + ry + 0.4;
            const r     = 0.09 * sc;
            dummy.position.set(topX + Math.cos(angle) * r, topY - 0.03 * sc, topZ + Math.sin(angle) * r);
            dummy.rotation.set(0, angle, 0);
            dummy.scale.setScalar(sc * 0.88);
            dummy.updateMatrix();
          } else {
            // hide unused instances
            dummy.scale.setScalar(0);
            dummy.updateMatrix();
          }
          coconutMesh.setMatrixAt(ci++, dummy.matrix);
        }
      });

      palmTrunkMesh.castShadow = true;
      palmCrownMesh.castShadow = true;
      coconutMesh.castShadow   = true;
      palmTrunkMesh.receiveShadow = true;
      palmCrownMesh.receiveShadow = true;
      palmTrunkMesh.instanceMatrix.needsUpdate = true;
      palmCrownMesh.instanceMatrix.needsUpdate = true;
      coconutMesh.instanceMatrix.needsUpdate   = true;
      this.scene.add(palmTrunkMesh, palmCrownMesh, coconutMesh);
      this._meshes.push(palmTrunkMesh, palmCrownMesh, coconutMesh);
    }

    // ── Cacti on DESERT tiles (4 types) ────────────────────────────────────────
    {
      const allDesertTiles = buckets[TileType.DESERT] ?? [];
      const surfY   = TerrainRenderer.surfaceY(TileType.DESERT);
      const ZERO_M  = new THREE.Matrix4().makeScale(0, 0, 0);

      // Each desert tile that passes density check gets one of 4 cactus types
      const cactusPool   = allDesertTiles.filter(t => this._rng(t.x, t.z, 80) < 0.52);
      const saguaroTiles = cactusPool.filter(t => this._rng(t.x, t.z, 85) < 0.30);
      const barrelTiles  = cactusPool.filter(t => { const v = this._rng(t.x, t.z, 85); return v >= 0.30 && v < 0.58; });
      const pricklyTiles = cactusPool.filter(t => { const v = this._rng(t.x, t.z, 85); return v >= 0.58 && v < 0.80; });
      const chollaTiles  = cactusPool.filter(t => this._rng(t.x, t.z, 85) >= 0.80);

      // ── 1. Saguaro — tall trunk with 90° elbow arms ─────────────────────────
      if (saguaroTiles.length > 0) {
        const ARM_OUT = 0.17; // horizontal arm segment length
        const ARM_UP  = 0.28; // vertical arm segment height

        const trunkGeom  = new THREE.CylinderGeometry(0.058, 0.095, 0.65, 7);
        const armOutGeom = new THREE.CylinderGeometry(0.033, 0.044, ARM_OUT, 6);
        const armUpGeom  = new THREE.CylinderGeometry(0.027, 0.036, ARM_UP,  6);
        const sagMat     = new THREE.MeshLambertMaterial({ color: 0x4a7c35 });

        const trunkMesh = new THREE.InstancedMesh(trunkGeom, sagMat, saguaroTiles.length);
        const lOutMesh  = new THREE.InstancedMesh(armOutGeom, sagMat, saguaroTiles.length);
        const lUpMesh   = new THREE.InstancedMesh(armUpGeom,  sagMat, saguaroTiles.length);
        const rOutMesh  = new THREE.InstancedMesh(armOutGeom, sagMat, saguaroTiles.length);
        const rUpMesh   = new THREE.InstancedMesh(armUpGeom,  sagMat, saguaroTiles.length);

        saguaroTiles.forEach((tile, i) => {
          const ox = (this._rng(tile.x, tile.z, 86) - 0.5) * 0.8;
          const oz = (this._rng(tile.x, tile.z, 87) - 0.5) * 0.8;
          const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc = 0.70 + this._rng(tile.x, tile.z, 88) * 0.70;
          const ry = this._rng(tile.x, tile.z, 89) * Math.PI * 2;

          // Arms elbow at 50–75% up the trunk
          const attachFrac = 0.50 + this._rng(tile.x, tile.z, 90) * 0.25;
          const attachY    = surfY + (attachFrac * 0.65 * sc);

          // Trunk
          dummy.position.set(cx, surfY + 0.325 * sc, cz);
          dummy.rotation.set(0, ry, 0);
          dummy.scale.setScalar(sc);
          dummy.updateMatrix();
          trunkMesh.setMatrixAt(i, dummy.matrix);

          // "Left" direction perpendicular to ry in XZ plane
          const lx = Math.cos(ry);
          const lz = -Math.sin(ry);

          const hasLeft = this._rng(tile.x, tile.z, 91) < 0.75;
          if (hasLeft) {
            const outLen = ARM_OUT * sc;
            const upLen  = ARM_UP  * sc;
            // Outward horizontal segment
            dummy.position.set(cx + lx * outLen / 2, attachY, cz + lz * outLen / 2);
            dummy.rotation.set(0, ry, Math.PI / 2);
            dummy.scale.setScalar(sc);
            dummy.updateMatrix();
            lOutMesh.setMatrixAt(i, dummy.matrix);
            // Upward vertical segment from elbow
            dummy.position.set(cx + lx * outLen, attachY + upLen / 2, cz + lz * outLen);
            dummy.rotation.set(0, ry, 0);
            dummy.scale.setScalar(sc);
            dummy.updateMatrix();
            lUpMesh.setMatrixAt(i, dummy.matrix);
          } else {
            lOutMesh.setMatrixAt(i, ZERO_M);
            lUpMesh.setMatrixAt(i,  ZERO_M);
          }

          const hasRight = this._rng(tile.x, tile.z, 92) < 0.62;
          if (hasRight) {
            const outLen = ARM_OUT * sc;
            const upLen  = ARM_UP  * sc;
            dummy.position.set(cx - lx * outLen / 2, attachY, cz - lz * outLen / 2);
            dummy.rotation.set(0, ry, Math.PI / 2);
            dummy.scale.setScalar(sc);
            dummy.updateMatrix();
            rOutMesh.setMatrixAt(i, dummy.matrix);
            dummy.position.set(cx - lx * outLen, attachY + upLen / 2, cz - lz * outLen);
            dummy.rotation.set(0, ry, 0);
            dummy.scale.setScalar(sc);
            dummy.updateMatrix();
            rUpMesh.setMatrixAt(i, dummy.matrix);
          } else {
            rOutMesh.setMatrixAt(i, ZERO_M);
            rUpMesh.setMatrixAt(i,  ZERO_M);
          }
        });

        for (const m of [trunkMesh, lOutMesh, lUpMesh, rOutMesh, rUpMesh]) {
          m.castShadow = true;
          m.instanceMatrix.needsUpdate = true;
          this.scene.add(m);
          this._meshes.push(m);
        }
      }

      // ── 2. Barrel Cactus — short round body with rib rings and top flower ──
      if (barrelTiles.length > 0) {
        const bodyGeom   = new THREE.CylinderGeometry(0.130, 0.155, 0.30, 10);
        const ribGeom    = new THREE.TorusGeometry(0.133, 0.016, 4, 10);
        const flowerGeom = new THREE.SphereGeometry(0.062, 5, 4);
        const barMat     = new THREE.MeshLambertMaterial({ color: 0x3d7a28 });
        const flowerMat  = new THREE.MeshLambertMaterial({ color: 0xffde5a });

        const bodyMesh   = new THREE.InstancedMesh(bodyGeom,   barMat,   barrelTiles.length);
        const rib1Mesh   = new THREE.InstancedMesh(ribGeom,    barMat,   barrelTiles.length);
        const rib2Mesh   = new THREE.InstancedMesh(ribGeom,    barMat,   barrelTiles.length);
        const rib3Mesh   = new THREE.InstancedMesh(ribGeom,    barMat,   barrelTiles.length);
        const flowerMesh = new THREE.InstancedMesh(flowerGeom, flowerMat, barrelTiles.length);

        barrelTiles.forEach((tile, i) => {
          const ox = (this._rng(tile.x, tile.z, 93) - 0.5) * 0.7;
          const oz = (this._rng(tile.x, tile.z, 94) - 0.5) * 0.7;
          const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc = 0.55 + this._rng(tile.x, tile.z, 95) * 0.60;
          const ry = this._rng(tile.x, tile.z, 96) * Math.PI * 2;
          const bodyH = 0.30 * sc;

          dummy.position.set(cx, surfY + bodyH / 2, cz);
          dummy.rotation.set(0, ry, 0);
          dummy.scale.setScalar(sc);
          dummy.updateMatrix();
          bodyMesh.setMatrixAt(i, dummy.matrix);

          // Rib rings at 25%, 55%, 82% height
          for (const [mesh, frac] of [[rib1Mesh, 0.25], [rib2Mesh, 0.55], [rib3Mesh, 0.82]]) {
            dummy.position.set(cx, surfY + bodyH * frac, cz);
            dummy.rotation.set(Math.PI / 2, 0, 0);
            dummy.scale.setScalar(sc);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
          }

          // Yellow flower on top (55% of barrels)
          if (this._rng(tile.x, tile.z, 97) < 0.55) {
            dummy.position.set(cx, surfY + bodyH + 0.05 * sc, cz);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.setScalar(sc * 0.9);
            dummy.updateMatrix();
            flowerMesh.setMatrixAt(i, dummy.matrix);
          } else {
            flowerMesh.setMatrixAt(i, ZERO_M);
          }
        });

        for (const m of [bodyMesh, rib1Mesh, rib2Mesh, rib3Mesh, flowerMesh]) {
          m.castShadow = true;
          m.instanceMatrix.needsUpdate = true;
          this.scene.add(m);
          this._meshes.push(m);
        }
      }

      // ── 3. Prickly Pear — stacked flat oval paddles with optional red fruit ──
      if (pricklyTiles.length > 0) {
        const baseGeom  = new THREE.CylinderGeometry(0.175, 0.185, 0.070, 7);
        const midGeom   = new THREE.CylinderGeometry(0.135, 0.145, 0.060, 7);
        const topGeom   = new THREE.CylinderGeometry(0.100, 0.110, 0.050, 6);
        const fruitGeom = new THREE.SphereGeometry(0.055, 5, 4);
        const ppMat     = new THREE.MeshLambertMaterial({ color: 0x5a9030 });
        const fruitMat  = new THREE.MeshLambertMaterial({ color: 0xd42060 });

        const baseMesh  = new THREE.InstancedMesh(baseGeom,  ppMat,    pricklyTiles.length);
        const midMesh   = new THREE.InstancedMesh(midGeom,   ppMat,    pricklyTiles.length);
        const topMesh   = new THREE.InstancedMesh(topGeom,   ppMat,    pricklyTiles.length);
        const fruitMesh = new THREE.InstancedMesh(fruitGeom, fruitMat, pricklyTiles.length);

        pricklyTiles.forEach((tile, i) => {
          const ox = (this._rng(tile.x, tile.z, 98) - 0.5) * 0.7;
          const oz = (this._rng(tile.x, tile.z, 99) - 0.5) * 0.7;
          const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc = 0.60 + this._rng(tile.x, tile.z, 100) * 0.55;

          // Base paddle — flat, slight tilt
          dummy.position.set(cx, surfY + 0.035 * sc, cz);
          dummy.rotation.set(
            (this._rng(tile.x, tile.z, 101) - 0.5) * 0.28,
            this._rng(tile.x, tile.z, 102) * Math.PI * 2,
            (this._rng(tile.x, tile.z, 103) - 0.5) * 0.28,
          );
          dummy.scale.setScalar(sc);
          dummy.updateMatrix();
          baseMesh.setMatrixAt(i, dummy.matrix);

          // Middle paddle
          dummy.position.set(
            cx + (this._rng(tile.x, tile.z, 105) - 0.5) * 0.07 * sc,
            surfY + 0.11 * sc,
            cz + (this._rng(tile.x, tile.z, 106) - 0.5) * 0.07 * sc,
          );
          dummy.rotation.set(
            (this._rng(tile.x, tile.z, 107) - 0.5) * 0.45,
            this._rng(tile.x, tile.z, 104) * Math.PI * 2,
            (this._rng(tile.x, tile.z, 108) - 0.5) * 0.45,
          );
          dummy.scale.setScalar(sc);
          dummy.updateMatrix();
          midMesh.setMatrixAt(i, dummy.matrix);

          // Top paddle (70% chance)
          const hasTop = this._rng(tile.x, tile.z, 109) < 0.70;
          if (hasTop) {
            dummy.position.set(
              cx + (this._rng(tile.x, tile.z, 110) - 0.5) * 0.11 * sc,
              surfY + 0.195 * sc,
              cz + (this._rng(tile.x, tile.z, 111) - 0.5) * 0.11 * sc,
            );
            dummy.rotation.set(
              (this._rng(tile.x, tile.z, 112) - 0.5) * 0.65,
              this._rng(tile.x, tile.z, 113) * Math.PI * 2,
              (this._rng(tile.x, tile.z, 114) - 0.5) * 0.65,
            );
            dummy.scale.setScalar(sc * 0.85);
            dummy.updateMatrix();
            topMesh.setMatrixAt(i, dummy.matrix);
          } else {
            topMesh.setMatrixAt(i, ZERO_M);
          }

          // Red fruit on the topmost paddle (40% chance)
          if (this._rng(tile.x, tile.z, 115) < 0.40) {
            const fruitBaseY = hasTop ? surfY + 0.25 * sc : surfY + 0.175 * sc;
            dummy.position.set(
              cx + (this._rng(tile.x, tile.z, 116) - 0.5) * 0.08 * sc,
              fruitBaseY,
              cz + (this._rng(tile.x, tile.z, 117) - 0.5) * 0.08 * sc,
            );
            dummy.rotation.set(0, 0, 0);
            dummy.scale.setScalar(sc * 0.82);
            dummy.updateMatrix();
            fruitMesh.setMatrixAt(i, dummy.matrix);
          } else {
            fruitMesh.setMatrixAt(i, ZERO_M);
          }
        });

        for (const m of [baseMesh, midMesh, topMesh, fruitMesh]) {
          m.castShadow = true;
          m.instanceMatrix.needsUpdate = true;
          this.scene.add(m);
          this._meshes.push(m);
        }
      }

      // ── 4. Cholla — tall stacked cylinder column with a gentle wobble ───────
      if (chollaTiles.length > 0) {
        const MAX_SEGS = 5;
        const segGeom  = new THREE.CylinderGeometry(0.038, 0.044, 0.24, 6);
        const chMat    = new THREE.MeshLambertMaterial({ color: 0x4a8832 });
        const segMeshes = Array.from({ length: MAX_SEGS }, () =>
          new THREE.InstancedMesh(segGeom, chMat, chollaTiles.length)
        );

        chollaTiles.forEach((tile, i) => {
          const ox = (this._rng(tile.x, tile.z, 118) - 0.5) * 0.7;
          const oz = (this._rng(tile.x, tile.z, 119) - 0.5) * 0.7;
          const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          const sc = 0.65 + this._rng(tile.x, tile.z, 120) * 0.70;
          const segH = 0.24 * sc;
          const numSegs = 3 + Math.floor(this._rng(tile.x, tile.z, 121) * 3); // 3–5

          segMeshes.forEach((mesh, s) => {
            if (s >= numSegs) { mesh.setMatrixAt(i, ZERO_M); return; }
            // Gentle drift per segment so the column leans slightly
            const wobX = (this._rng(tile.x, tile.z, 122 + s * 2) - 0.5) * 0.04 * sc * s;
            const wobZ = (this._rng(tile.x, tile.z, 123 + s * 2) - 0.5) * 0.04 * sc * s;
            dummy.position.set(cx + wobX, surfY + segH * (s + 0.5), cz + wobZ);
            dummy.rotation.set(
              (this._rng(tile.x, tile.z, 124 + s) - 0.5) * 0.10,
              this._rng(tile.x, tile.z, 125 + s) * Math.PI * 2,
              (this._rng(tile.x, tile.z, 126 + s) - 0.5) * 0.10,
            );
            dummy.scale.setScalar(sc);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
          });
        });

        for (const m of segMeshes) {
          m.castShadow = true;
          m.instanceMatrix.needsUpdate = true;
          this.scene.add(m);
          this._meshes.push(m);
        }
      }
    }

    // ── Snow caps on MOUNTAIN tiles ───────────────────────────────────────
    const mountainTiles = buckets[TileType.MOUNTAIN];
    if (mountainTiles.length > 0) {
      const snowGeom = new THREE.SphereGeometry(0.4, 5, 4);
      const snowMat  = new THREE.MeshStandardMaterial({ color: 0xedf2f7, roughness: 0.92 });
      const snowMesh = new THREE.InstancedMesh(snowGeom, snowMat, mountainTiles.length);

      mountainTiles.forEach((tile, i) => {
        const hVar = 1.5 + tile.elevation * 0.08;
        const widthVar = 0.85 + this._rng(tile.x, tile.z, 14) * 0.25;
        const ox = (this._rng(tile.x, tile.z, 10) - 0.5) * 0.2;
        const oz = (this._rng(tile.x, tile.z, 11) - 0.5) * 0.2;
        dummy.position.set(
          tile.x * TILE_SIZE + TILE_SIZE / 2 + ox,
          hVar - 0.18,
          tile.z * TILE_SIZE + TILE_SIZE / 2 + oz,
        );
        const snowScale = 0.35 + this._rng(tile.x, tile.z, 12) * 0.15;
        dummy.scale.set(snowScale * widthVar, snowScale, snowScale * widthVar);
        dummy.updateMatrix();
        snowMesh.setMatrixAt(i, dummy.matrix);
      });

      snowMesh.castShadow = true;
      snowMesh.receiveShadow = true;
      snowMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(snowMesh);
      this._meshes.push(snowMesh);

      // Boulder clusters at mountain bases for a more rugged look
      const mountainRocks = mountainTiles.filter(t => this._rng(t.x, t.z, 20) < 0.6);
      if (mountainRocks.length > 0) {
        const mRockGeom = new THREE.DodecahedronGeometry(0.12, 0);
        const mRockMat  = new THREE.MeshLambertMaterial({ color: 0x6b7c8d });
        const mRockMesh = new THREE.InstancedMesh(mRockGeom, mRockMat, mountainRocks.length);
        mountainRocks.forEach((tile, i) => {
          const ox = (this._rng(tile.x, tile.z, 21) - 0.5) * 1.2;
          const oz = (this._rng(tile.x, tile.z, 22) - 0.5) * 1.2;
          const scale = 0.4 + this._rng(tile.x, tile.z, 23) * 0.8;
          dummy.position.set(
            tile.x * TILE_SIZE + TILE_SIZE / 2 + ox,
            0.2 + this._rng(tile.x, tile.z, 24) * 0.2,
            tile.z * TILE_SIZE + TILE_SIZE / 2 + oz,
          );
          dummy.scale.setScalar(scale);
          dummy.rotation.set(
            (this._rng(tile.x, tile.z, 25) - 0.5) * 0.4,
            this._rng(tile.x, tile.z, 26) * Math.PI * 2,
            (this._rng(tile.x, tile.z, 27) - 0.5) * 0.4,
          );
          dummy.updateMatrix();
          mRockMesh.setMatrixAt(i, dummy.matrix);
        });
        mRockMesh.castShadow = true;
        mRockMesh.receiveShadow = true;
        mRockMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mRockMesh);
        this._meshes.push(mRockMesh);
      }
    }

    // ── Medicinal herb clusters (FOREST + water-adjacent GRASS) ───────────
    const herbTiles = [
      ...buckets[TileType.FOREST],
      ...(buckets[TileType.WOODLAND] ?? []),
      ...buckets[TileType.GRASS],
    ].filter(t => t.herbs > 0);
    if (herbTiles.length > 0) {
      const herbsPerTile = 3;
      const headGeom = new THREE.SphereGeometry(0.030, 4, 3);
      const stemGeom = new THREE.CylinderGeometry(0.007, 0.009, 0.07, 4);
      const headMat  = new THREE.MeshLambertMaterial({ color: 0xd97ef5 });
      const stemMat  = new THREE.MeshLambertMaterial({ color: 0x6db56d });
      const headMesh = new THREE.InstancedMesh(headGeom, headMat, herbTiles.length * herbsPerTile);
      const stemMesh = new THREE.InstancedMesh(stemGeom, stemMat, herbTiles.length * herbsPerTile);
      const surfY = TerrainRenderer.surfaceY(TileType.GRASS);
      let hi = 0;
      herbTiles.forEach(tile => {
        const tileY = TerrainRenderer.surfaceY(tile.type);
        for (let k = 0; k < herbsPerTile; k++) {
          const ox = (this._rng(tile.x, tile.z, 310 + k * 2) - 0.5) * 1.1;
          const oz = (this._rng(tile.x, tile.z, 311 + k * 2) - 0.5) * 1.1;
          const bx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
          const bz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
          dummy.position.set(bx, tileY + 0.10, bz);
          dummy.scale.setScalar(1);
          dummy.rotation.set(0, this._rng(tile.x + k, tile.z, 312) * Math.PI * 2, 0);
          dummy.updateMatrix();
          headMesh.setMatrixAt(hi, dummy.matrix);
          dummy.position.set(bx, tileY + 0.035, bz);
          dummy.updateMatrix();
          stemMesh.setMatrixAt(hi, dummy.matrix);
          hi++;
        }
      });
      headMesh.instanceMatrix.needsUpdate = true;
      stemMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(headMesh);
      this.scene.add(stemMesh);
      this._meshes.push(headMesh);
      this._meshes.push(stemMesh);
      this._herbHeadMesh = headMesh;
      this._herbTiles    = herbTiles;
    }

    // ── Mushroom rings (FOREST tiles) ────────────────────────────────────
    const mushroomTiles = buckets[TileType.FOREST].filter(t => t.mushrooms > 0);
    if (mushroomTiles.length > 0) {
      const shroomsPerTile = 3;
      const capGeom  = new THREE.SphereGeometry(0.065, 6, 4);
      const stemGeom2 = new THREE.CylinderGeometry(0.012, 0.018, 0.06, 5);
      const capColors = [0xc8860a, 0x7a3d0a, 0xd4b483];
      const stemMat2 = new THREE.MeshLambertMaterial({ color: 0xf5f0e0 });
      const capMeshes = capColors.map(col =>
        new THREE.InstancedMesh(capGeom, new THREE.MeshLambertMaterial({ color: col }), mushroomTiles.length)
      );
      const stemMesh2 = new THREE.InstancedMesh(stemGeom2, stemMat2, mushroomTiles.length * shroomsPerTile);
      const mSurfY = TerrainRenderer.surfaceY(TileType.FOREST);
      let si2 = 0;
      mushroomTiles.forEach((tile, i) => {
        const ox = (this._rng(tile.x, tile.z, 320) - 0.5) * 1.0;
        const oz = (this._rng(tile.x, tile.z, 321) - 0.5) * 1.0;
        const bx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
        const bz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
        const ci2 = Math.floor(this._rng(tile.x, tile.z, 322) * capColors.length);
        for (let k = 0; k < shroomsPerTile; k++) {
          const mx = bx + (this._rng(tile.x + k, tile.z, 323) - 0.5) * 0.6;
          const mz = bz + (this._rng(tile.x, tile.z + k, 324) - 0.5) * 0.6;
          dummy.position.set(mx, mSurfY + 0.03, mz);
          dummy.scale.setScalar(1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          stemMesh2.setMatrixAt(si2, dummy.matrix);
          dummy.position.set(mx, mSurfY + 0.07, mz);
          dummy.scale.set(1, 0.45, 1);
          dummy.updateMatrix();
          capMeshes[ci2].setMatrixAt(i, dummy.matrix);
          si2++;
        }
      });
      stemMesh2.instanceMatrix.needsUpdate = true;
      this.scene.add(stemMesh2);
      this._meshes.push(stemMesh2);
      for (const cm of capMeshes) {
        cm.instanceMatrix.needsUpdate = true;
        this.scene.add(cm);
        this._meshes.push(cm);
      }
      this._mushroomCapMeshes = capMeshes;
      this._mushroomTiles     = mushroomTiles;
    }

    // ── Flint shards (STONE tiles) ───────────────────────────────────────
    const flintTiles = buckets[TileType.STONE].filter(t => t.flint === 1);
    if (flintTiles.length > 0) {
      const shardGeom = new THREE.TetrahedronGeometry(0.055, 0);
      const shardMat  = new THREE.MeshLambertMaterial({ color: 0xb8d0e8 });
      const shardMesh = new THREE.InstancedMesh(shardGeom, shardMat, flintTiles.length);
      flintTiles.forEach((tile, i) => {
        const ox = (this._rng(tile.x, tile.z, 360) - 0.5) * 1.0;
        const oz = (this._rng(tile.x, tile.z, 361) - 0.5) * 1.0;
        dummy.position.set(
          tile.x * TILE_SIZE + TILE_SIZE / 2 + ox,
          TerrainRenderer.surfaceY(tile) + 0.04,
          tile.z * TILE_SIZE + TILE_SIZE / 2 + oz,
        );
        dummy.scale.set(1, 0.4, 0.85);
        dummy.rotation.set(
          (this._rng(tile.x, tile.z, 362) - 0.5) * 0.4,
          this._rng(tile.x, tile.z, 363) * Math.PI * 2,
          (this._rng(tile.x, tile.z, 364) - 0.5) * 0.4,
        );
        dummy.updateMatrix();
        shardMesh.setMatrixAt(i, dummy.matrix);
      });
      shardMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(shardMesh);
      this._meshes.push(shardMesh);
      this._flintMesh  = shardMesh;
      this._flintTiles = flintTiles;
    }
  }

  _buildAnimals(buckets) {
    const dummy = new THREE.Object3D();
    const surfY = (type) => TerrainRenderer.surfaceY(type);

    const addAnimated = (mesh, instances, config, parts = []) => {
      this.scene.add(mesh);
      this._meshes.push(mesh);
      for (const p of parts) {
        this.scene.add(p.mesh);
        this._meshes.push(p.mesh);
      }
      this._animatedAnimals.push({ mesh, parts, instances, config });
    };

    // ── Fish (2 types) in WATER tiles ─────────────────────────────────────
    // Fish type 1 = shallow-water (orange): small, fast, stays near shore (radius 3)
    // Fish type 1 = shallow-water (orange): small, fast, hugs the shoreline
    const waterTiles = buckets[TileType.WATER] ?? [];
    const deepWaterTiles = buckets[TileType.DEEP_WATER] ?? [];
    // Shallow fish spawn on WATER tiles adjacent to land
    const shallowTiles = waterTiles.filter(t =>
      this._rng(t.x, t.z, 20) < 0.44 &&
      (this.world.hasAdjacentType(t.x, t.z, TileType.GRASS) ||
       this.world.hasAdjacentType(t.x, t.z, TileType.FOREST))
    );
    // Deep fish spawn on DEEP_WATER tiles
    const deepTiles = deepWaterTiles.filter(t => this._rng(t.x, t.z, 21) < 0.30);
    const fish1Tiles = shallowTiles.length > 0
      ? shallowTiles
      : waterTiles.filter(t => this._rng(t.x, t.z, 20) < 0.36);
    const fish2Tiles = deepTiles.length > 0
      ? deepTiles
      : [...waterTiles, ...deepWaterTiles].filter(t => this._rng(t.x, t.z, 21) < 0.24);

    // ── Fish geometry helpers ─────────────────────────────────────────────────
    // 3D torpedo fish body: elongated sphere with rear taper (peduncle) and snout.
    //   len = body half-length (Z), ht = half-height (Y), wid = half-width (X)
    //   Snout at +Z, tail peduncle at -Z.
    const _mkFishBody = (len, ht, wid) => {
      const g = new THREE.SphereGeometry(0.5, 12, 8);
      const pos = g.attributes.position;
      for (let vi = 0; vi < pos.count; vi++) {
        const x = pos.getX(vi);
        const y = pos.getY(vi);
        const z = pos.getZ(vi); // +0.5=snout, -0.5=peduncle
        // Strongly taper toward tail peduncle
        const rearT  = z < 0 ? Math.max(0.10, 1.0 + z * 1.55) : 1.0;
        // Mildly taper snout
        const frontT = z > 0.18 ? Math.max(0.16, 1.0 - (z - 0.18) * 2.0) : 1.0;
        const t = Math.min(rearT, frontT);
        pos.setXYZ(vi, x * wid * 2 * t, y * ht * 2 * t, z * len * 2);
      }
      pos.needsUpdate = true;
      g.computeVertexNormals();
      return g;
    };
    // One lobe of a forked caudal fin, lying flat in XZ plane.
    //   w = lobe spread, depth = lobe length (toward -Z), thick = fin thickness (Y)
    const _mkCaudalLobe = (w, depth, thick) => {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.bezierCurveTo(w * 0.55, -depth * 0.12, w * 1.08, -depth * 0.55, w, -depth);
      s.bezierCurveTo(w * 0.45, -depth * 0.82, w * 0.08, -depth * 0.55, 0, -depth * 0.42);
      s.closePath();
      const geom = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
      geom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      geom.applyMatrix4(new THREE.Matrix4().makeTranslation(0, thick * 0.5, 0));
      return geom;
    };

    // Shallow: round-bodied (bream / discus)
    const fish1BodyGeom  = _mkFishBody(0.13, 0.07, 0.05);
    const fish1LobeGeom  = _mkCaudalLobe(0.055, 0.068, 0.008);
    // Deep: streamlined (tuna / barracuda)
    const fish2BodyGeom  = _mkFishBody(0.19, 0.045, 0.035);
    const fish2LobeGeom  = _mkCaudalLobe(0.042, 0.082, 0.006);
    // Golden koi: fat, deep-bodied
    const fish3BodyGeom  = _mkFishBody(0.12, 0.085, 0.065);
    const fish3LobeGeom  = _mkCaudalLobe(0.065, 0.065, 0.010);
    // Shared eye geometry for all fish
    const fishEyeGeom = new THREE.SphereGeometry(0.018, 4, 3);
    const fishEyeMat  = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });

    // Shallow fish (vibrant, quick, near shore)
    const shallowFishConfig = {
      label: 'Shallow Fish', icon: '🐟',
      description: 'A small fish that hugs the shoreline.',
      driftRadius: 0.0, driftSpeed: 0, bobAmount: 0.020, bobSpeed: 3.8,
      mobile: true, moveSpeed: 0.58, tileType: TileType.WATER, wanderRadius: 3,
      wagAmp: 0.19, wagFreq: 4.5, turnSpeed: 6.0, burstCoast: true, burstMult: 3.2,
      fishSwim: true, swimCurveAmp: 0.20, swimCurveFreq: 1.7,
    };
    // Golden koi: ornate, jewel-toned, hugs the shallowest water
    const goldenFishConfig = {
      label: 'Golden Fish', icon: '🐟',
      description: 'A shimmering golden fish darting through shallow water.',
      driftRadius: 0.0, driftSpeed: 0, bobAmount: 0.024, bobSpeed: 4.5,
      mobile: true, moveSpeed: 0.68, tileType: TileType.WATER, wanderRadius: 2,
      wagAmp: 0.24, wagFreq: 5.2, turnSpeed: 7.5, burstCoast: true, burstMult: 3.8,
      fishSwim: true, swimCurveAmp: 0.28, swimCurveFreq: 2.3,
    };
    // Deep fish: slow, large wander radius
    const deepFishConfig = {
      label: 'Deep Fish', icon: '🐠',
      description: 'A large fish that roams the open ocean.',
      driftRadius: 0.0, driftSpeed: 0, bobAmount: 0.007, bobSpeed: 1.2,
      mobile: true, moveSpeed: 0.24, tileTypes: [TileType.DEEP_WATER, TileType.WATER], wanderRadius: 9,
      wagAmp: 0.12, wagFreq: 2.9, turnSpeed: 3.2, burstCoast: true, burstMult: 2.6,
      fishSwim: true, swimCurveAmp: 0.10, swimCurveFreq: 0.8,
    };

    // Helper: build an InstancedMesh with per-instance colour, register it and return it
    const _mkFishMesh = (geom, count) =>
      new THREE.InstancedMesh(geom, new THREE.MeshLambertMaterial({ color: 0xffffff }), count);
    const _colourFish = (meshes, idx, col) => meshes.forEach(m => m.setColorAt(idx, col));

    if (fish1Tiles.length > 0) {
      const n = fish1Tiles.length;
      const fish1Body  = _mkFishMesh(fish1BodyGeom, n);
      const fish1TailL = _mkFishMesh(fish1LobeGeom, n);
      const fish1TailR = _mkFishMesh(fish1LobeGeom, n);
      // Extended tropical palette: 16 vivid reef colours
      const shallowPalette = [
        0x00c8b4, 0xff5533, 0xffcc00, 0x66dd00,
        0xff2288, 0x9933ff, 0x00aaff, 0xff8800,
        0xff6060, 0x00ffcc, 0xffaa00, 0xee00cc,
        0x44ddff, 0xaaff00, 0xff3366, 0x00bbff,
      ];
      const _c1 = new THREE.Color();
      const instances1 = fish1Tiles.map((tile, idx) => {
        const ox   = (this._rng(tile.x, tile.z, 22) - 0.5) * 0.8;
        const oz   = (this._rng(tile.x, tile.z, 23) - 0.5) * 0.8;
        const seed = this._rng(tile.x, tile.z, 24) * Math.PI * 2;
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        const ci   = Math.floor(this._rng(tile.x, tile.z, 28) * shallowPalette.length);
        _c1.setHex(shallowPalette[ci]);
        _colourFish([fish1Body, fish1TailL, fish1TailR], idx, _c1);
        const sv = 1.10 + this._rng(tile.x, tile.z, 29) * 0.65;
        return { x: tx, z: tz, targetX: tx, targetZ: tz, homeX: tile.x, homeZ: tile.z,
                 baseY: surfY(TileType.WATER) + 0.02, scale: [sv, sv, sv], rotY: seed, seed };
      });
      [fish1Body, fish1TailL, fish1TailR].forEach(m => {
        m.instanceColor.needsUpdate = true; m.castShadow = false;
      });
      const fish1Eye = new THREE.InstancedMesh(fishEyeGeom, fishEyeMat, n);
      fish1Eye.castShadow = false;
      addAnimated(fish1Body, instances1, shallowFishConfig, [
        { mesh: fish1TailL, fishTailL: true, offset: 0.13, tailSplay: 0.20 },
        { mesh: fish1TailR, fishTailR: true, offset: 0.13, tailSplay: 0.20 },
        { mesh: fish1Eye,   fishEye: true },
      ]);
    }

    if (fish2Tiles.length > 0) {
      const n = fish2Tiles.length;
      const fish2Body  = _mkFishMesh(fish2BodyGeom, n);
      const fish2TailL = _mkFishMesh(fish2LobeGeom, n);
      const fish2TailR = _mkFishMesh(fish2LobeGeom, n);
      // Ocean palette: cobalt, teal, jade, cyan, deep-purple, turquoise, midnight, coral
      const deepPalette = [
        0x1166dd, 0x009988, 0x226644, 0x00ccdd,
        0x5511aa, 0x00bbcc, 0x003399, 0xcc4422,
      ];
      const _c2 = new THREE.Color();
      const instances2 = fish2Tiles.map((tile, idx) => {
        const ox   = (this._rng(tile.x, tile.z, 25) - 0.5) * 0.6;
        const oz   = (this._rng(tile.x, tile.z, 26) - 0.5) * 0.6;
        const seed = this._rng(tile.x, tile.z, 27) * Math.PI * 2;
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        const ci   = Math.floor(this._rng(tile.x, tile.z, 28) * deepPalette.length);
        _c2.setHex(deepPalette[ci]);
        _colourFish([fish2Body, fish2TailL, fish2TailR], idx, _c2);
        const sv = 1.20 + this._rng(tile.x, tile.z, 29) * 0.65;
        return { x: tx, z: tz, targetX: tx, targetZ: tz, homeX: tile.x, homeZ: tile.z,
                 baseY: surfY(TileType.WATER) - 0.01, scale: [sv, sv, sv], rotY: seed, seed };
      });
      [fish2Body, fish2TailL, fish2TailR].forEach(m => {
        m.instanceColor.needsUpdate = true; m.castShadow = false;
      });
      const fish2Eye = new THREE.InstancedMesh(fishEyeGeom, fishEyeMat, n);
      fish2Eye.castShadow = false;
      addAnimated(fish2Body, instances2, deepFishConfig, [
        { mesh: fish2TailL, fishTailL: true, offset: 0.19, tailSplay: 0.18 },
        { mesh: fish2TailR, fishTailR: true, offset: 0.19, tailSplay: 0.18 },
        { mesh: fish2Eye,   fishEye: true },
      ]);
    }

    // Golden koi — shore-hugging, jewel-toned, lively
    const goldenTiles = waterTiles.filter(t =>
      this._rng(t.x, t.z, 36) < 0.28 &&
      (this.world.hasAdjacentType(t.x, t.z, TileType.GRASS) ||
       this.world.hasAdjacentType(t.x, t.z, TileType.FOREST))
    );
    if (goldenTiles.length > 0) {
      const n = goldenTiles.length;
      const fish3Body  = _mkFishMesh(fish3BodyGeom, n);
      const fish3TailL = _mkFishMesh(fish3LobeGeom, n);
      const fish3TailR = _mkFishMesh(fish3LobeGeom, n);
      // Golden palette: pure gold, amber, warm gold, pale gold, deep amber, rose-gold, honey
      const goldenPalette = [
        0xFFD700, 0xFFA500, 0xFFCC33, 0xFFE066,
        0xE8960C, 0xFFB347, 0xF4C430, 0xFF9000,
      ];
      const _c3 = new THREE.Color();
      const instances3 = goldenTiles.map((tile, idx) => {
        const ox   = (this._rng(tile.x, tile.z, 37) - 0.5) * 0.8;
        const oz   = (this._rng(tile.x, tile.z, 38) - 0.5) * 0.8;
        const seed = this._rng(tile.x, tile.z, 39) * Math.PI * 2;
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        const ci   = Math.floor(this._rng(tile.x, tile.z, 40) * goldenPalette.length);
        _c3.setHex(goldenPalette[ci]);
        _colourFish([fish3Body, fish3TailL, fish3TailR], idx, _c3);
        const sv = 0.95 + this._rng(tile.x, tile.z, 41) * 0.60;
        return { x: tx, z: tz, targetX: tx, targetZ: tz, homeX: tile.x, homeZ: tile.z,
                 baseY: surfY(TileType.WATER) + 0.02, scale: [sv, sv, sv], rotY: seed, seed };
      });
      [fish3Body, fish3TailL, fish3TailR].forEach(m => {
        m.instanceColor.needsUpdate = true; m.castShadow = false;
      });
      const fish3Eye = new THREE.InstancedMesh(fishEyeGeom, fishEyeMat, n);
      fish3Eye.castShadow = false;
      addAnimated(fish3Body, instances3, goldenFishConfig, [
        { mesh: fish3TailL, fishTailL: true, offset: 0.12, tailSplay: 0.25 },
        { mesh: fish3TailR, fishTailR: true, offset: 0.12, tailSplay: 0.25 },
        { mesh: fish3Eye,   fishEye: true },
      ]);
    }

    // ── Pigs on GRASS tiles ──────────────────────────────────────────────
    const grassTiles = buckets[TileType.GRASS] ?? [];
    const pigTiles = grassTiles.filter(t => this._rng(t.x, t.z, 40) < 0.025);
    const pigGrazeConfig = { label: 'Pig', icon: '🐷', description: 'A stocky pig rooting around the pasture.', driftRadius: 0.10, driftSpeed: 0.3, bobAmount: 0.012, bobSpeed: 2.2, mobile: true, moveSpeed: 0.38, tileType: TileType.GRASS, wanderRadius: 4 };
    if (pigTiles.length > 0) {
      // Fat sphere body + rounded head + wide disc snout + split ears + four stubby legs + curly tail
      const pigBodyGeom  = new THREE.SphereGeometry(0.16, 8, 6);
      const pigMat       = new THREE.MeshLambertMaterial({ color: 0xefc0ae });
      const pigMesh      = new THREE.InstancedMesh(pigBodyGeom, pigMat, pigTiles.length);
      const pigHeadGeom  = new THREE.SphereGeometry(0.12, 7, 5);
      const pigHeadMat   = new THREE.MeshLambertMaterial({ color: 0xefc0ae });
      const pigHeadMesh  = new THREE.InstancedMesh(pigHeadGeom, pigHeadMat, pigTiles.length);
      // Snout: wide flat disc so it looks like a real pig nose
      const pigSnoutGeom = new THREE.CylinderGeometry(0.060, 0.068, 0.050, 7);
      const pigSnoutMat  = new THREE.MeshLambertMaterial({ color: 0xdd9a85 });
      const pigSnoutMesh = new THREE.InstancedMesh(pigSnoutGeom, pigSnoutMat, pigTiles.length);
      // Separate left/right ears so they sit on the sides of the head
      const pigEarGeom   = new THREE.BoxGeometry(0.034, 0.068, 0.014);
      const pigEarMat    = new THREE.MeshLambertMaterial({ color: 0xe09090 });
      const pigEarLMesh  = new THREE.InstancedMesh(pigEarGeom, pigEarMat, pigTiles.length);
      const pigEarRMesh  = new THREE.InstancedMesh(pigEarGeom, pigEarMat, pigTiles.length);
      const pigTailGeom  = new THREE.TorusGeometry(0.038, 0.016, 4, 7, Math.PI * 1.6);
      const pigTailMat   = new THREE.MeshLambertMaterial({ color: 0xdd9a85 });
      const pigTailMesh  = new THREE.InstancedMesh(pigTailGeom, pigTailMat, pigTiles.length);
      // Small dark eyes
      const pigEyeGeom  = new THREE.SphereGeometry(0.020, 5, 4);
      const pigEyeMat   = new THREE.MeshLambertMaterial({ color: 0x111111 });
      const pigEyeLMesh = new THREE.InstancedMesh(pigEyeGeom, pigEyeMat, pigTiles.length);
      const pigEyeRMesh = new THREE.InstancedMesh(pigEyeGeom, pigEyeMat, pigTiles.length);
      // Four stubby legs
      const pigLegGeom   = new THREE.CylinderGeometry(0.028, 0.022, 0.14, 5);
      const pigLegMat    = new THREE.MeshLambertMaterial({ color: 0xd8a494 });
      const pigLegFLMesh = new THREE.InstancedMesh(pigLegGeom, pigLegMat, pigTiles.length);
      const pigLegFRMesh = new THREE.InstancedMesh(pigLegGeom, pigLegMat, pigTiles.length);
      const pigLegBLMesh = new THREE.InstancedMesh(pigLegGeom, pigLegMat, pigTiles.length);
      const pigLegBRMesh = new THREE.InstancedMesh(pigLegGeom, pigLegMat, pigTiles.length);
      const instances = pigTiles.map((tile) => {
        const ox = (this._rng(tile.x, tile.z, 41) - 0.5) * 0.95;
        const oz = (this._rng(tile.x, tile.z, 42) - 0.5) * 0.95;
        const seed = this._rng(tile.x, tile.z, 43) * Math.PI * 2;
        const sr = this._rng(tile.x, tile.z, 44);
        // 30% piglets, 50% normal pigs, 20% big boars
        const s = sr < 0.30 ? 0.50 + sr * 0.2 : sr < 0.80 ? 1.00 : 1.32 + (sr - 0.80) * 0.4;
        const tx = tile.x + 0.5 + ox * 0.5;
        const tz = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.GRASS) + 0.22 * s,
          scale: [1.20 * s, 0.72 * s, 1.05 * s],
          headScale: [0.88 * s, 0.88 * s, 1.00 * s],
          snoutScale: [s, s, s],
          pigSize: s,
          rotY: seed, seed,
        };
      });
      pigMesh.castShadow = true;
      pigHeadMesh.castShadow = true;
      pigSnoutMesh.castShadow = true;
      pigEarLMesh.castShadow = true;
      pigEarRMesh.castShadow = true;
      pigEyeLMesh.castShadow = false;
      pigEyeRMesh.castShadow = false;
      addAnimated(pigMesh, instances, pigGrazeConfig, [
        { mesh: pigHeadMesh,  offset: 0.22,  useHeadScale: true },
        { mesh: pigSnoutMesh, offset: 0.34,  snout: true, useSnoutScale: true },
        { mesh: pigEarLMesh,  pigEarL: true },
        { mesh: pigEarRMesh,  pigEarR: true },
        { mesh: pigEyeLMesh,  pigEyeL: true },
        { mesh: pigEyeRMesh,  pigEyeR: true },
        { mesh: pigTailMesh,  offset: -0.20, tail: true },
        { mesh: pigLegFLMesh, pigLegFL: true },
        { mesh: pigLegFRMesh, pigLegFR: true },
        { mesh: pigLegBLMesh, pigLegBL: true },
        { mesh: pigLegBRMesh, pigLegBR: true },
      ]);
    }

    // ── Chickens (and chicks) on GRASS tiles ────────────────────────────────
    const chickenTiles = grassTiles.filter(t => this._rng(t.x, t.z, 60) < 0.032);
    const chickenConfig = {
      label: 'Chicken', icon: '🐔',
      description: 'A clucking chicken pecking at the grass.',
      driftRadius: 0.08, driftSpeed: 0.4, bobAmount: 0.018, bobSpeed: 3.5,
      mobile: true, moveSpeed: 0.28, tileType: TileType.GRASS, wanderRadius: 3,
    };
    if (chickenTiles.length > 0) {
      const n = chickenTiles.length;
      const chickBodyGeom   = new THREE.SphereGeometry(0.13, 7, 5);
      const chickHeadGeom   = new THREE.SphereGeometry(0.07, 6, 4);
      const chickBeakGeom   = new THREE.ConeGeometry(0.011, 0.038, 3);
      const chickCombGeom   = new THREE.BoxGeometry(0.020, 0.036, 0.018);
      const chickWattleGeom = new THREE.SphereGeometry(0.016, 4, 3);
      const chickEyeGeom    = new THREE.SphereGeometry(0.011, 4, 3);
      const chickTailGeom   = new THREE.ConeGeometry(0.040, 0.095, 4);
      const chickLegGeom    = new THREE.CylinderGeometry(0.012, 0.010, 0.10, 4);
      const chickWingGeom   = new THREE.BoxGeometry(0.058, 0.038, 0.024);

      const chickBodyMat   = new THREE.MeshLambertMaterial({ color: 0xd4936a });
      const chickHeadMat   = new THREE.MeshLambertMaterial({ color: 0xd4936a });
      const chickRedMat    = new THREE.MeshLambertMaterial({ color: 0xcc2222 });
      const chickEyeMat    = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });
      const chickBeakMat   = new THREE.MeshLambertMaterial({ color: 0xc8940e });
      const chickLegMat    = new THREE.MeshLambertMaterial({ color: 0xc8940e });
      const chickWingMat   = new THREE.MeshLambertMaterial({ color: 0xb87050 });
      const chickTailMat   = new THREE.MeshLambertMaterial({ color: 0x7a4828 });

      const chickBodyMesh   = new THREE.InstancedMesh(chickBodyGeom, chickBodyMat, n);
      const chickHeadMesh   = new THREE.InstancedMesh(chickHeadGeom, chickHeadMat, n);
      const chickBeakMesh   = new THREE.InstancedMesh(chickBeakGeom, chickBeakMat, n);
      const chickCombMesh   = new THREE.InstancedMesh(chickCombGeom, chickRedMat, n);
      const chickWattleMesh = new THREE.InstancedMesh(chickWattleGeom, chickRedMat, n);
      const chickEyeLMesh   = new THREE.InstancedMesh(chickEyeGeom, chickEyeMat, n);
      const chickEyeRMesh   = new THREE.InstancedMesh(chickEyeGeom, chickEyeMat, n);
      const chickTailMesh   = new THREE.InstancedMesh(chickTailGeom, chickTailMat, n);
      const chickLegLMesh   = new THREE.InstancedMesh(chickLegGeom, chickLegMat, n);
      const chickLegRMesh   = new THREE.InstancedMesh(chickLegGeom, chickLegMat, n);
      const chickWingLMesh  = new THREE.InstancedMesh(chickWingGeom, chickWingMat, n);
      const chickWingRMesh  = new THREE.InstancedMesh(chickWingGeom, chickWingMat, n);

      // Adult colour palette: buff, russet, white, brown, red-brown
      const adultPalette = [0xc8a87a, 0xd4936a, 0xf0e8d0, 0x8a6040, 0xb86038];
      const _cc = new THREE.Color();

      const chickInstances = chickenTiles.map((tile, idx) => {
        const ox   = (this._rng(tile.x, tile.z, 61) - 0.5) * 0.90;
        const oz   = (this._rng(tile.x, tile.z, 62) - 0.5) * 0.90;
        const seed = this._rng(tile.x, tile.z, 63) * Math.PI * 2;
        const sr   = this._rng(tile.x, tile.z, 64);
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        // ~50% chicks (small, yellow), rest adult hens
        const isChick = sr < 0.50;
        const s = isChick ? 0.48 + sr * 0.28 : 0.82 + (sr - 0.50) * 0.30;
        if (isChick) {
          _cc.setHex(0xf0d060);
        } else {
          const ci = Math.floor((sr - 0.50) / 0.50 * adultPalette.length);
          _cc.setHex(adultPalette[Math.min(ci, adultPalette.length - 1)]);
        }
        chickBodyMesh.setColorAt(idx, _cc);
        chickHeadMesh.setColorAt(idx, _cc);
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.GRASS) + 0.18 * s,
          scale: [0.95 * s, 0.72 * s, 1.05 * s],
          headScale: [0.82 * s, 0.82 * s, 0.88 * s],
          chickSize: s,
          isChick,
          rotY: seed, seed,
        };
      });
      chickBodyMesh.instanceColor.needsUpdate = true;
      chickHeadMesh.instanceColor.needsUpdate = true;
      chickBodyMesh.castShadow = true;
      chickHeadMesh.castShadow = true;
      chickEyeLMesh.castShadow = false;
      chickEyeRMesh.castShadow = false;
      addAnimated(chickBodyMesh, chickInstances, chickenConfig, [
        { mesh: chickHeadMesh,   offset: 0.13, useHeadScale: true },
        { mesh: chickBeakMesh,   offset: 0.21, beak: true },
        { mesh: chickCombMesh,   chickComb: true },
        { mesh: chickWattleMesh, chickWattle: true },
        { mesh: chickEyeLMesh,   chickEyeL: true },
        { mesh: chickEyeRMesh,   chickEyeR: true },
        { mesh: chickTailMesh,   chickTail: true },
        { mesh: chickLegLMesh,   chickLegL: true },
        { mesh: chickLegRMesh,   chickLegR: true },
        { mesh: chickWingLMesh,  chickWingL: true },
        { mesh: chickWingRMesh,  chickWingR: true },
      ]);
      // Register nest locations so the simulation can track egg laying
      this.world.initChickenNests(chickenTiles.map(t => ({ x: t.x, z: t.z })));
    }

    // ── Birds on FOREST and GRASS tiles (mobile, improved sprites) ──────────
    const forestTiles = buckets[TileType.FOREST] ?? [];
    const birdForestTiles = forestTiles.filter(t => this._rng(t.x, t.z, 50) < 0.055);
    const birdGrassTiles = grassTiles.filter(t => this._rng(t.x, t.z, 51) < 0.045);
    const birdMobileConfig = {
      label: 'Bird', icon: '🐦',
      description: 'A small bird flitting between forest and field.',
      driftRadius: 0.12, driftSpeed: 1.5, bobAmount: 0.04, bobSpeed: 5,
      mobile: true, moveSpeed: 0.55, tileTypes: [TileType.GRASS, TileType.FOREST],
    };

    // Improved bird: rounded body + head + beak + eyes
    const birdBodyGeom = new THREE.SphereGeometry(0.065, 6, 4);
    const birdHeadGeom = new THREE.SphereGeometry(0.04, 4, 3);
    const birdBeakGeom = new THREE.ConeGeometry(0.012, 0.055, 4);
    const birdEyeGeom  = new THREE.SphereGeometry(0.013, 4, 3);
    const birdEyeMat   = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });

    const addBirds = (tiles, tileType, offset) => {
      if (tiles.length === 0) return;
      const bodyColor = tileType === TileType.FOREST ? 0x4a5568 : 0x718096;
      const birdBodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
      const birdHeadMat = new THREE.MeshLambertMaterial({ color: bodyColor });
      const birdBeakMat = new THREE.MeshLambertMaterial({ color: 0x8b7355 });
      const birdBodyMesh = new THREE.InstancedMesh(birdBodyGeom, birdBodyMat, tiles.length);
      const birdHeadMesh = new THREE.InstancedMesh(birdHeadGeom, birdHeadMat, tiles.length);
      const birdBeakMesh = new THREE.InstancedMesh(birdBeakGeom, birdBeakMat, tiles.length);
      const birdEyeLMesh = new THREE.InstancedMesh(birdEyeGeom,  birdEyeMat,  tiles.length);
      const birdEyeRMesh = new THREE.InstancedMesh(birdEyeGeom,  birdEyeMat,  tiles.length);
      birdEyeLMesh.castShadow = false;
      birdEyeRMesh.castShadow = false;
      const flyY = surfY(TileType.GRASS) + 0.5;
      const instances = tiles.map((tile) => {
        const ox = (this._rng(tile.x, tile.z, offset) - 0.5) * 0.8;
        const oz = (this._rng(tile.x, tile.z, offset + 1) - 0.5) * 0.8;
        const seed = this._rng(tile.x, tile.z, offset + 2) * Math.PI * 2;
        const tx = tile.x + 0.5 + ox * 0.5;
        const tz = tile.z + 0.5 + oz * 0.5;
        // ~25% fledglings (s 0.42–0.58), rest adults/larger (s 0.82–1.35)
        const sr = this._rng(tile.x, tile.z, offset + 3);
        const s  = sr < 0.25 ? 0.42 + sr * 0.64 : 0.82 + (sr - 0.25) * 0.71;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          baseY: flyY,
          scale: [s, 1.1 * s, 0.75 * s],
          headScale: [0.85 * s, s, 0.9 * s],
          rotY: seed,
          seed,
        };
      });
      addAnimated(birdBodyMesh, instances, birdMobileConfig, [
        { mesh: birdHeadMesh, offset: 0.07 },
        { mesh: birdBeakMesh, offset: 0.12, beak: true },
        { mesh: birdEyeLMesh, birdEyeL: true },
        { mesh: birdEyeRMesh, birdEyeR: true },
      ]);
    };
    addBirds(birdForestTiles, TileType.FOREST, 52);
    addBirds(birdGrassTiles, TileType.GRASS, 55);

    // ── Single hummingbird (one per world) ─────────────────────────────────
    const allBirdTiles = [...birdForestTiles, ...birdGrassTiles];
    if (allBirdTiles.length > 0) {
      const idx = Math.floor(allBirdTiles.length * 0.37) % allBirdTiles.length;
      const tile = allBirdTiles[idx];
      // Body: tapered cylinder (wider at chest, narrow at tail)
      const humBodyGeom = new THREE.CylinderGeometry(0.018, 0.032, 0.12, 6);
      const humBodyMat = new THREE.MeshStandardMaterial({ color: 0x0e6b30, metalness: 0.45, roughness: 0.35 });
      const humBodyMesh = new THREE.InstancedMesh(humBodyGeom, humBodyMat, 1);

      // Head: slightly larger sphere
      const humHeadGeom = new THREE.SphereGeometry(0.034, 6, 5);
      const humHeadMat = new THREE.MeshStandardMaterial({ color: 0x127a38, metalness: 0.5, roughness: 0.3 });
      const humHeadMesh = new THREE.InstancedMesh(humHeadGeom, humHeadMat, 1);

      // Gorget (iridescent throat patch): flattened sphere under the head
      const gorgetGeom = new THREE.SphereGeometry(0.026, 5, 4);
      const gorgetMat = new THREE.MeshStandardMaterial({ color: 0xff1a5e, metalness: 0.7, roughness: 0.2 });
      const gorgetMesh = new THREE.InstancedMesh(gorgetGeom, gorgetMat, 1);

      // Beak: long thin needle
      const humBeakGeom = new THREE.ConeGeometry(0.006, 0.10, 4);
      const humBeakMat = new THREE.MeshLambertMaterial({ color: 0x1a1008 });
      const humBeakMesh = new THREE.InstancedMesh(humBeakGeom, humBeakMat, 1);

      // Wings: two flat planes that will flutter in updateAnimals
      const wingGeom = new THREE.PlaneGeometry(0.07, 0.03);
      const wingMat = new THREE.MeshStandardMaterial({
        color: 0x1a6b40, metalness: 0.3, roughness: 0.4,
        transparent: true, opacity: 0.7, side: THREE.DoubleSide,
      });
      const wingLMesh = new THREE.InstancedMesh(wingGeom, wingMat, 1);
      const wingRMesh = new THREE.InstancedMesh(wingGeom, wingMat, 1);

      // Fan tail: small flattened cone
      const tailGeom = new THREE.ConeGeometry(0.022, 0.05, 4);
      const tailMat = new THREE.MeshStandardMaterial({ color: 0x0a4a20, metalness: 0.35, roughness: 0.4 });
      const tailMesh = new THREE.InstancedMesh(tailGeom, tailMat, 1);

      const ox = (this._rng(tile.x, tile.z, 88) - 0.5) * 0.6;
      const oz = (this._rng(tile.x, tile.z, 89) - 0.5) * 0.6;
      const seed = this._rng(tile.x, tile.z, 90) * Math.PI * 2;
      const tx = tile.x + 0.5 + ox * 0.5;
      const tz = tile.z + 0.5 + oz * 0.5;
      const humInstances = [{
        x: tx, z: tz, targetX: tx, targetZ: tz,
        baseY: surfY(TileType.GRASS) + 0.55,
        scale: [0.9, 1.1, 0.9],
        headScale: [0.95, 1, 1],
        rotY: seed,
        seed,
      }];
      // Sparkle: 8 bright points that orbit the hummingbird
      const sparkleCount = 8;
      const sparklePosArr = new Float32Array(sparkleCount * 3);
      const sparkleGeom = new THREE.BufferGeometry();
      sparkleGeom.setAttribute('position', new THREE.BufferAttribute(sparklePosArr, 3));
      const sparkleMat = new THREE.PointsMaterial({
        color: 0x88ffdd, size: 0.05, transparent: true, opacity: 0.75, depthWrite: false,
      });
      const sparklePoints = new THREE.Points(sparkleGeom, sparkleMat);
      this.scene.add(sparklePoints);
      this._meshes.push(sparklePoints);

      const humConfig = {
        label: 'Hummingbird', icon: '🦜',
        description: 'A tiny jewel-green hummingbird — the only one in the world.',
        driftRadius: 0.08, driftSpeed: 3, bobAmount: 0.03, bobSpeed: 8,
        mobile: true, moveSpeed: 0.7, tileTypes: [TileType.GRASS, TileType.FOREST],
        sparkle: sparklePoints,
        hummingbird: true,
      };
      const humEyeGeom  = new THREE.SphereGeometry(0.010, 4, 3);
      const humEyeMat   = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });
      const humEyeLMesh = new THREE.InstancedMesh(humEyeGeom, humEyeMat, 1);
      const humEyeRMesh = new THREE.InstancedMesh(humEyeGeom, humEyeMat, 1);
      humEyeLMesh.castShadow = false;
      humEyeRMesh.castShadow = false;
      addAnimated(humBodyMesh, humInstances, humConfig, [
        { mesh: humHeadMesh, offset: 0.07 },
        { mesh: gorgetMesh, offset: 0.055, gorget: true },
        { mesh: humBeakMesh, offset: 0.13, beak: true },
        { mesh: wingLMesh, offset: 0.0, wingL: true },
        { mesh: wingRMesh, offset: 0.0, wingR: true },
        { mesh: tailMesh, offset: -0.07, tail: true },
        { mesh: humEyeLMesh, birdEyeL: true },
        { mesh: humEyeRMesh, birdEyeR: true },
      ]);
    }

    // ── Single Whale in DEEP_WATER ──────────────────────────────────────────
    const whaleDeepTiles = buckets[TileType.DEEP_WATER] ?? [];
    if (whaleDeepTiles.length > 0) {
      const wIdx = Math.floor(whaleDeepTiles.length * 0.5) % whaleDeepTiles.length;
      const wTile = whaleDeepTiles[wIdx];

      // Long torpedo body
      const whaleBodyGeom = new THREE.SphereGeometry(0.24, 14, 10);
      const whaleBodyMat = new THREE.MeshLambertMaterial({ color: 0x2a3d5a });
      const whaleMesh = new THREE.InstancedMesh(whaleBodyGeom, whaleBodyMat, 1);

      // Belly / ventral pale patch
      const bellyGeom = new THREE.SphereGeometry(0.22, 10, 7);
      const bellyMat = new THREE.MeshLambertMaterial({ color: 0x8ab4cc });
      const bellyMesh = new THREE.InstancedMesh(bellyGeom, bellyMat, 1);

      // Tail flukes — two big flat horizontal lobes
      const flukeGeom = new THREE.SphereGeometry(0.18, 8, 6);
      const flukeMat = new THREE.MeshLambertMaterial({ color: 0x1a2838 });
      const flukeL = new THREE.InstancedMesh(flukeGeom, flukeMat, 1);
      const flukeR = new THREE.InstancedMesh(flukeGeom, flukeMat, 1);

      const ox = (this._rng(wTile.x, wTile.z, 91) - 0.5) * 0.5;
      const oz = (this._rng(wTile.x, wTile.z, 92) - 0.5) * 0.5;
      const wSeed = this._rng(wTile.x, wTile.z, 93) * Math.PI * 2;
      const wx = wTile.x + 0.5 + ox;
      const wz = wTile.z + 0.5 + oz;

      const whaleInstances = [{
        x: wx, z: wz, targetX: wx, targetZ: wz,
        homeX: wTile.x, homeZ: wTile.z,
        baseY: surfY(TileType.DEEP_WATER) + 0.06,
        scale: [1.6, 1.1, 3.2],
        rotY: wSeed, seed: wSeed,
      }];
      // Blowhole: once per in-game day at noon (game clock); tall + readable on water
      const mkSpoutLayer = (count, matOpts) => {
        const pos = new Float32Array(count * 3);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
          transparent: true,
          depthWrite: false,
          sizeAttenuation: true,
          ...matOpts,
        });
        const pts = new THREE.Points(geom, mat);
        this.scene.add(pts);
        this._meshes.push(pts);
        const particles = Array.from({ length: count }, () => ({
          life: 0,
          maxLife: 1,
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
        }));
        return { points: pts, particles, geom, mat };
      };
      const mistLayer = mkSpoutLayer(128, {
        color: 0xffffff,
        size: 0.2,
        opacity: 0.55,
        blending: THREE.NormalBlending,
      });
      const sprayLayer = mkSpoutLayer(72, {
        color: 0xd8f4ff,
        size: 0.09,
        opacity: 0.95,
      });

      const whaleConfig = {
        label: 'Whale', icon: '🐋',
        description: 'A great whale, sole sovereign of the deep — ancient and unhurried.',
        driftRadius: 0.05, driftSpeed: 0.08, bobAmount: 0.09, bobSpeed: 0.5,
        mobile: true, moveSpeed: 0.08, tileTypes: [TileType.DEEP_WATER], wanderRadius: 7,
        constrainToTypes: [TileType.DEEP_WATER],
        whaleSpout: { mist: mistLayer, spray: sprayLayer },
      };
      const whaleEyeGeom = new THREE.SphereGeometry(0.048, 6, 5);
      const whaleEyeMat  = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });
      const whaleEyeL    = new THREE.InstancedMesh(whaleEyeGeom, whaleEyeMat, 1);
      const whaleEyeR    = new THREE.InstancedMesh(whaleEyeGeom, whaleEyeMat, 1);
      whaleMesh.castShadow = true;
      bellyMesh.castShadow = true;
      flukeL.castShadow = true;
      flukeR.castShadow = true;
      whaleEyeL.castShadow = false;
      whaleEyeR.castShadow = false;
      addAnimated(whaleMesh, whaleInstances, whaleConfig, [
        { mesh: bellyMesh,  offset: 0,     whaleBelly: true },
        { mesh: flukeL,     offset: -0.85, flukeL: true },
        { mesh: flukeR,     offset: -0.85, flukeR: true },
        { mesh: whaleEyeL,  whaleEyeL: true },
        { mesh: whaleEyeR,  whaleEyeR: true },
      ]);
    }

    // ── Crabs on BEACH tiles ──────────────────────────────────────────────
    const beachAnimalTiles = (buckets[TileType.BEACH] ?? []).filter(t => this._rng(t.x, t.z, 90) < 0.10);
    if (beachAnimalTiles.length > 0) {
      const bodyGeom   = new THREE.SphereGeometry(0.075, 6, 4);
      const clawGeom   = new THREE.SphereGeometry(0.038, 5, 4);
      const eyeGeom    = new THREE.SphereGeometry(0.022, 5, 4);
      const pupilGeom  = new THREE.SphereGeometry(0.012, 4, 3);
      const bodyMat    = new THREE.MeshLambertMaterial({ color: 0xcc4418 });
      const clawMat    = new THREE.MeshLambertMaterial({ color: 0xaa3210 });
      const eyeMat     = new THREE.MeshLambertMaterial({ color: 0xf0e8d0 });
      const pupilMat   = new THREE.MeshLambertMaterial({ color: 0x111111 });
      const bodyMesh   = new THREE.InstancedMesh(bodyGeom,  bodyMat,  beachAnimalTiles.length);
      const clawLMesh  = new THREE.InstancedMesh(clawGeom,  clawMat,  beachAnimalTiles.length);
      const clawRMesh  = new THREE.InstancedMesh(clawGeom,  clawMat,  beachAnimalTiles.length);
      const eyeLMesh   = new THREE.InstancedMesh(eyeGeom,   eyeMat,   beachAnimalTiles.length);
      const eyeRMesh   = new THREE.InstancedMesh(eyeGeom,   eyeMat,   beachAnimalTiles.length);
      const pupilLMesh = new THREE.InstancedMesh(pupilGeom, pupilMat, beachAnimalTiles.length);
      const pupilRMesh = new THREE.InstancedMesh(pupilGeom, pupilMat, beachAnimalTiles.length);

      const crabInstances = beachAnimalTiles.map(tile => {
        const ox   = (this._rng(tile.x, tile.z, 91) - 0.5) * 1.0;
        const oz   = (this._rng(tile.x, tile.z, 92) - 0.5) * 1.0;
        const seed = this._rng(tile.x, tile.z, 93) * Math.PI * 2;
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        // ~25% tiny crabs (s 0.35–0.55), rest adults/large (s 0.80–1.20)
        const sr = this._rng(tile.x, tile.z, 95);
        const s  = sr < 0.25 ? 0.35 + sr * 0.80 : 0.80 + (sr - 0.25) * 0.53;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.BEACH) + 0.02,
          scale: [1.6 * s, 0.5 * s, 1.0 * s],
          rotY: seed, seed,
          crabSide: this._rng(tile.x, tile.z, 94) < 0.5 ? 1 : -1,
          crabSize: s,
        };
      });

      const crabConfig = {
        label: 'Crab', icon: '🦀',
        description: 'A little crab scuttling along the shore.',
        driftRadius: 0, driftSpeed: 0, bobAmount: 0.008, bobSpeed: 6,
        mobile: true, moveSpeed: 0.5, tileTypes: [TileType.BEACH], wanderRadius: 3,
        wagAmp: 0.07, wagFreq: 9.0, burstCoast: true, crabWalk: true,
      };
      bodyMesh.castShadow   = false;
      clawLMesh.castShadow  = false;
      clawRMesh.castShadow  = false;
      eyeLMesh.castShadow   = false;
      eyeRMesh.castShadow   = false;
      pupilLMesh.castShadow = false;
      pupilRMesh.castShadow = false;
      addAnimated(bodyMesh, crabInstances, crabConfig, [
        { mesh: clawLMesh,  crabClawL:   true },
        { mesh: clawRMesh,  crabClawR:   true },
        { mesh: eyeLMesh,   crabEyeL:    true },
        { mesh: eyeRMesh,   crabEyeR:    true },
        { mesh: pupilLMesh, crabPupilL:  true },
        { mesh: pupilRMesh, crabPupilR:  true },
      ]);
    }

    // ── Single Golden Frog ─────────────────────────────────────────────────
    const grassTilesForFrog = (buckets[TileType.GRASS] ?? []).filter(t =>
      this.world.hasAdjacentType(t.x, t.z, TileType.WATER) ||
      this.world.hasAdjacentType(t.x, t.z, TileType.BEACH)
    );
    const frogSpawnPool = grassTilesForFrog.length > 0
      ? grassTilesForFrog
      : (buckets[TileType.BEACH] ?? []);
    if (frogSpawnPool.length > 0) {
      const fIdx = Math.floor(frogSpawnPool.length * 0.61) % frogSpawnPool.length;
      const fTile = frogSpawnPool[fIdx];

      // Body: squished sphere (wide, flat — classic frog silhouette)
      const frogBodyGeom = new THREE.SphereGeometry(0.09, 8, 6);
      frogBodyGeom.scale(1.2, 0.7, 1.0);
      const frogBodyMat = new THREE.MeshStandardMaterial({
        color: 0xFFD700, metalness: 0.55, roughness: 0.28,
      });
      const frogBodyMesh = new THREE.InstancedMesh(frogBodyGeom, frogBodyMat, 1);

      // Eyes: two small golden spheres on top
      const frogEyeGeom = new THREE.SphereGeometry(0.032, 6, 5);
      const frogEyeMat = new THREE.MeshStandardMaterial({
        color: 0xFFE566, metalness: 0.6, roughness: 0.2,
      });
      const frogEyeLMesh = new THREE.InstancedMesh(frogEyeGeom, frogEyeMat, 1);
      const frogEyeRMesh = new THREE.InstancedMesh(frogEyeGeom, frogEyeMat, 1);

      // Eye pupils: tiny dark spheres
      const pupilGeom = new THREE.SphereGeometry(0.016, 5, 4);
      const pupilMat = new THREE.MeshLambertMaterial({ color: 0x1a0a00 });
      const pupilLMesh = new THREE.InstancedMesh(pupilGeom, pupilMat, 1);
      const pupilRMesh = new THREE.InstancedMesh(pupilGeom, pupilMat, 1);

      // Back legs: flattened cylinders
      const frogLegGeom = new THREE.CylinderGeometry(0.018, 0.014, 0.09, 5);
      const frogLegMat = new THREE.MeshStandardMaterial({
        color: 0xFFBB00, metalness: 0.45, roughness: 0.35,
      });
      const frogLegLMesh = new THREE.InstancedMesh(frogLegGeom, frogLegMat, 1);
      const frogLegRMesh = new THREE.InstancedMesh(frogLegGeom, frogLegMat, 1);

      const fox = (this._rng(fTile.x, fTile.z, 95) - 0.5) * 0.6;
      const foz = (this._rng(fTile.x, fTile.z, 96) - 0.5) * 0.6;
      const fseed = this._rng(fTile.x, fTile.z, 97) * Math.PI * 2;
      const ftx = fTile.x + 0.5 + fox * 0.5;
      const ftz = fTile.z + 0.5 + foz * 0.5;
      const frogInstances = [{
        x: ftx, z: ftz, targetX: ftx, targetZ: ftz,
        homeX: fTile.x, homeZ: fTile.z,
        baseY: surfY(TileType.GRASS) + 0.06,
        scale: [1, 1, 1],
        rotY: fseed, seed: fseed,
      }];

      // Golden sparkles: 12 bright points orbiting the frog
      const frogSparkleCount = 12;
      const frogSparklePosArr = new Float32Array(frogSparkleCount * 3);
      const frogSparkleGeom = new THREE.BufferGeometry();
      frogSparkleGeom.setAttribute('position', new THREE.BufferAttribute(frogSparklePosArr, 3));
      const frogSparkleMat = new THREE.PointsMaterial({
        color: 0xFFD700, size: 0.055, transparent: true, opacity: 0.85, depthWrite: false,
      });
      const frogSparklePoints = new THREE.Points(frogSparkleGeom, frogSparkleMat);
      this.scene.add(frogSparklePoints);
      this._meshes.push(frogSparklePoints);

      const frogConfig = {
        label: 'Golden Frog', icon: '🐸',
        description: 'A rare golden frog shimmering with magic. Only one exists in this world.',
        driftRadius: 0.05, driftSpeed: 0.8, bobAmount: 0.018, bobSpeed: 3.2,
        mobile: true, moveSpeed: 0.22, tileTypes: [TileType.GRASS, TileType.BEACH],
        wanderRadius: 3,
        sparkle: frogSparklePoints,
        goldenFrog: true,
      };
      addAnimated(frogBodyMesh, frogInstances, frogConfig, [
        { mesh: frogEyeLMesh,  frogEyeL: true },
        { mesh: frogEyeRMesh,  frogEyeR: true },
        { mesh: pupilLMesh,    frogPupilL: true },
        { mesh: pupilRMesh,    frogPupilR: true },
        { mesh: frogLegLMesh,  frogLegL: true },
        { mesh: frogLegRMesh,  frogLegR: true },
      ]);
    }

    // ── Glowing desert beetles ────────────────────────────────────────────
    const desertPool = buckets[TileType.DESERT] ?? [];
    if (desertPool.length > 0) {
      const N    = Math.min(8, Math.max(4, Math.floor(desertPool.length * 0.05)));
      const step = Math.floor(desertPool.length / N);
      const beetleTiles = Array.from({ length: N }, (_, i) => {
        const idx = (i * step + Math.floor(this._rng(i, 0, 110) * step)) % desertPool.length;
        return desertPool[idx];
      });

      const bSurfY = surfY(TileType.DESERT);

      // Carapace: oval, nearly black with teal-green emissive glow
      const beetleBodyGeom = new THREE.SphereGeometry(0.065, 8, 6);
      beetleBodyGeom.scale(1.4, 0.55, 1.0);
      const beetleBodyMat = new THREE.MeshStandardMaterial({
        color: 0x080d14, emissive: new THREE.Color(0x00ffaa),
        emissiveIntensity: 0.9, metalness: 0.92, roughness: 0.10,
      });
      const beetleBodyMesh = new THREE.InstancedMesh(beetleBodyGeom, beetleBodyMat, N);

      // Head: small sphere, same emissive
      const beetleHeadGeom = new THREE.SphereGeometry(0.028, 7, 5);
      const beetleHeadMat = new THREE.MeshStandardMaterial({
        color: 0x060c12, emissive: new THREE.Color(0x00cc88),
        emissiveIntensity: 0.7, metalness: 0.9, roughness: 0.15,
      });
      const beetleHeadMesh = new THREE.InstancedMesh(beetleHeadGeom, beetleHeadMat, N);

      // Antennae: thin cylinders that wag
      const beetleAntennaGeom = new THREE.CylinderGeometry(0.005, 0.003, 0.10, 4);
      const beetleAntennaMat = new THREE.MeshStandardMaterial({
        color: 0x050505, emissive: new THREE.Color(0x00aa66), emissiveIntensity: 0.5,
      });
      const beetleAntennaLMesh = new THREE.InstancedMesh(beetleAntennaGeom, beetleAntennaMat, N);
      const beetleAntennaRMesh = new THREE.InstancedMesh(beetleAntennaGeom, beetleAntennaMat, N);

      // Glow halo: 6 orbiting points per beetle
      const SPB = 6;
      const beetleGlowGeom = new THREE.BufferGeometry();
      beetleGlowGeom.setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(N * SPB * 3), 3));
      const beetleGlowMat = new THREE.PointsMaterial({
        color: 0x44ffbb, size: 0.040, transparent: true, opacity: 0.7, depthWrite: false,
      });
      const beetleGlowPoints = new THREE.Points(beetleGlowGeom, beetleGlowMat);
      this.scene.add(beetleGlowPoints);
      this._meshes.push(beetleGlowPoints);

      const beetleInstances = beetleTiles.map((tile, i) => {
        const ox   = (this._rng(tile.x, tile.z, 111) - 0.5) * 0.8;
        const oz   = (this._rng(tile.x, tile.z, 112) - 0.5) * 0.8;
        const bx   = tile.x + 0.5 + ox * 0.5;
        const bz   = tile.z + 0.5 + oz * 0.5;
        const seed = this._rng(tile.x, tile.z, 113) * Math.PI * 2;
        return {
          x: bx, z: bz, targetX: bx, targetZ: bz,
          homeX: tile.x, homeZ: tile.z,
          baseY: bSurfY + 0.036,
          scale: [1, 1, 1],
          rotY: seed, seed,
        };
      });

      addAnimated(beetleBodyMesh, beetleInstances, {
        label: 'Glowing Beetle', icon: '🪲',
        description: 'A rare bioluminescent beetle — its carapace shimmers with an eerie teal glow.',
        driftRadius: 0.03, driftSpeed: 0.5, bobAmount: 0.004, bobSpeed: 4.0,
        mobile: true, moveSpeed: 0.10, tileType: TileType.DESERT, wanderRadius: 5,
        sparkle: beetleGlowPoints, desertBeetle: true, sparksPerBeetle: SPB,
      }, [
        { mesh: beetleHeadMesh,     beetleHead: true },
        { mesh: beetleAntennaLMesh, beetleAntennaL: true },
        { mesh: beetleAntennaRMesh, beetleAntennaR: true },
      ]);
    }
  }

  /**
   * Update animal instance positions.
   * @param realDelta — sim delta (0 when paused)
   * @param timeOpts — { gameTime, dayLength } for whale spout once per in-game day at noon
   */
  updateAnimals(realDelta, timeOpts = null) {
    this._animTime += realDelta;
    const t = this._animTime;

    // Advance water surface shader time
    for (const u of this._waterTimeUniforms) u.time.value = t;

    // ── Tumbleweeds ──────────────────────────────────────────────────────
    if (this._tumbleweeds?.length && realDelta > 0) {
      const surfY = TerrainRenderer.surfaceY(TileType.DESERT);
      for (const tw of this._tumbleweeds) {
        // Wind gust timer: periodically kick the tumbleweed in a new direction
        tw.windTimer -= realDelta;
        if (tw.windTimer <= 0) {
          const ang = Math.random() * Math.PI * 2;
          const spd = 0.5 + Math.random() * 2.0;
          tw.vx = Math.cos(ang) * spd;
          tw.vz = Math.sin(ang) * spd;
          tw.windTimer = 2.5 + Math.random() * 5.5;
        }

        // Air drag — velocity decays between gusts
        const drag = Math.pow(0.08, realDelta);
        tw.vx *= drag;
        tw.vz *= drag;

        // Attempt move; bounce back if leaving desert
        const nx = tw.x + tw.vx * realDelta;
        const nz = tw.z + tw.vz * realDelta;
        const nTile = this.world.getTile(Math.floor(nx / TILE_SIZE), Math.floor(nz / TILE_SIZE));
        if (nTile?.type === TileType.DESERT) {
          tw.x = nx;
          tw.z = nz;
        } else {
          tw.vx *= -0.6;
          tw.vz *= -0.6;
        }

        // Rolling rotation: sphere rolling along velocity vector
        // moving +X → rotate around -Z; moving +Z → rotate around +X
        const rollRate = 4.0;
        tw.group.rotation.z -= tw.vx * realDelta * rollRate;
        tw.group.rotation.x += tw.vz * realDelta * rollRate;

        tw.group.position.set(tw.x, surfY + 0.19 * tw.sc, tw.z);
      }
    }

    const ARRIVAL_DIST = 0.08;

    for (const { mesh, parts, instances, config } of this._animatedAnimals) {
      const { driftRadius, driftSpeed, bobAmount, bobSpeed, mobile, moveSpeed, tileType, tileTypes } = config;
      const types = tileTypes ?? (tileType ? [tileType] : null);
      const dummy = new THREE.Object3D();

      instances.forEach((inst, i) => {
        if (mobile && moveSpeed && types) {
          const dx = inst.targetX - inst.x;
          const dz = inst.targetZ - inst.z;
          const dist = Math.hypot(dx, dz);
          if (dist < ARRIVAL_DIST) {
            // Home-anchored wander
            const homeX = inst.homeX ?? Math.round(inst.x);
            const homeZ = inst.homeZ ?? Math.round(inst.z);
            if (inst.homeX === undefined) { inst.homeX = homeX; inst.homeZ = homeZ; }
            const wr = config.wanderRadius ?? 6;
            let picked = false;
            for (let attempt = 0; attempt < 20; attempt++) {
              const ox = Math.round((Math.random() - 0.5) * wr * 2);
              const oz = Math.round((Math.random() - 0.5) * wr * 2);
              const cTile = this.world.getTile(homeX + ox, homeZ + oz);
              if (cTile && types.includes(cTile.type)) {
                inst.targetX = cTile.x + 0.5;
                inst.targetZ = cTile.z + 0.5;
                picked = true;
                break;
              }
            }
            if (!picked) {
              inst.targetX = homeX + 0.5;
              inst.targetZ = homeZ + 0.5;
            }
            // Kick off a burst when a new target is chosen
            if (config.burstCoast) inst._burstRemain = 0.25 + Math.random() * 0.45;
          } else if (dist > 0.01) {
            // Burst-and-coast speed
            let spd = moveSpeed;
            if (config.burstCoast) {
              if (inst._burstRemain > 0) {
                inst._burstRemain = Math.max(0, inst._burstRemain - realDelta);
                spd = moveSpeed * (config.burstMult ?? 2.4);
              } else {
                spd = moveSpeed * 0.22; // gentle glide
                // Fish spontaneously dart: random re-burst during coast
                if (config.fishSwim && Math.random() < realDelta * 0.18) {
                  inst._burstRemain = 0.10 + Math.random() * 0.22;
                }
              }
            }
            const move = Math.min(spd * realDelta, dist);
            const nx = inst.x + (dx / dist) * move;
            const nz = inst.z + (dz / dist) * move;
            // Constrain to valid tile types mid-path (keeps whale inside deep water)
            if (config.constrainToTypes) {
              const nTile = this.world.getTile(Math.floor(nx), Math.floor(nz));
              if (nTile && config.constrainToTypes.includes(nTile.type)) {
                inst.x = nx; inst.z = nz;
              } else {
                // Invalid tile — redirect target back to home
                inst.targetX = (inst.homeX ?? Math.round(inst.x)) + 0.5;
                inst.targetZ = (inst.homeZ ?? Math.round(inst.z)) + 0.5;
              }
            } else {
              inst.x = nx; inst.z = nz;
            }
            // Fish-swim: sinusoidal lateral drift gives S-curve swimming paths.
            // Amplitude fades to zero as fish nears its target so it arrives cleanly.
            if (config.fishSwim && dist > 0.01) {
              const perpX =  dz / dist;
              const perpZ = -dx / dist;
              const fade  = Math.min(1, dist * 4);  // fades over last 0.25 tiles
              const curve = Math.sin(t * config.swimCurveFreq + inst.seed * 7.39)
                          * config.swimCurveAmp * realDelta * fade;
              inst.x += perpX * curve;
              inst.z += perpZ * curve;
            }
            // Smooth turn toward target
            const targetRY = Math.atan2(inst.targetX - inst.x, inst.targetZ - inst.z);
            if (config.crabWalk) {
              // Crabs face sideways relative to movement direction
              inst.rotY = targetRY + (Math.PI / 2) * (inst.crabSide ?? 1);
            } else if (config.turnSpeed) {
              let da = targetRY - inst.rotY;
              while (da > Math.PI) da -= Math.PI * 2;
              while (da < -Math.PI) da += Math.PI * 2;
              inst.rotY += Math.sign(da) * Math.min(Math.abs(da), config.turnSpeed * realDelta);
            } else {
              inst.rotY = targetRY;
            }
          }
        }

        const phase = inst.seed;
        const driftX = driftRadius * Math.sin(t * driftSpeed + phase);
        const driftZ = driftRadius * Math.cos(t * driftSpeed + phase * 1.3);
        const bob = bobAmount * Math.sin(t * bobSpeed + phase * 0.7);
        const px = (inst.x !== undefined ? inst.x * TILE_SIZE : inst.baseX) + driftX;
        const py = (inst.baseY ?? 0) + bob;
        const pz = (inst.z !== undefined ? inst.z * TILE_SIZE : inst.baseZ) + driftZ;

        // Store world-space position for sparkle use (all instances — beetles use multi-instance)
        if (config.sparkle) {
          inst._sparkleX = px; inst._sparkleY = py; inst._sparkleZ = pz;
        }

        // Whale: one blow per in-game day at noon (HUD "Day N" clock). Easier to spot: taller plume.
        if (config.whaleSpout && i === 0) {
          const { mist, spray } = config.whaleSpout;
          const dayLen = timeOpts?.dayLength ?? 120;
          const gTime = timeOpts?.gameTime ?? this._animTime;
          const ry0 = inst.rotY;
          const forward = 0.32;
          const bhX = px + Math.sin(ry0) * forward;
          const bhY = py + Math.max(0.22, inst.scale[1] * 0.2) + 0.12;
          const bhZ = pz + Math.cos(ry0) * forward;
          if (inst._nextWhaleSpoutGameT === undefined) {
            const d0 = Math.floor(gTime / dayLen);
            let target = d0 * dayLen + 0.5 * dayLen;
            if (gTime >= target - 1e-6) target += dayLen;
            inst._nextWhaleSpoutGameT = target;
          }

          const spawnMist = (n) => {
            let s = 0;
            for (const p of mist.particles) {
              if (s >= n) break;
              if (p.life <= 0) {
                p.x = bhX + (Math.random() - 0.5) * 0.1;
                p.y = bhY;
                p.z = bhZ + (Math.random() - 0.5) * 0.1;
                p.vx = (Math.random() - 0.5) * 0.35;
                p.vy = 0.55 + Math.random() * 0.75;
                p.vz = (Math.random() - 0.5) * 0.35;
                p.maxLife = 1.0 + Math.random() * 1.15;
                p.life = p.maxLife;
                s++;
              }
            }
          };
          const spawnSpray = (n) => {
            let s = 0;
            for (const p of spray.particles) {
              if (s >= n) break;
              if (p.life <= 0) {
                p.x = bhX + (Math.random() - 0.5) * 0.05;
                p.y = bhY + 0.02;
                p.z = bhZ + (Math.random() - 0.5) * 0.05;
                p.vx = (Math.random() - 0.5) * 0.22;
                p.vy = 0.85 + Math.random() * 0.95;
                p.vz = (Math.random() - 0.5) * 0.22;
                p.maxLife = 0.55 + Math.random() * 0.55;
                p.life = p.maxLife;
                s++;
              }
            }
          };

          // First frame after world load: guaranteed spout (pan to deep ocean to see it)
          if (!inst._whaleLoadSpoutDone) {
            inst._whaleLoadSpoutDone = true;
            spawnMist(mist.particles.length);
            spawnSpray(spray.particles.length);
          }

          const doDailySpout = gTime >= inst._nextWhaleSpoutGameT;
          if (doDailySpout) {
            inst._nextWhaleSpoutGameT += dayLen;
            spawnMist(mist.particles.length);
            spawnSpray(spray.particles.length);
          }

          let mistActive = 0;
          for (let pi = 0; pi < mist.particles.length; pi++) {
            const p = mist.particles[pi];
            const arr = mist.geom.attributes.position.array;
            if (p.life > 0) {
              mistActive++;
              p.life -= realDelta;
              p.vx *= 1 - 0.35 * realDelta;
              p.vz *= 1 - 0.35 * realDelta;
              p.vy *= 1 - 0.22 * realDelta;
              p.vy -= 0.22 * realDelta;
              p.x += p.vx * realDelta;
              p.y += p.vy * realDelta;
              p.z += p.vz * realDelta;
              arr[pi * 3] = p.x;
              arr[pi * 3 + 1] = p.y;
              arr[pi * 3 + 2] = p.z;
            } else {
              arr[pi * 3] = 0;
              arr[pi * 3 + 1] = -800;
              arr[pi * 3 + 2] = 0;
            }
          }
          mist.geom.attributes.position.needsUpdate = true;
          mist.mat.opacity = 0.22 + Math.min(0.42, mistActive * 0.0045);

          for (let pi = 0; pi < spray.particles.length; pi++) {
            const p = spray.particles[pi];
            const arr = spray.geom.attributes.position.array;
            if (p.life > 0) {
              p.life -= realDelta;
              p.vx *= 1 - 0.5 * realDelta;
              p.vz *= 1 - 0.5 * realDelta;
              p.vy -= 1.05 * realDelta;
              p.x += p.vx * realDelta;
              p.y += p.vy * realDelta;
              p.z += p.vz * realDelta;
              arr[pi * 3] = p.x;
              arr[pi * 3 + 1] = p.y;
              arr[pi * 3 + 2] = p.z;
            } else {
              arr[pi * 3] = 0;
              arr[pi * 3 + 1] = -800;
              arr[pi * 3 + 2] = 0;
            }
          }
          spray.geom.attributes.position.needsUpdate = true;
          let sprayActive = 0;
          for (const p of spray.particles) if (p.life > 0) sprayActive++;
          spray.mat.opacity =
            sprayActive > 0 ? 0.72 + Math.min(0.22, sprayActive * 0.014) : 0.88;
        }

        const ry = inst.rotY;
        // Body undulation: fish waggle their whole body side-to-side
        const wagAmp = config.wagAmp ?? 0;
        const wagFreq = config.wagFreq ?? 3.5;
        const wag = wagAmp > 0 ? Math.sin(t * wagFreq + phase) * wagAmp : 0;

        dummy.position.set(px, py, pz);
        dummy.scale.set(inst.scale[0], inst.scale[1], inst.scale[2]);
        dummy.rotation.y = ry + wag;
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        for (const part of parts) {
          const hs = part.useHeadScale && inst.headScale ? inst.headScale
            : part.useSnoutScale && inst.snoutScale ? inst.snoutScale
            : inst.scale;
          if (part.wingL || part.wingR) {
            // Hummingbird wings: flutter rapidly, offset to the sides
            const side = part.wingL ? -1 : 1;
            const flutter = Math.sin(t * 45 + (part.wingR ? Math.PI : 0)) * 1.2;
            const perpX = Math.cos(ry) * side * 0.04;
            const perpZ = -Math.sin(ry) * side * 0.04;
            dummy.position.set(px + perpX, py + 0.01, pz + perpZ);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.order = 'ZYX';
            dummy.rotation.y = ry;
            dummy.rotation.z = flutter * side;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.gorget) {
            // Throat patch: just below and in front of head
            const gx = px + Math.sin(ry) * part.offset;
            const gz = pz + Math.cos(ry) * part.offset;
            dummy.position.set(gx, py - 0.012, gz);
            dummy.scale.set(0.9, 0.5, 0.7);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.fin) {
            // Dorsal fin: rides with the body undulation
            dummy.position.set(px, py + inst.scale[1] * 0.1, pz);
            dummy.scale.set(0.75, 1.1, 0.38);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + wag;
            dummy.rotation.x = -Math.PI / 2;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.whaleBelly) {
            // Pale ventral patch — pressed flat along the underside
            dummy.position.set(px, py - inst.scale[1] * 0.10, pz);
            dummy.scale.set(inst.scale[0] * 0.80, 0.22, inst.scale[2] * 0.88);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.whaleHead) {
            // Big blunt rounded head at the front — characteristic whale shape
            const hx = px + Math.sin(ry) * part.offset;
            const hz = pz + Math.cos(ry) * part.offset;
            dummy.position.set(hx, py, hz);
            dummy.scale.set(1.05, 0.95, 1.15);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.dorsal) {
            // Tall swept-back dorsal fin on mid-back
            const mx = px + Math.sin(ry) * part.offset;
            const mz = pz + Math.cos(ry) * part.offset;
            dummy.position.set(mx, py + inst.scale[1] * 0.16 + 0.06, mz);
            dummy.scale.set(0.28, 1.0, 0.12);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0.55;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.flukeL || part.flukeR) {
            const side = part.flukeL ? 1 : -1;
            const tailStem = 0.80;
            const tailX = px - Math.sin(ry) * tailStem;
            const tailZ = pz - Math.cos(ry) * tailStem;
            // Periodic tail slap: slow cycle (~9s), only the rising peak is visible
            const raw = Math.sin(t * 0.7 + phase);
            const slapFlap = Math.max(0, raw - 0.5) / 0.5; // 0 most of the time, peaks to 1
            const flukeY = py - 0.10 + slapFlap * 0.60; // breaches well above waterline
            // Lateral spread
            const latX = Math.cos(ry) * side * 0.14;
            const latZ = -Math.sin(ry) * side * 0.14;
            dummy.position.set(tailX + latX, flukeY, tailZ + latZ);
            // scale.z SMALL → flukes are flat/horizontal; scale.x LARGE → wide spread
            dummy.scale.set(3.2, 0.65, 0.10);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + side * 0.36;
            // Tip pitches from flat (resting) to nearly vertical (breach) during slap
            dummy.rotation.x = -Math.PI / 2 + 0.10 + slapFlap * (Math.PI / 2 - 0.1);
            dummy.rotation.z = side * 0.08;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.fishTailL || part.fishTailR) {
            // Forked caudal fin lobe — placed behind the body and beats side-to-side
            const side = part.fishTailL ? 1 : -1;
            // Use part.offset (world units), scaled with fish size
            const tailDist = (part.offset ?? 0.18) * inst.scale[2];
            const tailX = px - Math.sin(ry + wag) * tailDist;
            const tailZ = pz - Math.cos(ry + wag) * tailDist;
            // Tail beats faster during burst, slow gentle sweep when coasting
            const tailBeat = inst._burstRemain > 0
              ? wagFreq * 1.5
              : (wagAmp > 0 ? wagFreq * 0.55 : 3.0);
            const tailWag = Math.sin(t * tailBeat + phase) * 0.30;
            dummy.position.set(tailX, py, tailZ);
            dummy.scale.set(inst.scale[0], inst.scale[1], inst.scale[2]);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + wag + side * (part.tailSplay ?? 0.22) + tailWag * side;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.fishDorsal) {
            // Dorsal fin — upright on mid-back, rides body wag
            const dx = px - Math.sin(ry) * (part.offset ?? 0);
            const dz = pz - Math.cos(ry) * (part.offset ?? 0);
            dummy.position.set(dx, py + inst.scale[1] * (part.finYOff ?? 0.08), dz);
            dummy.scale.set(
              inst.scale[0] * (part.finW ?? 0.55),
              inst.scale[1] * (part.finH ?? 0.65),
              0.012
            );
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + wag * 0.6;
            dummy.rotation.x = 0.45; // swept back
            dummy.rotation.z = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.fishPecL || part.fishPecR) {
            // Pectoral fins — fan out perpendicular to body, slightly forward of center
            const side = part.fishPecL ? 1 : -1;
            const perpX = Math.cos(ry) * side;
            const perpZ = -Math.sin(ry) * side;
            const fwdX  = Math.sin(ry) * 0.10;
            const fwdZ  = Math.cos(ry) * 0.10;
            const fx = px + perpX * inst.scale[0] * 0.42 + fwdX;
            const fz = pz + perpZ * inst.scale[0] * 0.42 + fwdZ;
            dummy.position.set(fx, py - inst.scale[1] * 0.06, fz);
            dummy.scale.set(inst.scale[0] * 0.88, inst.scale[1] * 0.20, inst.scale[2] * 0.52);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + side * 0.40;
            dummy.rotation.x = 0.22;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.fishEye) {
            // Small dark eye at front-upper side of body
            const ex = px + Math.sin(ry) * inst.scale[2] * 0.50 + Math.cos(ry) * inst.scale[0] * 0.32;
            const ez = pz + Math.cos(ry) * inst.scale[2] * 0.50 - Math.sin(ry) * inst.scale[0] * 0.32;
            dummy.position.set(ex, py + inst.scale[1] * 0.28, ez);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.crabClawL || part.crabClawR) {
            // Claws reach forward from crab's visual facing (which is sideways to movement)
            const cs = inst.crabSize ?? 1;
            const side = part.crabClawL ? 1 : -1;
            const cx = px + Math.sin(ry) * 0.20 * cs + Math.cos(ry) * side * 0.14 * cs;
            const cz = pz + Math.cos(ry) * 0.20 * cs - Math.sin(ry) * side * 0.14 * cs;
            dummy.position.set(cx, py + 0.02 * cs, cz);
            dummy.scale.set(1.3 * cs, 1.0 * cs, 1.3 * cs);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.crabEyeL || part.crabEyeR) {
            // Eyes on short stalks at the front of the body, spread to sides
            const cs = inst.crabSize ?? 1;
            const side = part.crabEyeL ? -1 : 1;
            const ex = px + Math.sin(ry) * 0.07 * cs + Math.cos(ry) * side * 0.055 * cs;
            const ez = pz + Math.cos(ry) * 0.07 * cs - Math.sin(ry) * side * 0.055 * cs;
            dummy.position.set(ex, py + 0.045 * cs, ez);
            dummy.scale.set(cs, cs, cs);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.crabPupilL || part.crabPupilR) {
            // Pupils on the forward face of each eye stalk
            const cs = inst.crabSize ?? 1;
            const side = part.crabPupilL ? -1 : 1;
            const ex = px + Math.sin(ry) * 0.085 * cs + Math.cos(ry) * side * 0.055 * cs;
            const ez = pz + Math.cos(ry) * 0.085 * cs - Math.sin(ry) * side * 0.055 * cs;
            dummy.position.set(ex, py + 0.048 * cs, ez);
            dummy.scale.set(cs, cs, cs);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.frogEyeL || part.frogEyeR) {
            // Bulging eyes on top of head, spread to sides
            const side = part.frogEyeL ? -1 : 1;
            const ex = px + Math.cos(ry) * side * 0.055 + Math.sin(ry) * 0.02;
            const ez = pz - Math.sin(ry) * side * 0.055 + Math.cos(ry) * 0.02;
            dummy.position.set(ex, py + 0.065, ez);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.frogPupilL || part.frogPupilR) {
            // Pupils sit on front face of each eye
            const side = part.frogPupilL ? -1 : 1;
            const ex = px + Math.cos(ry) * side * 0.055 + Math.sin(ry) * 0.038;
            const ez = pz - Math.sin(ry) * side * 0.055 + Math.cos(ry) * 0.038;
            dummy.position.set(ex, py + 0.068, ez);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.frogLegL || part.frogLegR) {
            // Back legs tucked out to sides and slightly behind
            const side = part.frogLegL ? -1 : 1;
            const lx = px + Math.cos(ry) * side * 0.075 - Math.sin(ry) * 0.055;
            const lz = pz - Math.sin(ry) * side * 0.075 - Math.cos(ry) * 0.055;
            dummy.position.set(lx, py - 0.02, lz);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + side * 0.9;
            dummy.rotation.x = 0.7; // leg angles outward and down
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.beetleHead) {
            // Small head in front of carapace
            const hx = px + Math.sin(ry) * 0.072;
            const hz = pz + Math.cos(ry) * 0.072;
            dummy.position.set(hx, py + 0.005, hz);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.beetleAntennaL || part.beetleAntennaR) {
            // Antennae sweep forward and outward from head, waggle gently
            const side = part.beetleAntennaL ? -1 : 1;
            const wag  = Math.sin(t * 3.2 + inst.seed * 2.9) * 0.18;
            const ax   = px + Math.sin(ry) * 0.085 + Math.cos(ry) * side * 0.022;
            const az   = pz + Math.cos(ry) * 0.085 - Math.sin(ry) * side * 0.022;
            dummy.position.set(ax, py + 0.038, az);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + side * (0.55 + wag);
            dummy.rotation.x = -0.55; // angled forward-upward
            dummy.rotation.z = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.whalePecL || part.whalePecR) {
            // Long humpback pectoral flippers — extend perpendicular to body axis
            const side = part.whalePecL ? 1 : -1;
            // Position: slightly forward of center, offset to side
            const fx = px + Math.sin(ry) * 0.15 + Math.cos(ry) * side * 0.15;
            const fz = pz + Math.cos(ry) * 0.15 - Math.sin(ry) * side * 0.15;
            dummy.position.set(fx, py - inst.scale[1] * 0.10, fz);
            // Long in local-X: with rotation.y = ry, local-X maps to world-perpendicular
            // so flippers fan out sideways from the body
            dummy.scale.set(3.6, 0.10, 0.42);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0.35;
            dummy.rotation.z = side * 0.12;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.tail) {
            // Tail: placed behind the body (negative offset along facing)
            const tailX = px - Math.sin(ry) * Math.abs(part.offset);
            const tailZ = pz - Math.cos(ry) * Math.abs(part.offset);
            dummy.position.set(tailX, py + 0.05, tailZ);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + Math.PI / 4;
            dummy.rotation.x = 0.3;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.pigEarL || part.pigEarR) {
            // Pig ears: sit on top-sides of the head, slightly forward
            const ps = inst.pigSize ?? 1;
            const side = part.pigEarL ? -1 : 1;
            const ex = px + Math.sin(ry) * 0.18 * ps + Math.cos(ry) * side * 0.068 * ps;
            const ez = pz + Math.cos(ry) * 0.18 * ps - Math.sin(ry) * side * 0.068 * ps;
            dummy.position.set(ex, py + 0.12 * ps, ez);
            dummy.scale.set(ps, ps, ps);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + side * 0.15;
            dummy.rotation.x = -0.25;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.pigLegFL || part.pigLegFR || part.pigLegBL || part.pigLegBR) {
            // Pig legs: four stubby legs at the corners of the body
            const ps = inst.pigSize ?? 1;
            const side = (part.pigLegFL || part.pigLegBL) ? -1 : 1;
            const fwd  = (part.pigLegFL || part.pigLegFR) ? 0.09 * ps : -0.08 * ps;
            const lx = px + Math.sin(ry) * fwd + Math.cos(ry) * side * 0.10 * ps;
            const lz = pz + Math.cos(ry) * fwd - Math.sin(ry) * side * 0.10 * ps;
            dummy.position.set(lx, py - 0.10 * ps, lz);
            dummy.scale.set(ps, ps, ps);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.pigEyeL || part.pigEyeR) {
            // Eyes on the sides of the head (head centre is at offset 0.22)
            const ps = inst.pigSize ?? 1;
            const side = part.pigEyeL ? -1 : 1;
            const ex = px + Math.sin(ry) * 0.22 * ps + Math.cos(ry) * side * 0.090 * ps;
            const ez = pz + Math.cos(ry) * 0.22 * ps - Math.sin(ry) * side * 0.090 * ps;
            dummy.position.set(ex, py + 0.065 * ps, ez);
            dummy.scale.set(ps, ps, ps);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.birdEyeL || part.birdEyeR) {
            // Tiny eyes on the sides of the bird's head
            const bs = inst.scale[0];
            const side = part.birdEyeL ? -1 : 1;
            const ex = px + Math.sin(ry) * 0.082 * bs + Math.cos(ry) * side * 0.028 * bs;
            const ez = pz + Math.cos(ry) * 0.082 * bs - Math.sin(ry) * side * 0.028 * bs;
            dummy.position.set(ex, py + 0.018 * bs, ez);
            dummy.scale.set(bs, bs, bs);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.whaleEyeL || part.whaleEyeR) {
            // Eyes on the sides of the whale body, 1/3 from the head
            const side = part.whaleEyeL ? 1 : -1;
            const ex = px + Math.sin(ry) * 0.38 + Math.cos(ry) * side * 0.28;
            const ez = pz + Math.cos(ry) * 0.38 - Math.sin(ry) * side * 0.28;
            dummy.position.set(ex, py + 0.06, ez);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.chickEyeL || part.chickEyeR) {
            const cs = inst.chickSize ?? 1;
            const side = part.chickEyeL ? -1 : 1;
            const ex = px + Math.sin(ry) * 0.13 * cs + Math.cos(ry) * side * 0.054 * cs;
            const ez = pz + Math.cos(ry) * 0.13 * cs - Math.sin(ry) * side * 0.054 * cs;
            dummy.position.set(ex, py + 0.022 * cs, ez);
            dummy.scale.set(cs, cs, cs);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.chickComb) {
            const cs = inst.chickSize ?? 1;
            if (inst.isChick) {
              dummy.scale.set(0, 0, 0); dummy.position.set(px, py, pz);
            } else {
              const hx2 = px + Math.sin(ry) * 0.13 * cs;
              const hz2 = pz + Math.cos(ry) * 0.13 * cs;
              dummy.position.set(hx2, py + 0.095 * cs, hz2);
              dummy.scale.set(cs, cs, cs);
              dummy.rotation.set(0, ry, 0);
            }
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.chickWattle) {
            const cs = inst.chickSize ?? 1;
            if (inst.isChick) {
              dummy.scale.set(0, 0, 0); dummy.position.set(px, py, pz);
            } else {
              const hx2 = px + Math.sin(ry) * 0.20 * cs;
              const hz2 = pz + Math.cos(ry) * 0.20 * cs;
              dummy.position.set(hx2, py - 0.018 * cs, hz2);
              dummy.scale.set(cs, cs, cs);
              dummy.rotation.set(0, ry, 0);
            }
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.chickTail) {
            const cs = inst.chickSize ?? 1;
            const tx2 = px - Math.sin(ry) * 0.14 * cs;
            const tz2 = pz - Math.cos(ry) * 0.14 * cs;
            dummy.position.set(tx2, py + 0.04 * cs, tz2);
            dummy.scale.set(cs, cs, cs);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = -Math.PI * 0.25;
            dummy.rotation.z = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.chickLegL || part.chickLegR) {
            const cs = inst.chickSize ?? 1;
            const side = part.chickLegL ? -1 : 1;
            const lx = px + Math.cos(ry) * side * 0.055 * cs;
            const lz = pz - Math.sin(ry) * side * 0.055 * cs;
            dummy.position.set(lx, py - 0.082 * cs, lz);
            dummy.scale.set(cs, cs, cs);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.chickWingL || part.chickWingR) {
            const cs = inst.chickSize ?? 1;
            const side = part.chickWingL ? -1 : 1;
            const wx = px + Math.cos(ry) * side * 0.115 * cs;
            const wz = pz - Math.sin(ry) * side * 0.115 * cs;
            dummy.position.set(wx, py - 0.005 * cs, wz);
            dummy.scale.set(cs, cs, cs);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.rotation.z = side * 0.28;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else {
            const hx = px + Math.sin(ry) * part.offset;
            const hz = pz + Math.cos(ry) * part.offset;
            dummy.position.set(hx, py + (part.yOffset ?? 0.03), hz);
            dummy.scale.set(hs[0], hs[1], hs[2]);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = part.snout ? -Math.PI / 2 : part.beak ? -Math.PI / 2 : part.ears ? -0.4 : 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          }
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      for (const part of parts) part.mesh.instanceMatrix.needsUpdate = true;

      // Sparkle orbit: orbit points around creature's current position
      if (config.sparkle && instances[0]?._sparkleX !== undefined) {
        const posArr = config.sparkle.geometry.attributes.position.array;
        const count  = posArr.length / 3;
        if (config.desertBeetle) {
          // Multi-instance: 6 glow points orbit each individual beetle
          const SPB = config.sparksPerBeetle ?? 6;
          for (let ii = 0; ii < instances.length; ii++) {
            const bi = instances[ii];
            if (bi._sparkleX === undefined) continue;
            for (let si = 0; si < SPB; si++) {
              const angle = (si / SPB) * Math.PI * 2 + t * 2.8 + bi.seed * 3.5;
              const r     = 0.085 + Math.sin(t * 4.5 + bi.seed + si * 1.3) * 0.022;
              const yOff  = 0.015 + Math.abs(Math.sin(t * 5.8 + bi.seed * 1.7 + si)) * 0.035;
              const base  = (ii * SPB + si) * 3;
              posArr[base]     = bi._sparkleX + Math.cos(angle) * r;
              posArr[base + 1] = bi._sparkleY + yOff;
              posArr[base + 2] = bi._sparkleZ + Math.sin(angle) * r;
            }
          }
          config.sparkle.geometry.attributes.position.needsUpdate = true;
          config.sparkle.material.opacity = 0.45 + Math.sin(t * 4.2) * 0.35;
        } else if (config.goldenFrog) {
          const cx = instances[0]._sparkleX;
          const cy = instances[0]._sparkleY;
          const cz = instances[0]._sparkleZ;
          // Golden frog: wide glittering halo close to the ground, fast twinkle
          for (let si = 0; si < count; si++) {
            const angle = (si / count) * Math.PI * 2 + t * 3.8;
            const r = 0.14 + Math.sin(t * 5.0 + si * 1.1) * 0.04;
            const yOff = 0.06 + Math.abs(Math.sin(t * 6.2 + si * 2.3)) * 0.10;
            posArr[si * 3 + 0] = cx + Math.cos(angle) * r;
            posArr[si * 3 + 1] = cy + yOff;
            posArr[si * 3 + 2] = cz + Math.sin(angle) * r;
          }
          config.sparkle.material.opacity = 0.55 + Math.sin(t * 7.0) * 0.40;
          config.sparkle.geometry.attributes.position.needsUpdate = true;
        } else {
          // Hummingbird: tight gentle orbit
          const cx = instances[0]._sparkleX;
          const cy = instances[0]._sparkleY;
          const cz = instances[0]._sparkleZ;
          for (let si = 0; si < count; si++) {
            const angle = (si / count) * Math.PI * 2 + t * 2.5;
            const r = 0.10 + Math.sin(t * 1.8 + si * 0.9) * 0.025;
            posArr[si * 3 + 0] = cx + Math.cos(angle) * r;
            posArr[si * 3 + 1] = cy + 0.04 + Math.sin(t * 4 + si * 1.2) * 0.03;
            posArr[si * 3 + 2] = cz + Math.sin(angle) * r;
          }
          config.sparkle.material.opacity = 0.45 + Math.sin(t * 3.1) * 0.35;
          config.sparkle.geometry.attributes.position.needsUpdate = true;
        }
      }
    }
  }

  /**
   * Find the nearest animal instance within worldRadius of (worldX, worldZ).
   * Returns { label, icon, description } or null.
   */
  hitTestAnimals(worldX, worldZ, worldRadius = 1.2) {
    let best = null;
    let bestDist = worldRadius;
    for (const { instances, config } of this._animatedAnimals) {
      if (!config.label) continue;
      for (const inst of instances) {
        const dist = Math.hypot(inst.x * TILE_SIZE - worldX, inst.z * TILE_SIZE - worldZ);
        if (dist < bestDist) {
          bestDist = dist;
          best = { label: config.label, icon: config.icon, description: config.description };
        }
      }
    }
    return best;
  }

  _buildGlaciers(stoneTiles, mountainTiles = []) {
    // Glacier tiles = STONE tiles adjacent to at least one MOUNTAIN tile
    const glacierTiles = stoneTiles.filter(t =>
      [-1, 0, 1].some(dz => [-1, 0, 1].some(dx => {
        if (dx === 0 && dz === 0) return false;
        const nx = t.x + dx, nz = t.z + dz;
        if (nx < 0 || nx >= this.world.width || nz < 0 || nz >= this.world.height) return false;
        return this.world.tiles[nz][nx].type === TileType.MOUNTAIN;
      }))
    );
    if (!glacierTiles.length && !mountainTiles.length) return;

    const surfY = TerrainRenderer.surfaceY(TileType.STONE);
    const dummy = new THREE.Object3D();

    // ── Main ice slab ─────────────────────────────────────────────────
    const slabGeom = new THREE.BoxGeometry(TILE_SIZE * 0.90, 0.22, TILE_SIZE * 0.90);
    const slabMat  = new THREE.MeshStandardMaterial({
      color: 0xbee0f8, roughness: 0.06, metalness: 0.18,
      transparent: true, opacity: 0.88,
    });
    const slabMesh = new THREE.InstancedMesh(slabGeom, slabMat, glacierTiles.length);

    glacierTiles.forEach((tile, i) => {
      const jx = (this._rng(tile.x, tile.z, 70) - 0.5) * 0.12;
      const jz = (this._rng(tile.x, tile.z, 71) - 0.5) * 0.12;
      dummy.position.set(
        tile.x * TILE_SIZE + TILE_SIZE / 2 + jx,
        surfY + 0.11,
        tile.z * TILE_SIZE + TILE_SIZE / 2 + jz,
      );
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, this._rng(tile.x, tile.z, 72) * 0.3, 0);
      dummy.updateMatrix();
      slabMesh.setMatrixAt(i, dummy.matrix);
    });
    slabMesh.instanceMatrix.needsUpdate = true;
    slabMesh.castShadow = true;
    slabMesh.receiveShadow = true;
    this.scene.add(slabMesh);
    this._meshes.push(slabMesh);
    this._glacierMesh = slabMesh;
    this._glacierTiles = glacierTiles;

    // ── Ice spikes on ~35% of glacier tiles ──────────────────────────
    const spikeTiles = glacierTiles.filter(t => this._rng(t.x, t.z, 75) < 0.35);
    if (spikeTiles.length) {
      const spikeGeom = new THREE.CylinderGeometry(0.028, 0.075, 0.40, 5);
      const spikeMat  = new THREE.MeshStandardMaterial({
        color: 0xddf4ff, roughness: 0.04, transparent: true, opacity: 0.80,
      });
      const spikeMesh = new THREE.InstancedMesh(spikeGeom, spikeMat, spikeTiles.length * 3);
      let si = 0;
      spikeTiles.forEach(tile => {
        for (let k = 0; k < 3; k++) {
          const sx = tile.x * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x + k, tile.z, 76) - 0.5) * 1.3;
          const sz = tile.z * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x, tile.z + k, 77) - 0.5) * 1.3;
          const sc  = 0.5 + this._rng(tile.x + k, tile.z + k, 78) * 0.9;
          const tlt = (this._rng(tile.x + k, tile.z, 79) - 0.5) * 0.28;
          dummy.position.set(sx, surfY + 0.22 + 0.20 * sc, sz);
          dummy.scale.set(sc, sc, sc);
          dummy.rotation.set(tlt, this._rng(tile.x, tile.z + k, 80) * Math.PI * 2, tlt);
          dummy.updateMatrix();
          spikeMesh.setMatrixAt(si++, dummy.matrix);
        }
      });
      spikeMesh.instanceMatrix.needsUpdate = true;
      spikeMesh.castShadow = true;
      this.scene.add(spikeMesh);
      this._meshes.push(spikeMesh);
      this._glacierSpikeMesh = spikeMesh;
      this._glacierSpikeTiles = spikeTiles;
    }

    // ── Ice caps on MOUNTAIN peaks ────────────────────────────────────────
    if (mountainTiles.length) {
      const baseH = TILE_HEIGHT[TileType.MOUNTAIN]; // 1.5
      const capDummy = new THREE.Object3D();

      // Outer cap: a squashed cone covering the top ~30% of each mountain
      const capGeom = new THREE.ConeGeometry(1.0, 1.0, 8);
      const capMat  = new THREE.MeshStandardMaterial({
        color: 0xd4eeff, roughness: 0.08, metalness: 0.12,
        transparent: true, opacity: 0.90,
      });
      const capMesh = new THREE.InstancedMesh(capGeom, capMat, mountainTiles.length);

      mountainTiles.forEach((tile, i) => {
        const hVariation = baseH + tile.elevation * 0.08;
        const widthVar   = 0.85 + this._rng(tile.x, tile.z, 14) * 0.25; // same seed as cone
        const capFrac    = 0.32; // cover top 32% of the mountain
        const capH       = hVariation * capFrac;
        // Cone radius at (1 - capFrac) of the way up = widthVar * 0.92 * capFrac
        const capR       = widthVar * 0.92 * capFrac;
        const peakY      = hVariation;
        // Position cap centred at the upper segment, slightly lower than the tip
        capDummy.position.set(
          tile.x * TILE_SIZE + TILE_SIZE / 2,
          peakY - capH * 0.55,
          tile.z * TILE_SIZE + TILE_SIZE / 2,
        );
        capDummy.scale.set(capR, capH, capR);
        capDummy.rotation.set(0, this._rng(tile.x, tile.z, 19) * 0.08, 0);
        capDummy.updateMatrix();
        capMesh.setMatrixAt(i, capDummy.matrix);
      });
      capMesh.instanceMatrix.needsUpdate = true;
      capMesh.castShadow = true;
      this.scene.add(capMesh);
      this._meshes.push(capMesh);
      this._mountainCapMesh  = capMesh;
      this._mountainCapTiles = mountainTiles;
    }
  }

  /** Fade herb and mushroom meshes to grey as tiles deplete */
  /** Show/hide tree trunk+foliage and stump based on world.cutTrees state. */
  updateCutTrees(world) {
    if (!this._treeInstanceMap.size) return;

    const zeroM = (() => {
      const d = new THREE.Object3D();
      d.scale.setScalar(0);
      d.updateMatrix();
      return d.matrix.clone();
    })();

    if (!this._cutTreesState) this._cutTreesState = new Map();
    const meshesToUpdate = new Set();

    for (const [key, entry] of this._treeInstanceMap) {
      const [x, z] = key.split(',').map(Number);
      const tile = world.getTile(x, z);
      const isCut = !!(tile && tile.treeCut);
      if (this._cutTreesState.get(key) === isCut) continue; // no change
      this._cutTreesState.set(key, isCut);

      // Tree trunk + foliage
      if (isCut) {
        entry.tMesh.setMatrixAt(entry.index, zeroM);
        entry.fMesh.setMatrixAt(entry.index, zeroM);
      } else {
        entry.tMesh.setMatrixAt(entry.index, entry.origT);
        entry.fMesh.setMatrixAt(entry.index, entry.origF);
      }
      meshesToUpdate.add(entry.tMesh);
      meshesToUpdate.add(entry.fMesh);

      // Stump
      if (this._stumpMesh && this._stumpMap) {
        const stumpEntry = this._stumpMap.get(key);
        if (stumpEntry) {
          this._stumpMesh.setMatrixAt(stumpEntry.index, isCut ? stumpEntry.origStump : zeroM);
          meshesToUpdate.add(this._stumpMesh);
        }
      }
    }

    for (const mesh of meshesToUpdate) mesh.instanceMatrix.needsUpdate = true;
  }

  updateResources(world) {
    const color = new THREE.Color();
    if (this._herbHeadMesh && this._herbTiles) {
      const fullColor  = new THREE.Color(0xd97ef5);
      const deplColor  = new THREE.Color(0x6b7355);
      this._herbTiles.forEach((tile, i) => {
        const t = world.tiles[tile.z][tile.x];
        const v = t.herbs ?? 0;
        color.lerpColors(deplColor, fullColor, v);
        for (let k = 0; k < 3; k++)
          this._herbHeadMesh.setColorAt(i * 3 + k, color);
      });
      this._herbHeadMesh.instanceColor.needsUpdate = true;
    }
    if (this._mushroomCapMeshes && this._mushroomTiles) {
      const capColors = [new THREE.Color(0xc8860a), new THREE.Color(0x7a3d0a), new THREE.Color(0xd4b483)];
      const deplColor = new THREE.Color(0x6b7355);
      this._mushroomTiles.forEach((tile, i) => {
        const t = world.tiles[tile.z][tile.x];
        const v = t.mushrooms ?? 0;
        const ci = Math.floor((Math.sin(tile.x * 127.1 + tile.z * 311.7 + 322 * 74.5) * 0.5 + 0.5) * capColors.length);
        color.lerpColors(deplColor, capColors[ci % capColors.length], v);
        this._mushroomCapMeshes[ci % capColors.length].setColorAt(i, color);
      });
      for (const cm of this._mushroomCapMeshes)
        if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
    }
    if (this._flintMesh && this._flintTiles) {
      const fullColor = new THREE.Color(0xb8d0e8);
      const goneColor = new THREE.Color(0x6e6e6e);
      this._flintTiles.forEach((tile, i) => {
        const t = world.tiles[tile.z][tile.x];
        color.lerpColors(goneColor, fullColor, t.flint ?? 0);
        this._flintMesh.setColorAt(i, color);
      });
      this._flintMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Update glacier visuals to match current melt state */
  updateGlaciers(glacierData) {
    if (!this._glacierMesh || !this._glacierTiles) return;
    const surfY = TerrainRenderer.surfaceY(TileType.STONE);
    const dummy = new THREE.Object3D();

    // Slab mesh
    this._glacierTiles.forEach((tile, i) => {
      const g  = glacierData.get(`${tile.x},${tile.z}`);
      const m  = g ? g.melt : 0;
      const sy = Math.max(0.02, 1 - m * 0.96);
      const sx = Math.max(0.06, 1 - m * 0.42);
      const jx = (this._rng(tile.x, tile.z, 70) - 0.5) * 0.12;
      const jz = (this._rng(tile.x, tile.z, 71) - 0.5) * 0.12;
      dummy.position.set(
        tile.x * TILE_SIZE + TILE_SIZE / 2 + jx,
        surfY + 0.11 * sy,
        tile.z * TILE_SIZE + TILE_SIZE / 2 + jz,
      );
      dummy.scale.set(sx, sy, sx);
      dummy.rotation.set(0, this._rng(tile.x, tile.z, 72) * 0.3, 0);
      dummy.updateMatrix();
      this._glacierMesh.setMatrixAt(i, dummy.matrix);
    });
    this._glacierMesh.instanceMatrix.needsUpdate = true;

    // Fade material opacity with average melt
    const avgMelt = this._glacierTiles.reduce((s, t) => {
      const g = glacierData.get(`${t.x},${t.z}`);
      return s + (g ? g.melt : 0);
    }, 0) / this._glacierTiles.length;
    this._glacierMesh.material.opacity = Math.max(0.12, 0.88 - avgMelt * 0.55);

    // Spike mesh
    if (this._glacierSpikeMesh && this._glacierSpikeTiles) {
      let si = 0;
      this._glacierSpikeTiles.forEach(tile => {
        const g  = glacierData.get(`${tile.x},${tile.z}`);
        const m  = g ? g.melt : 0;
        const sy = Math.max(0.01, 1 - m * 0.96);
        for (let k = 0; k < 3; k++) {
          const sx2 = tile.x * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x + k, tile.z, 76) - 0.5) * 1.3;
          const sz2 = tile.z * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x, tile.z + k, 77) - 0.5) * 1.3;
          const sc  = (0.5 + this._rng(tile.x + k, tile.z + k, 78) * 0.9) * sy;
          const tlt = (this._rng(tile.x + k, tile.z, 79) - 0.5) * 0.28;
          dummy.position.set(sx2, surfY + 0.22 + 0.20 * sc, sz2);
          dummy.scale.set(sc, sc, sc);
          dummy.rotation.set(tlt, this._rng(tile.x, tile.z + k, 80) * Math.PI * 2, tlt);
          dummy.updateMatrix();
          this._glacierSpikeMesh.setMatrixAt(si++, dummy.matrix);
        }
      });
      this._glacierSpikeMesh.instanceMatrix.needsUpdate = true;
      this._glacierSpikeMesh.material.opacity = Math.max(0.08, 0.80 - avgMelt * 0.55);
    }

    // Mountain ice caps: shrink and fade as they melt
    if (this._mountainCapMesh && this._mountainCapTiles) {
      const baseH = TILE_HEIGHT[TileType.MOUNTAIN];
      const capDummy = new THREE.Object3D();
      let totalMelt = 0, count = 0;
      this._mountainCapTiles.forEach((tile, i) => {
        const g = glacierData.get(`${tile.x},${tile.z}`);
        const m = g ? g.melt : 0;
        totalMelt += m; count++;
        const hVariation = baseH + tile.elevation * 0.08;
        const widthVar   = 0.85 + this._rng(tile.x, tile.z, 14) * 0.25;
        const capFrac    = 0.32;
        const capH       = hVariation * capFrac * Math.max(0.04, 1 - m * 0.94);
        const capR       = widthVar * 0.92 * capFrac * Math.max(0.06, 1 - m * 0.72);
        const peakY      = hVariation;
        capDummy.position.set(
          tile.x * TILE_SIZE + TILE_SIZE / 2,
          peakY - capH * 0.55,
          tile.z * TILE_SIZE + TILE_SIZE / 2,
        );
        capDummy.scale.set(capR, capH, capR);
        capDummy.rotation.set(0, this._rng(tile.x, tile.z, 19) * 0.08, 0);
        capDummy.updateMatrix();
        this._mountainCapMesh.setMatrixAt(i, capDummy.matrix);
      });
      this._mountainCapMesh.instanceMatrix.needsUpdate = true;
      const avgCapMelt = count ? totalMelt / count : 0;
      this._mountainCapMesh.material.opacity = Math.max(0.10, 0.90 - avgCapMelt * 0.65);
    }
  }

  /**
   * Returns the approximate top-surface Y for a tile.
   * Accepts either a tile-type string (backward-compat) or a tile object.
   * Tile objects with layer=1 are offset by ELEVATED_HEIGHT.
   */
  static getHeightAt(wx, wz) {
    if (!_heightGrid) return 0.14;
    const fx  = wx / TILE_SIZE;
    const fz  = wz / TILE_SIZE;
    const ix0 = Math.max(0, Math.min(_heightNX - 2, Math.floor(fx)));
    const iz0 = Math.max(0, Math.min(_heightNZ - 2, Math.floor(fz)));
    const tx  = fx - ix0;
    const tz  = fz - iz0;
    const h00 = _heightGrid[ iz0      * _heightNX + ix0    ];
    const h10 = _heightGrid[ iz0      * _heightNX + ix0 + 1];
    const h01 = _heightGrid[(iz0 + 1) * _heightNX + ix0    ];
    const h11 = _heightGrid[(iz0 + 1) * _heightNX + ix0 + 1];
    return h00 * (1 - tx) * (1 - tz) +
           h10 *      tx  * (1 - tz) +
           h01 * (1 - tx) *      tz  +
           h11 *      tx  *      tz;
  }

  static surfaceY(typeOrTile) {
    if (typeof typeOrTile === 'string') return TILE_HEIGHT[typeOrTile] ?? 0.14;
    if (!typeOrTile || typeof typeOrTile !== 'object') return 0.14;
    return (TILE_HEIGHT[typeOrTile.type] ?? 0.14) + ((typeOrTile.layer ?? 0) === 1 ? ELEVATED_HEIGHT : 0);
  }

  // ── Rivers ────────────────────────────────────────────────────────────

  /**
   * Renders each river path from world.rivers as a semi-transparent blue ribbon
   * that follows the rolling terrain surface.
   */
  _buildRivers() {
    if (!this.world.rivers?.length) return;

    const seed = this.world.seed;
    const tileY = (tile) => {
      const wx = tile.x * TILE_SIZE + TILE_SIZE / 2;
      const wz = tile.z * TILE_SIZE + TILE_SIZE / 2;
      return TILE_HEIGHT[tile.type] + tile.elevation * 0.08
           + terrainTopologyHillNoise(wx, wz, seed) * (TERRAIN_TOPOLOGY_HILL_AMP[tile.type] ?? 0)
           + 0.022; // just above terrain surface
    };

    const HALF_W     = TILE_SIZE * 0.28;
    const riverColor = new THREE.Color().setHSL(208 / 360, 0.78, 0.52);

    for (const river of this.world.rivers) {
      if (river.length < 2) continue;

      const verts = [];
      const idxs  = [];

      for (let i = 0; i < river.length; i++) {
        const { x, z } = river[i];
        const tile = this.world.tiles[z][x];
        const cx = x * TILE_SIZE + TILE_SIZE / 2;
        const cz = z * TILE_SIZE + TILE_SIZE / 2;
        const cy = tileY(tile);

        // Tangent along path direction
        const prev = river[Math.max(0, i - 1)];
        const next = river[Math.min(river.length - 1, i + 1)];
        let tx = next.x - prev.x, tz_dir = next.z - prev.z;
        const tlen = Math.hypot(tx, tz_dir) || 1;
        tx /= tlen; tz_dir /= tlen;

        // Perpendicular (right-hand normal in XZ plane)
        const px = -tz_dir, pz = tx;

        verts.push(
          cx + px * HALF_W, cy, cz + pz * HALF_W,  // right edge
          cx - px * HALF_W, cy, cz - pz * HALF_W,  // left edge
        );

        if (i > 0) {
          const b = (i - 1) * 2;
          idxs.push(b, b + 2, b + 1,  b + 1, b + 2, b + 3);
        }
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      geom.setIndex(idxs);
      geom.computeVertexNormals();

      const mat  = new THREE.MeshLambertMaterial({
        color: riverColor, transparent: true, opacity: 0.84, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this._meshes.push(mesh);
    }
  }

  // ── Smooth topology terrain mesh ──────────────────────────────────────

  /**
   * Builds a single continuous heightmap mesh that replaces the flat per-type boxes.
   * Vertices sit at tile corners (65×65 for a 64×64 world); height at each corner is
   * the weighted average of up to four adjacent tile surfaces.  Mountains contribute
   * at stone level so the cone geometry still reads correctly at y≈0.
   * Vertex colours are blended from adjacent tile HSL values.
   */
  _buildTerrainMesh() {
    const W  = this.world.width;   // 64
    const H  = this.world.height;  // 64
    const NX = W + 1;              // vertices along x
    const NZ = H + 1;              // vertices along z
    const seed = this.world.seed;

    const positions = new Float32Array(NX * NZ * 3);
    const colors    = new Float32Array(NX * NZ * 3);
    const indices   = [];
    const tmpColor  = new THREE.Color();

    for (let iz = 0; iz < NZ; iz++) {
      for (let ix = 0; ix < NX; ix++) {
        // Up to four tile neighbours that share this corner
        let totalH = 0, totalAmp = 0, totalR = 0, totalG = 0, totalB = 0, count = 0;
        for (const [tx, tz] of [[ix - 1, iz - 1], [ix, iz - 1], [ix - 1, iz], [ix, iz]]) {
          if (tx < 0 || tx >= W || tz < 0 || tz >= H) continue;
          const tile = this.world.tiles[tz][tx];
          // Mountains: use stone height so cones sit naturally at y≈0
          const isMtn = tile.type === TileType.MOUNTAIN;
          const h = isMtn
            ? TILE_HEIGHT[TileType.STONE]
            : TILE_HEIGHT[tile.type] + tile.elevation * 0.08;
          totalH   += h;
          totalAmp += TERRAIN_TOPOLOGY_HILL_AMP[tile.type] ?? 0;
          const [hue, sat, lit] = TILE_COLOR_HSL[isMtn ? TileType.STONE : tile.type];
          const litVar = lit + (Math.sin(tx * 3.1 + tz * 2.7) * 0.5 + 0.5) * 6 - 3;
          tmpColor.setHSL(hue / 360, sat / 100, Math.max(0.05, Math.min(0.95, litVar / 100)));
          totalR += tmpColor.r; totalG += tmpColor.g; totalB += tmpColor.b;
          count++;
        }
        if (count === 0) { totalH = 0.14; totalR = totalG = totalB = 0.5; count = 1; }

        const wx = ix * TILE_SIZE, wz = iz * TILE_SIZE;
        const hillH = terrainTopologyHillNoise(wx, wz, seed) * (totalAmp / count);

        const vi = iz * NX + ix;
        positions[vi * 3]     = wx;
        positions[vi * 3 + 1] = totalH / count + hillH;
        positions[vi * 3 + 2] = wz;
        colors[vi * 3]     = totalR / count;
        colors[vi * 3 + 1] = totalG / count;
        colors[vi * 3 + 2] = totalB / count;
      }
    }

    // Store heights for getHeightAt() bilinear queries
    _heightGrid = new Float32Array(NX * NZ);
    for (let i = 0; i < NX * NZ; i++) _heightGrid[i] = positions[i * 3 + 1];
    _heightNX = NX;
    _heightNZ = NZ;

    // Two triangles per cell (CCW so normals face up)
    for (let iz = 0; iz < H; iz++) {
      for (let ix = 0; ix < W; ix++) {
        const a = iz * NX + ix, b = a + 1, c = a + NX, d = c + 1;
        indices.push(a, c, b,  b, c, d);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mat  = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'terrainTopology';
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this._meshes.push(mesh);
  }

  // ── Elevated cliff walls ───────────────────────────────────────────────

  /**
   * For each exposed face of a layer=1 tile, render a vertical slab as the cliff wall.
   * Uses a single shared geometry (rotated per face) to keep draw calls low.
   */
  _buildCliffWalls() {
    const WALL_THICK = 0.14;
    // Collect all exposed faces: {cx, cy, cz, rotY}
    const faces = [];

    for (let tz = 0; tz < this.world.height; tz++) {
      for (let tx = 0; tx < this.world.width; tx++) {
        const tile = this.world.tiles[tz][tx];
        if ((tile.layer ?? 0) !== 1) continue;

        const centerX = tile.x * TILE_SIZE + TILE_SIZE / 2;
        const centerZ = tile.z * TILE_SIZE + TILE_SIZE / 2;
        const cy = ELEVATED_HEIGHT / 2;

        // Check all 4 orthogonal neighbors
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = tile.x + dx, nz = tile.z + dz;
          const neighbor = this.world.getTile(nx, nz);
          // Exposed face if neighbor is layer-0, out of bounds, or doesn't exist
          if (neighbor && (neighbor.layer ?? 0) === 1) continue;

          // Wall center: at the tile boundary
          const wallCX = dx !== 0 ? (tile.x + Math.max(0, dx)) * TILE_SIZE : centerX;
          const wallCZ = dz !== 0 ? (tile.z + Math.max(0, dz)) * TILE_SIZE : centerZ;
          // Rotate 90° around Y for X-facing walls
          const rotY = dx !== 0 ? Math.PI / 2 : 0;
          faces.push({ cx: wallCX, cy, cz: wallCZ, rotY });
        }
      }
    }

    if (faces.length === 0) return;

    // Single geometry: wide in X (TILE_SIZE-GAP), tall in Y (ELEVATED_HEIGHT), thin in Z (WALL_THICK)
    // For X-facing walls, we rotate 90° so it becomes wide in Z, thin in X.
    const geom = new THREE.BoxGeometry(TILE_SIZE - GAP, ELEVATED_HEIGHT, WALL_THICK);
    // Slightly darker than ground-level stone
    const mat  = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(28 / 360, 20 / 100, 38 / 100) });
    const mesh = new THREE.InstancedMesh(geom, mat, faces.length);
    mesh.receiveShadow = true;
    mesh.castShadow   = true;

    const dummy = new THREE.Object3D();
    faces.forEach(({ cx, cy, cz, rotY }, i) => {
      dummy.position.set(cx, cy, cz);
      dummy.rotation.set(0, rotY, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;

    this.scene.add(mesh);
    this._meshes.push(mesh);
  }

  // ── Ladders (dynamic — built by agents at runtime) ─────────────────────

  /**
   * Called each frame. Renders any newly-placed ladders since last call.
   * Ladder meshes are tracked in _ladderMeshes for disposal.
   */
  updateLadders(world) {
    for (let i = this._renderedLadderCount; i < world.ladders.length; i++) {
      const { fromX, fromZ, toX, toZ } = world.ladders[i];
      this._addLadderMesh(fromX, fromZ, toX, toZ);
    }
    this._renderedLadderCount = world.ladders.length;
  }

  _addLadderMesh(fromX, fromZ, toX, toZ) {
    const dx = toX - fromX; // ±1 or 0
    const dz = toZ - fromZ; // ±1 or 0

    // Position at the tile boundary on the cliff face
    let cx, cz;
    if (dx !== 0) {
      cx = Math.max(fromX, toX) * TILE_SIZE;
      cz = toZ * TILE_SIZE + TILE_SIZE / 2;
    } else {
      cx = toX * TILE_SIZE + TILE_SIZE / 2;
      cz = Math.max(fromZ, toZ) * TILE_SIZE;
    }

    const ladderH    = ELEVATED_HEIGHT + 0.35;
    const poleSpread = 0.22; // half-gap between rails
    const rungCount  = 8;

    const poleMat = new THREE.MeshLambertMaterial({ color: 0x8b5e2b });
    const rungMat = new THREE.MeshLambertMaterial({ color: 0xa06830 });
    const poleGeom = new THREE.CylinderGeometry(0.034, 0.042, ladderH, 6);
    const rungGeom = new THREE.CylinderGeometry(0.022, 0.022, poleSpread * 2 + 0.04, 6);

    // Width axis is perpendicular to the cliff face direction
    const perpX = dz !== 0 ? 1 : 0;
    const perpZ = dx !== 0 ? 1 : 0;

    const group = new THREE.Group();

    // Two side rails
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeom, poleMat);
      pole.position.set(perpX * poleSpread * side, ladderH / 2, perpZ * poleSpread * side);
      pole.castShadow = true;
      group.add(pole);
    }

    // Horizontal rungs — cylinders rotated to span between the rails
    for (let k = 1; k <= rungCount; k++) {
      const rung = new THREE.Mesh(rungGeom, rungMat);
      rung.position.y = ladderH * k / (rungCount + 1);
      if (perpX) rung.rotation.z = Math.PI / 2; // rung lies along X
      else       rung.rotation.x = Math.PI / 2; // rung lies along Z
      rung.castShadow = true;
      group.add(rung);
    }

    // Lean slightly away from the cliff (toward the lower ground)
    const lean = 0.10;
    if (dx !== 0) group.rotation.z = -Math.sign(dx) * lean;
    else          group.rotation.x =  Math.sign(dz) * lean;

    group.position.set(cx, 0, cz);
    this.scene.add(group);
    this._ladderMeshes.push(group);
  }
}
