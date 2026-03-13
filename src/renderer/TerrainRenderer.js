import * as THREE from 'three';
import { TileType, TILE_SIZE } from '../simulation/World.js';

// Visual height of each tile type (the box's Y scale)
const TILE_HEIGHT = {
  [TileType.DEEP_WATER]: 0.02,
  [TileType.WATER]:    0.05,
  [TileType.GRASS]:    0.14,
  [TileType.FOREST]:   0.24,
  [TileType.STONE]:    0.34,
  [TileType.MOUNTAIN]: 1.50,
};

// Base colours per tile type (HSL for easy variation)
const TILE_COLOR_HSL = {
  [TileType.DEEP_WATER]: [215, 80, 30],
  [TileType.WATER]:    [208, 82, 55],
  [TileType.GRASS]:    [ 94, 62, 50],
  [TileType.FOREST]:   [132, 66, 30],
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
      [TileType.GRASS]:    [],
      [TileType.FOREST]:   [],
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
      const trunkGeom   = new THREE.CylinderGeometry(0.08, 0.11, 0.38, 5);
      const trunkMat    = new THREE.MeshLambertMaterial({ color: 0x78350f });
      const trunkMesh   = new THREE.InstancedMesh(trunkGeom, trunkMat, forestTrees.length);

      const foliageGeom = new THREE.ConeGeometry(0.38, 0.72, 6);
      const foliageMat  = new THREE.MeshLambertMaterial({ color: 0x15803d });
      const foliageMesh = new THREE.InstancedMesh(foliageGeom, foliageMat, forestTrees.length);

      const surfY = TerrainRenderer.surfaceY(TileType.FOREST);

      forestTrees.forEach((tile, i) => {
        const ox = (this._rng(tile.x, tile.z, 3) - 0.5) * 0.7;
        const oz = (this._rng(tile.x, tile.z, 4) - 0.5) * 0.7;
        const cx = tile.x * TILE_SIZE + TILE_SIZE / 2 + ox;
        const cz = tile.z * TILE_SIZE + TILE_SIZE / 2 + oz;

        dummy.position.set(cx, surfY + 0.19, cz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        trunkMesh.setMatrixAt(i, dummy.matrix);

        dummy.position.set(cx, surfY + 0.70, cz);
        dummy.updateMatrix();
        foliageMesh.setMatrixAt(i, dummy.matrix);
      });

      trunkMesh.castShadow = true;
      foliageMesh.castShadow = true;
      foliageMesh.receiveShadow = true;
      trunkMesh.instanceMatrix.needsUpdate = true;
      foliageMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(trunkMesh);
      this.scene.add(foliageMesh);
      this._meshes.push(trunkMesh, foliageMesh);
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

    // Shared fish geometry; type 1 slightly smaller, type 2 slightly larger
    const fish1Geom = new THREE.SphereGeometry(0.10, 4, 3);
    const fish2Geom = new THREE.SphereGeometry(0.14, 5, 3);
    // Fins shared
    const fishFinGeom = new THREE.ConeGeometry(0.06, 0.10, 3);

    // Shallow fish: orange, quick, small wander radius, bobby
    const shallowFishConfig = {
      label: 'Shallow Fish', icon: '🐟',
      description: 'A small fish that hugs the shoreline.',
      driftRadius: 0.18, driftSpeed: 1.2, bobAmount: 0.025, bobSpeed: 4,
      mobile: true, moveSpeed: 0.55, tileType: TileType.WATER, wanderRadius: 3,
    };
    // Deep fish: blue-grey, slow, large wander radius, prefers deep water
    const deepFishConfig = {
      label: 'Deep Fish', icon: '🐠',
      description: 'A large fish that roams the open ocean.',
      driftRadius: 0.12, driftSpeed: 0.4, bobAmount: 0.008, bobSpeed: 1.5,
      mobile: true, moveSpeed: 0.22, tileTypes: [TileType.DEEP_WATER, TileType.WATER], wanderRadius: 9,
    };

    if (fish1Tiles.length > 0) {
      const fish1Mat = new THREE.MeshLambertMaterial({ color: 0xd4682a });
      const finMat1  = new THREE.MeshLambertMaterial({ color: 0xb84e1a });
      const fish1Mesh = new THREE.InstancedMesh(fish1Geom, fish1Mat, fish1Tiles.length);
      const fin1Mesh  = new THREE.InstancedMesh(fishFinGeom, finMat1, fish1Tiles.length);
      const instances1 = fish1Tiles.map((tile) => {
        const ox = (this._rng(tile.x, tile.z, 22) - 0.5) * 0.8;
        const oz = (this._rng(tile.x, tile.z, 23) - 0.5) * 0.8;
        const seed = this._rng(tile.x, tile.z, 24) * Math.PI * 2;
        const tx = tile.x + 0.5 + ox * 0.5;
        const tz = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.WATER) + 0.02,
          scale: [1.3, 0.45, 0.55],
          headScale: [0.6, 0.5, 0.4],
          rotY: seed, seed,
        };
      });
      addAnimated(fish1Mesh, instances1, shallowFishConfig, [{ mesh: fin1Mesh, offset: 0.0, fin: true }]);
    }
    if (fish2Tiles.length > 0) {
      const fish2Mat = new THREE.MeshLambertMaterial({ color: 0x4a7a8e });
      const finMat2  = new THREE.MeshLambertMaterial({ color: 0x3a6a7e });
      const fish2Mesh = new THREE.InstancedMesh(fish2Geom, fish2Mat, fish2Tiles.length);
      const fin2Mesh  = new THREE.InstancedMesh(fishFinGeom, finMat2, fish2Tiles.length);
      const instances2 = fish2Tiles.map((tile) => {
        const ox = (this._rng(tile.x, tile.z, 25) - 0.5) * 0.6;
        const oz = (this._rng(tile.x, tile.z, 26) - 0.5) * 0.6;
        const seed = this._rng(tile.x, tile.z, 27) * Math.PI * 2;
        const tx = tile.x + 0.5 + ox * 0.5;
        const tz = tile.z + 0.5 + oz * 0.5;
        return {
          x: tx, z: tz, targetX: tx, targetZ: tz,
          homeX: tile.x, homeZ: tile.z,
          baseY: surfY(TileType.WATER) - 0.01,
          scale: [1.2, 0.5, 0.65],
          headScale: [0.7, 0.55, 0.5],
          rotY: seed, seed,
        };
      });
      addAnimated(fish2Mesh, instances2, deepFishConfig, [{ mesh: fin2Mesh, offset: 0.0, fin: true }]);
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

      // Whale body: elongated sphere
      const whaleBodyGeom = new THREE.SphereGeometry(0.30, 7, 5);
      const whaleBodyMat  = new THREE.MeshLambertMaterial({ color: 0x1a3050 });
      const whaleMesh     = new THREE.InstancedMesh(whaleBodyGeom, whaleBodyMat, 1);

      // Tail fluke: two small flat boxes angled like a V
      const flukeGeom = new THREE.BoxGeometry(0.28, 0.06, 0.12);
      const flukeMat  = new THREE.MeshLambertMaterial({ color: 0x152840 });
      const flukeL    = new THREE.InstancedMesh(flukeGeom, flukeMat, 1);
      const flukeR    = new THREE.InstancedMesh(flukeGeom, flukeMat, 1);

      const ox = (this._rng(wTile.x, wTile.z, 91) - 0.5) * 0.5;
      const oz = (this._rng(wTile.x, wTile.z, 92) - 0.5) * 0.5;
      const wSeed = this._rng(wTile.x, wTile.z, 93) * Math.PI * 2;
      const wx = wTile.x + 0.5 + ox;
      const wz = wTile.z + 0.5 + oz;

      const whaleInstances = [{
        x: wx, z: wz, targetX: wx, targetZ: wz,
        homeX: wTile.x, homeZ: wTile.z,
        baseY: surfY(TileType.DEEP_WATER) + 0.02,
        scale: [2.2, 0.65, 0.80],
        rotY: wSeed, seed: wSeed,
      }];
      const whaleConfig = {
        label: 'Whale', icon: '🐋',
        description: 'A great whale, sole sovereign of the deep — ancient and unhurried.',
        driftRadius: 0.05, driftSpeed: 0.08, bobAmount: 0.04, bobSpeed: 0.6,
        mobile: true, moveSpeed: 0.08, tileTypes: [TileType.DEEP_WATER], wanderRadius: 12,
      };
      whaleMesh.castShadow = true;
      addAnimated(whaleMesh, whaleInstances, whaleConfig, [
        { mesh: flukeL, offset: -0.58, tail: true },
        { mesh: flukeR, offset: -0.58, tail: true },
      ]);
    }
  }

  /** Update animal instance positions. Call each frame with real-time delta. */
  updateAnimals(realDelta) {
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
            // Home-anchored wander: pick a random tile near the animal's home position.
            // This prevents corner-clustering by bounding the search around the spawn area.
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
              // Fallback: return to home
              inst.targetX = homeX + 0.5;
              inst.targetZ = homeZ + 0.5;
            }
          } else if (dist > 0.01) {
            const move = Math.min(moveSpeed * realDelta, dist);
            inst.x += (dx / dist) * move;
            inst.z += (dz / dist) * move;
            inst.rotY = Math.atan2(inst.targetX - inst.x, inst.targetZ - inst.z);
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
        const ry = inst.rotY;

        dummy.position.set(px, py, pz);
        dummy.scale.set(inst.scale[0], inst.scale[1], inst.scale[2]);
        dummy.rotation.y = ry;
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
            // Dorsal fin: sits on top of body, perpendicular to travel direction
            dummy.position.set(px, py + inst.scale[1] * 0.08, pz);
            dummy.scale.set(0.7, 1.0, 0.5);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.y = ry;
            dummy.rotation.x = -Math.PI / 2;
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
