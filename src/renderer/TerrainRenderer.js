import * as THREE from 'three';
import { TileType, TILE_SIZE } from '../simulation/World.js';

// Visual height of each tile type (the box's Y scale)
const TILE_HEIGHT = {
  [TileType.DEEP_WATER]: 0.02,
  [TileType.WATER]:    0.05,
  [TileType.BEACH]:    0.07,
  [TileType.GRASS]:    0.14,
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
  [TileType.FOREST]:   [132, 66, 30],
  [TileType.DESERT]:   [ 38, 52, 62],  // dry tan
  [TileType.STONE]:    [ 28, 22, 62],
  [TileType.MOUNTAIN]: [215, 18, 68],
};

const GAP = 0.08; // gap between tiles

export class TerrainRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this._meshes = []; // tracked for dispose()
    this._animatedAnimals = []; // { mesh, instances: [{baseX,baseY,baseZ,scale,rotY,seed}], config }
    this._animTime = 0;
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
  }

  _build() {
    // Group tiles by type for instanced rendering
    const buckets = {
      [TileType.DEEP_WATER]: [],
      [TileType.WATER]:    [],
      [TileType.BEACH]:    [],
      [TileType.GRASS]:    [],
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
      if (tiles.length === 0) continue;

      const baseH = TILE_HEIGHT[type];
      const [h, s, l] = TILE_COLOR_HSL[type];
      const isMountain = type === TileType.MOUNTAIN;

      // Mountains use tapered cones for a peak shape; other tiles use boxes
      const geom = isMountain
        ? new THREE.ConeGeometry(0.92, 1.5, 8)
        : new THREE.BoxGeometry(TILE_SIZE - GAP, 1, TILE_SIZE - GAP);
      const mat  = new THREE.MeshLambertMaterial();
      const mesh = new THREE.InstancedMesh(geom, mat, tiles.length);
      mesh.receiveShadow = true;

      const dummy = new THREE.Object3D();
      const color = new THREE.Color();

      tiles.forEach((tile, i) => {
        const hVariation = baseH + tile.elevation * 0.08;
        const lVariation = l + (Math.sin(tile.x * 3.1 + tile.z * 2.7) * 0.5 + 0.5) * 6 - 3;

        if (isMountain) {
          // Cone: base at y=0, tip at y=height; geom is centered, so position at half-height
          const widthVar = 0.85 + this._rng(tile.x, tile.z, 14) * 0.25;
          const tiltX = (this._rng(tile.x, tile.z, 15) - 0.5) * 0.12;
          const tiltZ = (this._rng(tile.x, tile.z, 16) - 0.5) * 0.12;
          dummy.position.set(
            tile.x * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x, tile.z, 17) - 0.5) * 0.15,
            hVariation / 2,
            tile.z * TILE_SIZE + TILE_SIZE / 2 + (this._rng(tile.x, tile.z, 18) - 0.5) * 0.15,
          );
          dummy.scale.set(widthVar, hVariation / 1.5, widthVar);
          dummy.rotation.set(tiltX, this._rng(tile.x, tile.z, 19) * 0.08, tiltZ);
          dummy.updateMatrix();
        } else {
          dummy.position.set(
            tile.x * TILE_SIZE + TILE_SIZE / 2,
            hVariation / 2,
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

    this._buildVegetation(buckets);
    this._buildAnimals(buckets);
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
    }

    // ── Trees on FOREST tiles ─────────────────────────────────────────────
    const forestTrees = buckets[TileType.FOREST].filter(t => this._rng(t.x, t.z) < 0.82);
    if (forestTrees.length > 0) {
      const surfY = TerrainRenderer.surfaceY(TileType.FOREST);

      // ── Shared geometries ───────────────────────────────────────────────
      const normalTrunkGeom = new THREE.CylinderGeometry(0.08, 0.11, 0.38, 5);
      const tallTrunkGeom   = new THREE.CylinderGeometry(0.06, 0.09, 0.55, 5);
      const birchTrunkGeom  = new THREE.CylinderGeometry(0.045, 0.06, 0.50, 5);
      const cherryTrunkGeom = new THREE.CylinderGeometry(0.07, 0.10, 0.40, 5);
      const pineGeom        = new THREE.ConeGeometry(0.33, 0.78, 6);
      const darkFirGeom     = new THREE.ConeGeometry(0.24, 1.08, 7);
      const roundGeom       = new THREE.SphereGeometry(0.36, 7, 5);
      const cherryGeom      = new THREE.SphereGeometry(0.42, 8, 5);
      const birchGeom       = new THREE.SphereGeometry(0.22, 6, 5);

      // ── Helper: create + register one tree variant ──────────────────────
      // fsx/fsy/fsz: per-axis foliage scale multipliers (for flattening etc.)
      const addTreeVariant = (tiles, tGeom, tColor, fGeom, fColor, foliageY,
        { scaleMin = 0.85, scaleMax = 1.22, fsx = 1, fsy = 1, fsz = 1 } = {}) => {
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
          dummy.position.set(cx, surfY + 0.19 * sc, cz);
          dummy.scale.set(sc, sc, sc);
          dummy.updateMatrix();
          tMesh.setMatrixAt(i, dummy.matrix);
          dummy.position.set(cx, surfY + foliageY * sc, cz);
          dummy.scale.set(sc * fsx, sc * fsy, sc * fsz);
          dummy.updateMatrix();
          fMesh.setMatrixAt(i, dummy.matrix);
        });
        tMesh.castShadow = true;
        fMesh.castShadow = true;
        fMesh.receiveShadow = true;
        tMesh.instanceMatrix.needsUpdate = true;
        fMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(tMesh, fMesh);
        this._meshes.push(tMesh, fMesh);
      };

      // ── Assign each tile a tree type via deterministic rng ───────────────
      const grp = { pine: [], oak: [], cherry: [], autOrange: [], autRed: [],
                    autGold: [], darkFir: [], birch: [] };
      forestTrees.forEach(tile => {
        const r = this._rng(tile.x, tile.z, 99);
        if      (r < 0.22) grp.pine.push(tile);
        else if (r < 0.38) grp.oak.push(tile);
        else if (r < 0.53) grp.cherry.push(tile);
        else if (r < 0.63) grp.autOrange.push(tile);
        else if (r < 0.71) grp.autRed.push(tile);
        else if (r < 0.78) grp.autGold.push(tile);
        else if (r < 0.90) grp.darkFir.push(tile);
        else               grp.birch.push(tile);
      });

      // Pine — classic evergreen cone
      addTreeVariant(grp.pine,      normalTrunkGeom, 0x78350f, pineGeom,    0x166534, 0.72);
      // Oak — round bushy canopy
      addTreeVariant(grp.oak,       normalTrunkGeom, 0x6b3a1f, roundGeom,   0x2d7530, 0.80);
      // Cherry blossom — wide flattened pink dome, dark reddish trunk
      addTreeVariant(grp.cherry,    cherryTrunkGeom, 0x5c2810, cherryGeom,  0xffacc5, 0.78,
        { scaleMin: 0.80, scaleMax: 1.10, fsx: 1.22, fsy: 0.78, fsz: 1.22 });
      // Autumn orange
      addTreeVariant(grp.autOrange, normalTrunkGeom, 0x6b3a1f, roundGeom,   0xe07018, 0.80);
      // Autumn red
      addTreeVariant(grp.autRed,    normalTrunkGeom, 0x5a2010, roundGeom,   0xcc2808, 0.80);
      // Autumn gold
      addTreeVariant(grp.autGold,   normalTrunkGeom, 0x6b3a1f, roundGeom,   0xe0a010, 0.80);
      // Dark fir — tall narrow dark evergreen
      addTreeVariant(grp.darkFir,   tallTrunkGeom,   0x5c2a0e, darkFirGeom, 0x0d4a22, 0.92,
        { scaleMin: 0.90, scaleMax: 1.38 });
      // Birch — slender pale trunk, small bright canopy
      addTreeVariant(grp.birch,     birchTrunkGeom,  0xc8b48a, birchGeom,   0x85c46a, 0.70,
        { scaleMin: 0.75, scaleMax: 1.05 });
    }

    // ── Rocks on STONE tiles ──────────────────────────────────────────────
    const stoneTiles = buckets[TileType.STONE].filter(t => this._rng(t.x, t.z, 5) < 0.50);
    if (stoneTiles.length > 0) {
      const rockGeom = new THREE.DodecahedronGeometry(0.18, 0);
      const rockMat  = new THREE.MeshLambertMaterial({ color: 0x8a9aaa });
      const rockMesh = new THREE.InstancedMesh(rockGeom, rockMat, stoneTiles.length);
      const surfY = TerrainRenderer.surfaceY(TileType.STONE);

      stoneTiles.forEach((tile, i) => {
        const ox    = (this._rng(tile.x, tile.z, 6) - 0.5) * 0.8;
        const oz    = (this._rng(tile.x, tile.z, 7) - 0.5) * 0.8;
        const scale = 0.55 + this._rng(tile.x, tile.z, 8) * 0.9;
        dummy.position.set(
          tile.x * TILE_SIZE + TILE_SIZE / 2 + ox,
          surfY + 0.12,
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

    // ── Cacti on DESERT tiles ──────────────────────────────────────────────
    const desertTiles = (buckets[TileType.DESERT] ?? []).filter(t => this._rng(t.x, t.z, 80) < 0.38);
    if (desertTiles.length > 0) {
      const surfY      = TerrainRenderer.surfaceY(TileType.DESERT);
      const trunkGeom  = new THREE.CylinderGeometry(0.07, 0.09, 0.60, 7);
      const armGeom    = new THREE.CylinderGeometry(0.042, 0.048, 0.22, 6);
      const trunkMat   = new THREE.MeshLambertMaterial({ color: 0x3a6b20 });
      const armMat     = new THREE.MeshLambertMaterial({ color: 0x2f5a18 });
      const trunkMesh  = new THREE.InstancedMesh(trunkGeom, trunkMat, desertTiles.length);
      const armLMesh   = new THREE.InstancedMesh(armGeom,   armMat,   desertTiles.length);
      const armRMesh   = new THREE.InstancedMesh(armGeom,   armMat,   desertTiles.length);

      desertTiles.forEach((tile, i) => {
        const ox = (this._rng(tile.x, tile.z, 81) - 0.5) * 0.7;
        const oz = (this._rng(tile.x, tile.z, 82) - 0.5) * 0.7;
        const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
        const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;
        const sc = 0.65 + this._rng(tile.x, tile.z, 83) * 0.75;
        const ry = this._rng(tile.x, tile.z, 84) * Math.PI * 2;

        // Trunk — vertical
        dummy.position.set(cx, surfY + 0.30 * sc, cz);
        dummy.rotation.set(0, ry, 0);
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        trunkMesh.setMatrixAt(i, dummy.matrix);

        // Arms — horizontal cylinders branching left & right at ~60% trunk height
        const armY   = surfY + 0.28 * sc;
        const armOff = 0.18 * sc; // distance from centre to arm root
        dummy.position.set(
          cx + Math.cos(ry) * armOff,
          armY,
          cz - Math.sin(ry) * armOff,
        );
        dummy.rotation.set(0, ry, Math.PI / 2);
        dummy.scale.set(sc, sc * 0.85, sc);
        dummy.updateMatrix();
        armLMesh.setMatrixAt(i, dummy.matrix);

        dummy.position.set(
          cx - Math.cos(ry) * armOff,
          armY,
          cz + Math.sin(ry) * armOff,
        );
        dummy.updateMatrix();
        armRMesh.setMatrixAt(i, dummy.matrix);
      });

      trunkMesh.castShadow = true;
      armLMesh.castShadow  = true;
      armRMesh.castShadow  = true;
      trunkMesh.instanceMatrix.needsUpdate = true;
      armLMesh.instanceMatrix.needsUpdate  = true;
      armRMesh.instanceMatrix.needsUpdate  = true;
      this.scene.add(trunkMesh, armLMesh, armRMesh);
      this._meshes.push(trunkMesh, armLMesh, armRMesh);
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

    // Koi carp: round deep-bodied pond fish; deep fish: streamlined ocean fish
    const fish1Geom = new THREE.SphereGeometry(0.11, 8, 5);
    const fish2Geom = new THREE.SphereGeometry(0.15, 8, 5);
    // Dorsal fins
    const koiDorsalGeom = new THREE.ConeGeometry(0.065, 0.18, 4);
    const deepFinGeom   = new THREE.ConeGeometry(0.052, 0.13, 3);
    // Forked tail lobes (shared)
    const fishTailGeom  = new THREE.SphereGeometry(0.09, 5, 4);

    // Shallow fish (koi): quick, small wander radius
    const shallowFishConfig = {
      label: 'Shallow Fish', icon: '🐟',
      description: 'A small fish that hugs the shoreline.',
      driftRadius: 0.0, driftSpeed: 0, bobAmount: 0.018, bobSpeed: 3.5,
      mobile: true, moveSpeed: 0.55, tileType: TileType.WATER, wanderRadius: 3,
      wagAmp: 0.13, wagFreq: 4.0, turnSpeed: 5.5, burstCoast: true,
    };
    // Deep fish: slow, large wander radius
    const deepFishConfig = {
      label: 'Deep Fish', icon: '🐠',
      description: 'A large fish that roams the open ocean.',
      driftRadius: 0.0, driftSpeed: 0, bobAmount: 0.006, bobSpeed: 1.2,
      mobile: true, moveSpeed: 0.22, tileTypes: [TileType.DEEP_WATER, TileType.WATER], wanderRadius: 9,
      wagAmp: 0.09, wagFreq: 2.8, turnSpeed: 3.0, burstCoast: true,
    };

    if (fish1Tiles.length > 0) {
      // White base so setColorAt drives colour fully
      const fish1Mat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const finMat1   = new THREE.MeshLambertMaterial({ color: 0xcc5500 });
      const tailMat1  = new THREE.MeshLambertMaterial({ color: 0xcc5500 });
      const fish1Mesh = new THREE.InstancedMesh(fish1Geom, fish1Mat, fish1Tiles.length);
      const fin1Mesh  = new THREE.InstancedMesh(koiDorsalGeom, finMat1, fish1Tiles.length);
      const tailL1    = new THREE.InstancedMesh(fishTailGeom, tailMat1, fish1Tiles.length);
      const tailR1    = new THREE.InstancedMesh(fishTailGeom, tailMat1, fish1Tiles.length);
      // Koi colour palette: orange, gold, red, white, black, cream
      const koiPalette = [0xe05515, 0xf09000, 0xe81808, 0xf8f4f0, 0x181818, 0xf0c060, 0xd04010];
      const _kc = new THREE.Color();
      const instances1 = fish1Tiles.map((tile, idx) => {
        const ox   = (this._rng(tile.x, tile.z, 22) - 0.5) * 0.8;
        const oz   = (this._rng(tile.x, tile.z, 23) - 0.5) * 0.8;
        const seed = this._rng(tile.x, tile.z, 24) * Math.PI * 2;
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        const ci   = Math.floor(this._rng(tile.x, tile.z, 28) * koiPalette.length);
        _kc.setHex(koiPalette[ci]);
        fish1Mesh.setColorAt(idx, _kc);
        // Tint tail/fin to a darker shade of the same hue
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.WATER) + 0.02,
          scale: [1.8, 0.72, 0.82],
          rotY: seed, seed,
        };
      });
      fish1Mesh.instanceColor.needsUpdate = true;
      fin1Mesh.castShadow = false;
      tailL1.castShadow  = false;
      tailR1.castShadow  = false;
      addAnimated(fish1Mesh, instances1, shallowFishConfig, [
        { mesh: fin1Mesh, offset: 0,    fin: true },
        { mesh: tailL1,   offset: -0.5, fishTailL: true },
        { mesh: tailR1,   offset: -0.5, fishTailR: true },
      ]);
    }
    if (fish2Tiles.length > 0) {
      const fish2Mat  = new THREE.MeshLambertMaterial({ color: 0x5a8098 });
      const finMat2   = new THREE.MeshLambertMaterial({ color: 0x3a5a6e });
      const tailMat2  = new THREE.MeshLambertMaterial({ color: 0x3a5a6e });
      const fish2Mesh = new THREE.InstancedMesh(fish2Geom, fish2Mat, fish2Tiles.length);
      const fin2Mesh  = new THREE.InstancedMesh(deepFinGeom, finMat2, fish2Tiles.length);
      const tailL2    = new THREE.InstancedMesh(fishTailGeom, tailMat2, fish2Tiles.length);
      const tailR2    = new THREE.InstancedMesh(fishTailGeom, tailMat2, fish2Tiles.length);
      const instances2 = fish2Tiles.map((tile) => {
        const ox   = (this._rng(tile.x, tile.z, 25) - 0.5) * 0.6;
        const oz   = (this._rng(tile.x, tile.z, 26) - 0.5) * 0.6;
        const seed = this._rng(tile.x, tile.z, 27) * Math.PI * 2;
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.WATER) - 0.01,
          scale: [2.1, 0.55, 0.72],
          rotY: seed, seed,
        };
      });
      fin2Mesh.castShadow = false;
      tailL2.castShadow   = false;
      tailR2.castShadow   = false;
      addAnimated(fish2Mesh, instances2, deepFishConfig, [
        { mesh: fin2Mesh, offset: 0,    fin: true },
        { mesh: tailL2,   offset: -0.5, fishTailL: true },
        { mesh: tailR2,   offset: -0.5, fishTailR: true },
      ]);
    }

    // ── Sheep on GRASS tiles ─────────────────────────────────────────────
    const grassTiles = buckets[TileType.GRASS] ?? [];
    const sheepTiles = grassTiles.filter(t => this._rng(t.x, t.z, 30) < 0.025);
    const mobileGrazeConfig = {
      label: 'Sheep', icon: '🐑',
      description: 'A woolly sheep grazing on the grasslands.',
      driftRadius: 0.12, driftSpeed: 0.3, bobAmount: 0.015, bobSpeed: 2.5,
      mobile: true, moveSpeed: 0.30, tileType: TileType.GRASS, wanderRadius: 5,
    };

    if (sheepTiles.length > 0) {
      // Woolly body: cylinder + head sphere + small fluffy tail
      const sheepBodyGeom = new THREE.CylinderGeometry(0.22, 0.24, 0.18, 8);
      const sheepMat      = new THREE.MeshLambertMaterial({ color: 0xfaf8f5 });
      const sheepMesh     = new THREE.InstancedMesh(sheepBodyGeom, sheepMat, sheepTiles.length);
      const sheepHeadGeom = new THREE.SphereGeometry(0.12, 6, 4);
      const sheepHeadMat  = new THREE.MeshLambertMaterial({ color: 0xf0ebe0 });
      const sheepHeadMesh = new THREE.InstancedMesh(sheepHeadGeom, sheepHeadMat, sheepTiles.length);
      const sheepTailGeom = new THREE.SphereGeometry(0.065, 4, 3);
      const sheepTailMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const sheepTailMesh = new THREE.InstancedMesh(sheepTailGeom, sheepTailMat, sheepTiles.length);
      const instances = sheepTiles.map((tile) => {
        const ox = (this._rng(tile.x, tile.z, 31) - 0.5) * 0.9;
        const oz = (this._rng(tile.x, tile.z, 32) - 0.5) * 0.9;
        const seed = this._rng(tile.x, tile.z, 33) * Math.PI * 2;
        const tx = tile.x + 0.5 + ox * 0.5;
        const tz = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.GRASS) + 0.2,
          scale: [1, 1, 1],
          headScale: [0.9, 1, 0.85],
          rotY: seed, seed,
        };
      });
      sheepMesh.castShadow = true;
      sheepHeadMesh.castShadow = true;
      addAnimated(sheepMesh, instances, mobileGrazeConfig, [
        { mesh: sheepHeadMesh, offset: 0.28 },
        { mesh: sheepTailMesh, offset: -0.24, tail: true },
      ]);
    }

    // ── Pigs on GRASS tiles ──────────────────────────────────────────────
    const pigTiles = grassTiles.filter(t => this._rng(t.x, t.z, 40) < 0.025);
    const pigGrazeConfig = { ...mobileGrazeConfig, label: 'Pig', icon: '🐷', description: 'A stocky pig rooting around the pasture.', moveSpeed: 0.38, wanderRadius: 4 };
    if (pigTiles.length > 0) {
      // Barrel body + rounded head + tapered snout + curly tail
      const pigBodyGeom  = new THREE.CylinderGeometry(0.15, 0.17, 0.22, 8);
      const pigMat       = new THREE.MeshLambertMaterial({ color: 0xe8b4a0 });
      const pigMesh      = new THREE.InstancedMesh(pigBodyGeom, pigMat, pigTiles.length);
      const pigHeadGeom  = new THREE.SphereGeometry(0.1, 6, 5);
      const pigHeadMat   = new THREE.MeshLambertMaterial({ color: 0xe8b4a0 });
      const pigHeadMesh  = new THREE.InstancedMesh(pigHeadGeom, pigHeadMat, pigTiles.length);
      const pigSnoutGeom = new THREE.CylinderGeometry(0.022, 0.045, 0.14, 5);
      const pigSnoutMat  = new THREE.MeshLambertMaterial({ color: 0xdd9a85 });
      const pigSnoutMesh = new THREE.InstancedMesh(pigSnoutGeom, pigSnoutMat, pigTiles.length);
      const pigEarGeom   = new THREE.BoxGeometry(0.1, 0.018, 0.045);
      const pigEarMat    = new THREE.MeshLambertMaterial({ color: 0xe0ac98 });
      const pigEarMesh   = new THREE.InstancedMesh(pigEarGeom, pigEarMat, pigTiles.length);
      const pigTailGeom  = new THREE.TorusGeometry(0.04, 0.018, 4, 6, Math.PI * 1.5);
      const pigTailMat   = new THREE.MeshLambertMaterial({ color: 0xdd9a85 });
      const pigTailMesh  = new THREE.InstancedMesh(pigTailGeom, pigTailMat, pigTiles.length);
      const instances = pigTiles.map((tile) => {
        const ox = (this._rng(tile.x, tile.z, 41) - 0.5) * 0.95;
        const oz = (this._rng(tile.x, tile.z, 42) - 0.5) * 0.95;
        const seed = this._rng(tile.x, tile.z, 43) * Math.PI * 2;
        const tx = tile.x + 0.5 + ox * 0.5;
        const tz = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.GRASS) + 0.17,
          scale: [1.1, 0.85, 1.2],
          headScale: [0.95, 1.05, 0.9],
          snoutScale: [1, 1, 1],
          rotY: seed, seed,
        };
      });
      pigMesh.castShadow = true;
      pigHeadMesh.castShadow = true;
      pigSnoutMesh.castShadow = true;
      pigEarMesh.castShadow = true;
      addAnimated(pigMesh, instances, pigGrazeConfig, [
        { mesh: pigHeadMesh, offset: 0.22, useHeadScale: true },
        { mesh: pigSnoutMesh, offset: 0.36, snout: true, useSnoutScale: true },
        { mesh: pigEarMesh,  offset: 0.2,  ears: true, yOffset: 0.06 },
        { mesh: pigTailMesh, offset: -0.22, tail: true },
      ]);
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

    // Improved bird: rounded body + head + beak
    const birdBodyGeom = new THREE.SphereGeometry(0.065, 6, 4);
    const birdHeadGeom = new THREE.SphereGeometry(0.04, 4, 3);
    const birdBeakGeom = new THREE.ConeGeometry(0.012, 0.055, 4);

    const addBirds = (tiles, tileType, offset) => {
      if (tiles.length === 0) return;
      const bodyColor = tileType === TileType.FOREST ? 0x4a5568 : 0x718096;
      const birdBodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
      const birdHeadMat = new THREE.MeshLambertMaterial({ color: bodyColor });
      const birdBeakMat = new THREE.MeshLambertMaterial({ color: 0x8b7355 });
      const birdBodyMesh = new THREE.InstancedMesh(birdBodyGeom, birdBodyMat, tiles.length);
      const birdHeadMesh = new THREE.InstancedMesh(birdHeadGeom, birdHeadMat, tiles.length);
      const birdBeakMesh = new THREE.InstancedMesh(birdBeakGeom, birdBeakMat, tiles.length);
      const flyY = surfY(TileType.GRASS) + 0.5;
      const instances = tiles.map((tile) => {
        const ox = (this._rng(tile.x, tile.z, offset) - 0.5) * 0.8;
        const oz = (this._rng(tile.x, tile.z, offset + 1) - 0.5) * 0.8;
        const seed = this._rng(tile.x, tile.z, offset + 2) * Math.PI * 2;
        const tx = tile.x + 0.5 + ox * 0.5;
        const tz = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          baseY: flyY,
          scale: [1, 1.1, 0.75],
          headScale: [0.85, 1, 0.9],
          rotY: seed,
          seed,
        };
      });
      addAnimated(birdBodyMesh, instances, birdMobileConfig, [
        { mesh: birdHeadMesh, offset: 0.07 },
        { mesh: birdBeakMesh, offset: 0.12, beak: true },
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
      addAnimated(humBodyMesh, humInstances, humConfig, [
        { mesh: humHeadMesh, offset: 0.07 },
        { mesh: gorgetMesh, offset: 0.055, gorget: true },
        { mesh: humBeakMesh, offset: 0.13, beak: true },
        { mesh: wingLMesh, offset: 0.0, wingL: true },
        { mesh: wingRMesh, offset: 0.0, wingR: true },
        { mesh: tailMesh, offset: -0.07, tail: true },
      ]);
    }

    // ── Single Whale in DEEP_WATER ──────────────────────────────────────────
    const whaleDeepTiles = buckets[TileType.DEEP_WATER] ?? [];
    if (whaleDeepTiles.length > 0) {
      const wIdx = Math.floor(whaleDeepTiles.length * 0.5) % whaleDeepTiles.length;
      const wTile = whaleDeepTiles[wIdx];

      // Realistic whale: elongated torpedo body, subtle nose taper, long pectoral flippers, swept dorsal
      const whaleBodyGeom = new THREE.SphereGeometry(0.19, 12, 9);
      const whaleBodyMat = new THREE.MeshLambertMaterial({ color: 0x2a3d5a });
      const whaleMesh = new THREE.InstancedMesh(whaleBodyGeom, whaleBodyMat, 1);

      // Belly / ventral pale patch
      const bellyGeom = new THREE.SphereGeometry(0.165, 8, 6);
      const bellyMat = new THREE.MeshLambertMaterial({ color: 0x9ab8cc });
      const bellyMesh = new THREE.InstancedMesh(bellyGeom, bellyMat, 1);

      // Nose taper — small, overlapping front of body to create a tapered snout
      const snoutGeom = new THREE.SphereGeometry(0.11, 8, 7);
      const snoutMat = new THREE.MeshLambertMaterial({ color: 0x243650 });
      const snoutMesh = new THREE.InstancedMesh(snoutGeom, snoutMat, 1);

      // Dorsal fin — thin cone swept back
      const dorsalGeom = new THREE.ConeGeometry(0.055, 0.22, 5);
      const dorsalMat = new THREE.MeshLambertMaterial({ color: 0x1e2e42 });
      const dorsalMesh = new THREE.InstancedMesh(dorsalGeom, dorsalMat, 1);

      // Flukes
      const flukeGeom = new THREE.SphereGeometry(0.12, 8, 6);
      const flukeMat = new THREE.MeshLambertMaterial({ color: 0x1e2e42 });
      const flukeL = new THREE.InstancedMesh(flukeGeom, flukeMat, 1);
      const flukeR = new THREE.InstancedMesh(flukeGeom, flukeMat, 1);

      // Long pectoral flippers
      const pecGeom = new THREE.SphereGeometry(0.08, 6, 5);
      const pecMat = new THREE.MeshLambertMaterial({ color: 0x1e2e42 });
      const pecL = new THREE.InstancedMesh(pecGeom, pecMat, 1);
      const pecR = new THREE.InstancedMesh(pecGeom, pecMat, 1);

      const ox = (this._rng(wTile.x, wTile.z, 91) - 0.5) * 0.5;
      const oz = (this._rng(wTile.x, wTile.z, 92) - 0.5) * 0.5;
      const wSeed = this._rng(wTile.x, wTile.z, 93) * Math.PI * 2;
      const wx = wTile.x + 0.5 + ox;
      const wz = wTile.z + 0.5 + oz;

      const whaleInstances = [{
        x: wx, z: wz, targetX: wx, targetZ: wz,
        homeX: wTile.x, homeZ: wTile.z,
        baseY: surfY(TileType.DEEP_WATER) + 0.02,
        scale: [3.4, 0.92, 1.1],
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
        driftRadius: 0.05, driftSpeed: 0.08, bobAmount: 0.04, bobSpeed: 0.6,
        mobile: true, moveSpeed: 0.08, tileTypes: [TileType.DEEP_WATER], wanderRadius: 12,
        whaleSpout: { mist: mistLayer, spray: sprayLayer },
      };
      whaleMesh.castShadow = true;
      bellyMesh.castShadow = true;
      snoutMesh.castShadow = true;
      dorsalMesh.castShadow = true;
      flukeL.castShadow = true;
      flukeR.castShadow = true;
      pecL.castShadow = true;
      pecR.castShadow = true;
      addAnimated(whaleMesh, whaleInstances, whaleConfig, [
        { mesh: bellyMesh,  offset: 0,     whaleBelly: true },
        { mesh: snoutMesh,  offset: 0.48,  whaleHead: true },
        { mesh: dorsalMesh, offset: 0.05,  dorsal: true },
        { mesh: flukeL,     offset: -0.55, flukeL: true },
        { mesh: flukeR,     offset: -0.55, flukeR: true },
        { mesh: pecL,       whalePecL: true },
        { mesh: pecR,       whalePecR: true },
      ]);
    }

    // ── Crabs on BEACH tiles ──────────────────────────────────────────────
    const beachAnimalTiles = (buckets[TileType.BEACH] ?? []).filter(t => this._rng(t.x, t.z, 90) < 0.10);
    if (beachAnimalTiles.length > 0) {
      const bodyGeom  = new THREE.SphereGeometry(0.075, 6, 4);
      const clawGeom  = new THREE.SphereGeometry(0.038, 5, 4);
      const bodyMat   = new THREE.MeshLambertMaterial({ color: 0xcc4418 });
      const clawMat   = new THREE.MeshLambertMaterial({ color: 0xaa3210 });
      const bodyMesh  = new THREE.InstancedMesh(bodyGeom, bodyMat, beachAnimalTiles.length);
      const clawLMesh = new THREE.InstancedMesh(clawGeom, clawMat, beachAnimalTiles.length);
      const clawRMesh = new THREE.InstancedMesh(clawGeom, clawMat, beachAnimalTiles.length);

      const crabInstances = beachAnimalTiles.map(tile => {
        const ox   = (this._rng(tile.x, tile.z, 91) - 0.5) * 1.0;
        const oz   = (this._rng(tile.x, tile.z, 92) - 0.5) * 1.0;
        const seed = this._rng(tile.x, tile.z, 93) * Math.PI * 2;
        const tx   = tile.x + 0.5 + ox * 0.5;
        const tz   = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.BEACH) + 0.02,
          scale: [1.6, 0.5, 1.0],
          rotY: seed, seed,
          crabSide: this._rng(tile.x, tile.z, 94) < 0.5 ? 1 : -1,
        };
      });

      const crabConfig = {
        label: 'Crab', icon: '🦀',
        description: 'A little crab scuttling along the shore.',
        driftRadius: 0, driftSpeed: 0, bobAmount: 0.008, bobSpeed: 6,
        mobile: true, moveSpeed: 0.5, tileTypes: [TileType.BEACH], wanderRadius: 3,
        wagAmp: 0.07, wagFreq: 9.0, burstCoast: true, crabWalk: true,
      };
      bodyMesh.castShadow  = false;
      clawLMesh.castShadow = false;
      clawRMesh.castShadow = false;
      addAnimated(bodyMesh, crabInstances, crabConfig, [
        { mesh: clawLMesh, crabClawL: true },
        { mesh: clawRMesh, crabClawR: true },
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
                spd = moveSpeed * 2.4;
              } else {
                spd = moveSpeed * 0.22; // gentle glide
              }
            }
            const move = Math.min(spd * realDelta, dist);
            inst.x += (dx / dist) * move;
            inst.z += (dz / dist) * move;
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

        // Store world-space position for sparkle (hummingbird) use
        if (config.sparkle && i === 0) {
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
            dummy.position.set(px, py - inst.scale[1] * 0.06, pz);
            dummy.scale.set(inst.scale[0] * 0.72, 0.28, inst.scale[2] * 0.82);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.whaleHead) {
            // Nose taper — small sphere overlapping the front tip of the body
            const hx = px + Math.sin(ry) * part.offset;
            const hz = pz + Math.cos(ry) * part.offset;
            dummy.position.set(hx, py - inst.scale[1] * 0.02, hz);
            dummy.scale.set(0.72, 0.78, 0.88);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.dorsal) {
            // Small swept dorsal fin near mid-back
            const mx = px + Math.sin(ry) * part.offset;
            const mz = pz + Math.cos(ry) * part.offset;
            dummy.position.set(mx, py + inst.scale[1] * 0.14 + 0.04, mz);
            dummy.scale.set(0.9, 1.0, 0.35);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = 0.3;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.flukeL || part.flukeR) {
            const side = part.flukeL ? 1 : -1;
            const tailStem = 0.56;
            const tailX = px - Math.sin(ry) * tailStem;
            const tailZ = pz - Math.cos(ry) * tailStem;
            const yawSpread = 0.5;
            const flap = Math.sin(t * 1.4 + phase) * 0.12;
            dummy.position.set(tailX, py + 0.02, tailZ);
            dummy.scale.set(1.85, 0.14, 1.05);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + side * yawSpread + flap * side;
            dummy.rotation.x = -Math.PI / 2 + 0.02;
            dummy.rotation.z = side * 0.04;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.fishTailL || part.fishTailR) {
            // Forked tail lobe — spread behind the body and wag
            const side = part.fishTailL ? 1 : -1;
            const tailX = px - Math.sin(ry + wag) * 0.5;
            const tailZ = pz - Math.cos(ry + wag) * 0.5;
            // Tail beats faster during burst, slow gentle sweep when coasting
            const tailBeat = inst._burstRemain > 0
              ? wagFreq * 1.4
              : (wagAmp > 0 ? wagFreq * 0.6 : 3.5);
            const tailWag = Math.sin(t * tailBeat + phase) * 0.22;
            dummy.position.set(tailX, py, tailZ);
            dummy.scale.set(1.55, 0.08, 0.9);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + wag + side * 0.42 + tailWag * side;
            dummy.rotation.x = -Math.PI / 2 + 0.08;
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.crabClawL || part.crabClawR) {
            // Claws reach forward from crab's visual facing (which is sideways to movement)
            const side = part.crabClawL ? 1 : -1;
            const cx = px + Math.sin(ry) * 0.20 + Math.cos(ry) * side * 0.14;
            const cz = pz + Math.cos(ry) * 0.20 - Math.sin(ry) * side * 0.14;
            dummy.position.set(cx, py + 0.02, cz);
            dummy.scale.set(1.3, 1.0, 1.3);
            dummy.rotation.set(0, ry, 0);
            dummy.updateMatrix();
            part.mesh.setMatrixAt(i, dummy.matrix);
          } else if (part.whalePecL || part.whalePecR) {
            // Long swept pectoral flippers — flat and narrow, angled down and back
            const side = part.whalePecL ? 1 : -1;
            const fx = px + Math.sin(ry) * 0.12 + Math.cos(ry) * side * 0.18;
            const fz = pz + Math.cos(ry) * 0.12 - Math.sin(ry) * side * 0.18;
            dummy.position.set(fx, py - inst.scale[1] * 0.06, fz);
            dummy.scale.set(0.18, 0.1, 2.4);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry + side * 0.25;
            dummy.rotation.x = 0.25;
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

      // Hummingbird sparkle: orbit 8 points around hummingbird's current position
      if (config.sparkle && instances[0]?._sparkleX !== undefined) {
        const cx = instances[0]._sparkleX;
        const cy = instances[0]._sparkleY;
        const cz = instances[0]._sparkleZ;
        const posArr = config.sparkle.geometry.attributes.position.array;
        const count = posArr.length / 3;
        for (let si = 0; si < count; si++) {
          const angle = (si / count) * Math.PI * 2 + t * 2.5;
          const r = 0.10 + Math.sin(t * 1.8 + si * 0.9) * 0.025;
          posArr[si * 3 + 0] = cx + Math.cos(angle) * r;
          posArr[si * 3 + 1] = cy + 0.04 + Math.sin(t * 4 + si * 1.2) * 0.03;
          posArr[si * 3 + 2] = cz + Math.sin(angle) * r;
        }
        config.sparkle.geometry.attributes.position.needsUpdate = true;
        config.sparkle.material.opacity = 0.45 + Math.sin(t * 3.1) * 0.35;
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

  /** Returns the approximate top-surface Y for a given tile type */
  static surfaceY(type) {
    return TILE_HEIGHT[type] ?? 0.14;
  }
}
