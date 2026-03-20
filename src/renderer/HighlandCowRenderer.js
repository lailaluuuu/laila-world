import * as THREE from 'three';
import { TileType, TILE_SIZE, WORLD_WIDTH, WORLD_HEIGHT } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const COW_COUNT = 2;

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

export class HighlandCowRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this._cows = [];
    this._geoms = [];
    this._mats = [];
    this._build();
  }

  _build() {
    const grassTiles = [];
    for (let z = 0; z < WORLD_HEIGHT; z++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        const tile = this.world.getTile(x, z);
        if (tile?.type === TileType.GRASS) grassTiles.push({ x, z });
      }
    }
    if (grassTiles.length === 0) return;

    const rand = seededRand(113);
    for (let i = grassTiles.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [grassTiles[i], grassTiles[j]] = [grassTiles[j], grassTiles[i]];
    }

    const surfY = TerrainRenderer.surfaceY(TileType.GRASS);

    // Shared materials
    const whiteMat  = new THREE.MeshStandardMaterial({ color: 0xf0ede8, roughness: 0.85 });
    const blackMat  = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
    const pinkMat   = new THREE.MeshStandardMaterial({ color: 0xe8a090, roughness: 0.88 });
    const hoofMat   = new THREE.MeshStandardMaterial({ color: 0x1a1614, roughness: 0.96 });
    const eyeMat    = new THREE.MeshStandardMaterial({ color: 0x100e0c, roughness: 0.5 });
    const udderMat  = new THREE.MeshStandardMaterial({ color: 0xd9907a, roughness: 0.88 });
    this._mats.push(whiteMat, blackMat, pinkMat, hoofMat, eyeMat, udderMat);

    // Shared geometries
    const legGeom  = new THREE.CylinderGeometry(0.055, 0.045, 0.38, 6);
    const hoofGeom = new THREE.CylinderGeometry(0.050, 0.056, 0.055, 6);
    const eyeGeom  = new THREE.SphereGeometry(0.026, 6, 4);
    this._geoms.push(legGeom, hoofGeom, eyeGeom);

    // Each cow gets a slightly different black patch layout
    const patchLayouts = [
      // Cow 1: big black back patch + black head
      [
        { x:  0.00, y:  0.10, z:  0.00, r: 0.22, mat: 'black' }, // back saddle
        { x:  0.00, y:  0.10, z: -0.20, r: 0.18, mat: 'black' }, // rear patch
        { x:  0.00, y:  0.12, z:  0.24, r: 0.16, mat: 'black' }, // shoulder patch
      ],
      // Cow 2: scattered patches, white head
      [
        { x:  0.14, y:  0.08, z: -0.05, r: 0.16, mat: 'black' }, // side patch
        { x: -0.13, y:  0.10, z:  0.18, r: 0.14, mat: 'black' }, // other side
        { x:  0.00, y:  0.12, z: -0.22, r: 0.13, mat: 'black' }, // rump
      ],
    ];

    const headBlack = [true, false]; // whether this cow has a black head

    for (let ci = 0; ci < Math.min(COW_COUNT, grassTiles.length); ci++) {
      const tile = grassTiles[ci];

      const offX  = (rand() - 0.5) * 0.6;
      const offZ  = (rand() - 0.5) * 0.6;
      const homeX = (tile.x + 0.5 + offX) * TILE_SIZE;
      const homeZ = (tile.z + 0.5 + offZ) * TILE_SIZE;

      const group = new THREE.Group();

      // ── Body ─────────────────────────────────────────────────────────────
      // Slightly oval barrel: wider than tall, flattened top
      const barrelGeom = new THREE.CylinderGeometry(0.22, 0.24, 0.78, 10);
      const barrel = new THREE.Mesh(barrelGeom, whiteMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.scale.y = 1.12; // widen side profile
      barrel.castShadow = true;
      this._geoms.push(barrelGeom);
      group.add(barrel);

      // Black patches as overlapping spheres sitting on the body surface
      for (const p of patchLayouts[ci % patchLayouts.length]) {
        const mat = p.mat === 'black' ? blackMat : whiteMat;
        const pg = new THREE.SphereGeometry(p.r, 7, 5);
        const pm = new THREE.Mesh(pg, mat);
        pm.position.set(p.x, p.y, p.z);
        pm.scale.y = 0.45; // flatten onto surface
        this._geoms.push(pg);
        group.add(pm);
      }

      // ── Head group ────────────────────────────────────────────────────────
      const headGroup = new THREE.Group();
      headGroup.position.set(0, 0.06, -0.52);
      group.add(headGroup);

      const faceColor = headBlack[ci % headBlack.length] ? blackMat : whiteMat;
      const headGeom = new THREE.SphereGeometry(0.18, 9, 7);
      const headMesh = new THREE.Mesh(headGeom, faceColor);
      headMesh.scale.set(0.80, 0.86, 1.18);
      headMesh.castShadow = true;
      this._geoms.push(headGeom);
      headGroup.add(headMesh);

      // White blaze on black-headed cow
      if (headBlack[ci % headBlack.length]) {
        const blazeGeom = new THREE.SphereGeometry(0.07, 6, 4);
        const blaze = new THREE.Mesh(blazeGeom, whiteMat);
        blaze.scale.set(0.60, 1.10, 0.40);
        blaze.position.set(0, 0.02, -0.16);
        this._geoms.push(blazeGeom);
        headGroup.add(blaze);
      }

      // Broad flat muzzle
      const muzzleGeom = new THREE.SphereGeometry(0.090, 7, 5);
      const muzzle = new THREE.Mesh(muzzleGeom, pinkMat);
      muzzle.scale.set(0.95, 0.58, 0.72);
      muzzle.position.set(0, -0.068, -0.175);
      this._geoms.push(muzzleGeom);
      headGroup.add(muzzle);

      // Nostrils
      for (const side of [-1, 1]) {
        const nGeom = new THREE.SphereGeometry(0.018, 4, 3);
        const n = new THREE.Mesh(nGeom, blackMat);
        n.position.set(side * 0.030, -0.074, -0.198);
        this._geoms.push(nGeom);
        headGroup.add(n);
      }

      // Eyes
      const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
      const eyeR = new THREE.Mesh(eyeGeom, eyeMat);
      eyeL.position.set(-0.090, 0.048, -0.155);
      eyeR.position.set( 0.090, 0.048, -0.155);
      headGroup.add(eyeL, eyeR);

      // Small ears
      for (const side of [-1, 1]) {
        const earGeom = new THREE.SphereGeometry(0.058, 5, 4);
        const ear = new THREE.Mesh(earGeom, faceColor);
        ear.scale.set(0.45, 0.68, 0.55);
        ear.position.set(side * 0.19, 0.10, -0.06);
        ear.rotation.z = side * 0.5;
        this._geoms.push(earGeom);
        headGroup.add(ear);
      }

      // Small stub horns (Holsteins are often dehorned, just tiny nubs)
      for (const side of [-1, 1]) {
        const hornGeom = new THREE.CylinderGeometry(0.010, 0.016, 0.10, 5);
        const horn = new THREE.Mesh(hornGeom, new THREE.MeshStandardMaterial({ color: 0xd4c88a, roughness: 0.82 }));
        horn.rotation.z = side * (Math.PI / 2 - 0.5);
        horn.position.set(side * 0.14, 0.17, 0.01);
        this._geoms.push(hornGeom);
        headGroup.add(horn);
      }

      // ── Tail ─────────────────────────────────────────────────────────────
      const tailGeom = new THREE.CylinderGeometry(0.016, 0.012, 0.28, 5);
      const tail = new THREE.Mesh(tailGeom, whiteMat);
      tail.rotation.x = 0.36;
      tail.position.set(0, 0.06, 0.50);
      this._geoms.push(tailGeom);
      group.add(tail);

      const tuftGeom = new THREE.SphereGeometry(0.042, 5, 4);
      const tuft = new THREE.Mesh(tuftGeom, blackMat);
      tuft.position.set(0, 0.01, 0.64);
      this._geoms.push(tuftGeom);
      group.add(tuft);

      // ── Udder ─────────────────────────────────────────────────────────────
      const udderGeom = new THREE.SphereGeometry(0.090, 7, 5);
      const udder = new THREE.Mesh(udderGeom, udderMat);
      udder.scale.set(0.90, 0.60, 0.70);
      udder.position.set(0, -0.195, 0.10);
      this._geoms.push(udderGeom);
      group.add(udder);

      // Teats
      for (const [tx, tz] of [[-0.04, 0.04], [0.04, 0.04], [-0.04, -0.04], [0.04, -0.04]]) {
        const tGeom = new THREE.CylinderGeometry(0.010, 0.008, 0.050, 4);
        const t = new THREE.Mesh(tGeom, udderMat);
        t.position.set(tx, -0.246, 0.10 + tz);
        this._geoms.push(tGeom);
        group.add(t);
      }

      // ── Legs ─────────────────────────────────────────────────────────────
      const legOffsets = [
        [-0.13, -0.26,  0.22],
        [ 0.13, -0.26,  0.22],
        [-0.13, -0.26, -0.18],
        [ 0.13, -0.26, -0.18],
      ];

      // Give each leg a black or white pattern
      const legColors = ci === 0
        ? [blackMat, blackMat, whiteMat, blackMat]
        : [whiteMat, blackMat, whiteMat, whiteMat];

      const legs = legOffsets.map(([lx, ly, lz], li) => {
        const leg = new THREE.Mesh(legGeom, legColors[li]);
        leg.position.set(lx, ly, lz);
        const hoof = new THREE.Mesh(hoofGeom, hoofMat);
        hoof.position.y = -0.218;
        leg.add(hoof);
        group.add(leg);
        return leg;
      });

      // Group Y: body centre at ~0.38 above ground so hooves just touch
      group.position.set(homeX, surfY + 0.38, homeZ);
      group.rotation.y = rand() * Math.PI * 2;
      this.scene.add(group);

      // Register with world so agents can find and milk this cow
      const worldCow = { x: homeX / TILE_SIZE, z: homeZ / TILE_SIZE, milk: 1, milkTimer: 0 };
      this.world.cows.push(worldCow);

      this._cows.push({
        group, legs, headGroup,
        homeX, homeZ, surfY,
        worldCow,
        phase:       rand() * Math.PI * 2,
        wanderAngle: rand() * Math.PI * 2,
        wanderTimer: rand() * 5,
      });
    }
  }

  update(delta) {
    const now = Date.now() * 0.001;
    for (const cow of this._cows) {
      cow.wanderTimer -= delta;
      if (cow.wanderTimer <= 0) {
        cow.wanderAngle += (Math.random() - 0.5) * 0.80;
        cow.wanderTimer = 3 + Math.random() * 5;
      }

      const wx = cow.homeX + Math.cos(cow.wanderAngle) * 0.9;
      const wz = cow.homeZ + Math.sin(cow.wanderAngle) * 0.9;
      const dx = wx - cow.group.position.x;
      const dz = wz - cow.group.position.z;

      const speed = 0.15;
      cow.group.position.x += dx * delta * speed;
      cow.group.position.z += dz * delta * speed;

      if (Math.abs(dx) > 0.002 || Math.abs(dz) > 0.002) {
        cow.group.rotation.y = Math.atan2(dx, dz);
      }

      // Keep world cow position in sync so agents can find them
      cow.worldCow.x = cow.group.position.x / TILE_SIZE;
      cow.worldCow.z = cow.group.position.z / TILE_SIZE;

      const moving = Math.hypot(dx, dz) > 0.04;
      cow.group.position.y = cow.surfY + 0.38 +
        (moving ? Math.abs(Math.sin(now * 1.5 + cow.phase)) * 0.008 : 0);

      // Slow graze nod
      cow.headGroup.rotation.x = Math.sin(now * 0.50 + cow.phase * 0.4) * 0.06;

      // Leg walk
      const swing = moving ? 0.18 * Math.sin(now * 1.5 + cow.phase) : 0;
      cow.legs[0].rotation.x =  swing;
      cow.legs[3].rotation.x =  swing;
      cow.legs[1].rotation.x = -swing;
      cow.legs[2].rotation.x = -swing;
    }
  }

  dispose() {
    for (const { group } of this._cows) this.scene.remove(group);
    for (const g of this._geoms) g.dispose();
    for (const m of this._mats)  m.dispose();
    this._geoms = [];
    this._mats  = [];
    this._cows  = [];
    this.world.cows = [];
  }
}
