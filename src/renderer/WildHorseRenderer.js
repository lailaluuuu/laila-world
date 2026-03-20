import * as THREE from 'three';
import { TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const HOOF = 0x1a1510;

export class WildHorseRenderer {
  constructor(scene, horses, world) {
    this.scene = scene;
    this.horses = horses;
    this.world = world;
    this.entries = [];
    this._geoms = [];
    this._mats = [];
    this._build();
  }

  _build() {
    const hoofMat = new THREE.MeshStandardMaterial({
      color: HOOF,
      roughness: 0.95,
    });
    this._mats.push(hoofMat);

    for (let i = 0; i < this.horses.length; i++) {
      const horseSim = this.horses[i];
      const P = horseSim.coatPreset;

      const bodyMat = new THREE.MeshStandardMaterial({
        color: P.coat,
        roughness: 0.82,
        metalness: 0.02,
      });
      const darkMat = new THREE.MeshStandardMaterial({
        color: P.dark,
        roughness: 0.88,
      });
      const muzzleMat = new THREE.MeshStandardMaterial({
        color: P.muzzle,
        roughness: 0.9,
      });
      const maneMat = new THREE.MeshStandardMaterial({
        color: P.mane,
        roughness: 0.92,
      });
      this._mats.push(bodyMat, darkMat, muzzleMat, maneMat);

      const root = new THREE.Group();
      const horse = new THREE.Group();
      horse.position.y = 0.42;

      // ── Body ──────────────────────────────────────────────────
      // Barrel: longer and slightly more oval
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.21, 0.60, 10, 1),
        bodyMat,
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = 0.02;
      barrel.castShadow = true;
      this._geoms.push(barrel.geometry);

      // Rounded hindquarters — gives the horse its characteristic rump
      const rump = new THREE.Mesh(
        new THREE.SphereGeometry(0.20, 8, 6),
        bodyMat,
      );
      rump.scale.set(0.88, 0.84, 1.05);
      rump.position.set(0, 0.02, 0.26);
      rump.castShadow = true;
      this._geoms.push(rump.geometry);

      // Withers / shoulder area
      const withers = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 8, 6),
        bodyMat,
      );
      withers.scale.set(1.0, 0.85, 1.05);
      withers.position.set(0, 0.1, -0.24);
      withers.castShadow = true;
      this._geoms.push(withers.geometry);

      // ── Neck ─────────────────────────────────────────────────
      // More upright and arched, tapering nicely toward head
      const neck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.13, 0.44, 8, 1),
        bodyMat,
      );
      neck.rotation.x = -0.72;
      neck.position.set(0, 0.20, -0.48);
      neck.castShadow = true;
      this._geoms.push(neck.geometry);

      // Mane: runs along the crest of the neck
      const mane = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.18, 0.40),
        maneMat,
      );
      mane.rotation.x = -0.68;
      mane.position.set(0, 0.33, -0.46);
      mane.castShadow = true;
      this._geoms.push(mane.geometry);
      // ── Head ─────────────────────────────────────────────────
      // Group so the elongated head can tilt naturally
      const headGroup = new THREE.Group();
      headGroup.position.set(0, 0.36, -0.65);
      headGroup.rotation.x = -0.12; // slight nose-down tilt

      // Skull (upper cranium): narrow and deep
      const skull = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.16, 0.28),
        bodyMat,
      );
      skull.position.set(0, 0.02, 0);
      skull.castShadow = true;
      this._geoms.push(skull.geometry);

      // Lower jaw / face: extends the horse's long face
      const jaw = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.10, 0.28),
        bodyMat,
      );
      jaw.position.set(0, -0.08, -0.01);
      jaw.castShadow = true;
      this._geoms.push(jaw.geometry);

      // Muzzle / nostrils at the nose tip
      const muzzle = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.08, 0.10),
        muzzleMat,
      );
      muzzle.position.set(0, -0.06, -0.18);
      muzzle.castShadow = true;
      this._geoms.push(muzzle.geometry);

      // Ears: upright on top of skull
      const earL = new THREE.Mesh(
        new THREE.ConeGeometry(0.032, 0.10, 4),
        darkMat,
      );
      const earR = earL.clone();
      earL.position.set(-0.045, 0.14, 0.06);
      earR.position.set(0.045, 0.14, 0.06);
      earL.rotation.z = 0.22;
      earR.rotation.z = -0.22;
      earL.castShadow = earR.castShadow = true;
      this._geoms.push(earL.geometry);

      // Forelock: small tuft of mane between the ears
      const forelock = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.09, 0.05),
        maneMat,
      );
      forelock.position.set(0, 0.10, 0.05);
      forelock.rotation.x = -0.25;
      forelock.castShadow = true;
      this._geoms.push(forelock.geometry);

      // Eyes: on the sides of the skull, slightly forward
      const eyeGeom = new THREE.SphereGeometry(0.016, 5, 4);
      const eyeMat  = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.6 });
      this._geoms.push(eyeGeom);
      this._mats.push(eyeMat);
      const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
      const eyeR = new THREE.Mesh(eyeGeom, eyeMat);
      eyeL.position.set(-0.066, 0.020, 0.04);
      eyeR.position.set( 0.066, 0.020, 0.04);

      headGroup.add(skull, jaw, muzzle, earL, earR, forelock, eyeL, eyeR);

      // ── Tail ─────────────────────────────────────────────────
      // Two segments: thick root tapering to a flowing end
      const tailGroup = new THREE.Group();
      tailGroup.position.set(0, 0.08, 0.38);
      tailGroup.rotation.x = 0.75;

      const tailRoot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.042, 0.034, 0.18, 6),
        maneMat,
      );
      tailRoot.position.y = -0.09;
      tailRoot.castShadow = true;
      this._geoms.push(tailRoot.geometry);

      const tailFlow = new THREE.Mesh(
        new THREE.CylinderGeometry(0.034, 0.008, 0.38, 6),
        maneMat,
      );
      tailFlow.position.y = -0.37;
      tailFlow.castShadow = true;
      this._geoms.push(tailFlow.geometry);

      tailGroup.add(tailRoot, tailFlow);

      // ── Legs ─────────────────────────────────────────────────
      // Two-segment legs with a knee/hock joint for a realistic silhouette.
      // Front knees angle back slightly; hind hocks angle forward more (horse anatomy).
      const self = this;
      function makeLeg(material, x, z, isFront) {
        const pivot = new THREE.Group();
        pivot.position.set(x, 0, z);

        // Upper leg (thigh / forearm)
        const upper = new THREE.Mesh(
          new THREE.CylinderGeometry(0.056, 0.046, 0.24, 6),
          material,
        );
        upper.position.y = -0.12;
        upper.castShadow = true;
        self._geoms.push(upper.geometry);

        // Joint group: front knee angles back; hind hock angles forward
        const joint = new THREE.Group();
        joint.position.y = -0.24;
        joint.rotation.x = isFront ? -0.16 : 0.24;

        // Lower leg (cannon / pastern)
        const lower = new THREE.Mesh(
          new THREE.CylinderGeometry(0.037, 0.027, 0.22, 6),
          material,
        );
        lower.position.y = -0.11;
        lower.castShadow = true;
        self._geoms.push(lower.geometry);

        const hoof = new THREE.Mesh(
          new THREE.BoxGeometry(0.07, 0.05, 0.09),
          hoofMat,
        );
        hoof.position.y = -0.23;
        hoof.castShadow = true;
        self._geoms.push(hoof.geometry);

        joint.add(lower, hoof);
        pivot.add(upper, joint);
        return { pivot };
      }

      const legFL = makeLeg(bodyMat, 0.11, -0.18, true);
      const legFR = makeLeg(bodyMat, -0.11, -0.18, true);
      const legBL = makeLeg(bodyMat, 0.11, 0.23, false);
      const legBR = makeLeg(bodyMat, -0.11, 0.23, false);

      horse.add(
        barrel,
        rump,
        withers,
        neck,
        mane,
        headGroup,
        tailGroup,
        legFL.pivot,
        legFR.pivot,
        legBL.pivot,
        legBR.pivot,
      );

      // ── Rider (hidden until mounted) ───────────────────────────────────
      const skinTones = [0xd4a574, 0xc68642, 0x8d5524, 0xfad9b5, 0xa0522d, 0xe8c99a];
      const skinTone  = skinTones[i % skinTones.length];
      const riderGroup = new THREE.Group();
      riderGroup.visible = false;

      const riderBodyGeom = new THREE.CylinderGeometry(0.052, 0.062, 0.19, 6);
      const riderBodyMat  = new THREE.MeshLambertMaterial({ color: 0x7a5c3a }); // cloth
      const riderBodyMesh = new THREE.Mesh(riderBodyGeom, riderBodyMat);
      riderBodyMesh.position.y = 0.095;
      riderBodyMesh.castShadow = true;
      this._geoms.push(riderBodyGeom);
      this._mats.push(riderBodyMat);

      const riderHeadGeom = new THREE.SphereGeometry(0.062, 6, 5);
      const riderHeadMat  = new THREE.MeshLambertMaterial({ color: skinTone });
      const riderHeadMesh = new THREE.Mesh(riderHeadGeom, riderHeadMat);
      riderHeadMesh.position.y = 0.235;
      riderHeadMesh.castShadow = true;
      this._geoms.push(riderHeadGeom);
      this._mats.push(riderHeadMat);

      riderGroup.add(riderBodyMesh, riderHeadMesh);
      // Sit on top of barrel, shifted toward withers
      riderGroup.position.set(0, 0.26, -0.10);
      horse.add(riderGroup);

      root.add(horse);
      this.scene.add(root);
      this.entries.push({
        root,
        horse,
        horseSim,
        legs: [legFL, legFR, legBL, legBR],
        tail: tailGroup,
        riderGroup,
      });
    }
  }

  dispose() {
    for (const { root } of this.entries) this.scene.remove(root);
    this.entries = [];
    for (const g of this._geoms) g.dispose();
    this._geoms = [];
    for (const m of this._mats) m.dispose();
    this._mats = [];
  }

  update() {
    for (const entry of this.entries) {
      const { root, horse, horseSim, legs, tail, riderGroup } = entry;
      if (riderGroup) riderGroup.visible = !!horseSim.rider;
      const tile = this.world.getTile(
        Math.floor(horseSim.x),
        Math.floor(horseSim.z),
      );
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;
      const wx = horseSim.x * TILE_SIZE;
      const wz = horseSim.z * TILE_SIZE;
      const liftY = horseSim.isDragged ? 1.5 : 0;

      const fx = horseSim.facingX;
      const fz = horseSim.facingZ;
      const len = Math.hypot(fx, fz) || 1;
      root.position.set(wx, surfY + 0.02 + liftY, wz);
      // Rotate only on Y so the horse stays level — head is on −Z, tail on +Z
      root.rotation.set(0, Math.atan2(-fx / len, -fz / len), 0);

      const phase = horseSim.gallopPhase;
      const gait = horseSim.gait;
      const jumping = horseSim.jumpT > 0 && horseSim.jumpT < 1;
      const jumpY =
        jumping && horseSim.jumpT > 0
          ? Math.sin(Math.PI * Math.min(1, horseSim.jumpT)) * 0.38
          : 0;
      root.position.y += jumpY;

      let bounce = 0;
      let swing = 0.22;
      let pitch = 0.02;
      if (gait === 'run' && !jumping) {
        bounce = Math.abs(Math.sin(phase * 2)) * 0.055;
        swing = 0.52;
        pitch = 0.06;
      } else if (gait === 'walk' && !jumping) {
        bounce = Math.abs(Math.sin(phase)) * 0.022;
        swing = 0.28;
        pitch = 0.025;
      } else if (gait === 'idle') {
        bounce = Math.sin(phase * 0.5) * 0.012;
        swing = 0.06;
        pitch = 0.01;
      }
      if (jumping) {
        swing *= 0.35;
        pitch = 0.03;
      }

      horse.position.y = 0.42 + bounce;
      horse.rotation.x = Math.sin(phase * (gait === 'run' ? 2 : 1)) * pitch;

      legs[0].pivot.rotation.x = swing * Math.sin(phase);
      legs[1].pivot.rotation.x = swing * Math.sin(phase + Math.PI);
      legs[2].pivot.rotation.x = swing * Math.sin(phase + Math.PI * 0.5);
      legs[3].pivot.rotation.x = swing * Math.sin(phase + Math.PI * 1.5);

      tail.rotation.z = Math.sin(phase * 2) * (gait === 'run' ? 0.15 : 0.08);
    }
  }
}
