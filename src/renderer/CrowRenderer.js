/**
 * CrowRenderer — Monument Valley 1 Crow People, accurate recreation.
 *
 * Shape anatomy:
 *   - Body:  upright ConeGeometry — wide base at feet, tapers to a point
 *            at the top where the head rests. 8 radial segments + flatShading
 *            gives the angular-yet-rounded MV1 silhouette.
 *   - Head + beak: one merged BufferGeometry (MV silhouette: round cranium
 *            flowing into a triangular prism beak — no separate meshes).
 *   - Eyes:  lateral white discs with very large black pupils, flush with head.
 *   - Legs:  long thin sticks, very prominent.
 *   - Wings: hidden unless flying (visibility off on the ground).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

const BODY_COLOR  = 0x0e0e1a;  // near-black dark indigo
const EYE_COLOR   = 0xffffff;  // white sclera
const PUPIL_COLOR = 0x060608;  // near-black pupil

export class CrowRenderer {
  constructor(scene, crows, world) {
    this.scene   = scene;
    this.crows   = crows;
    this.world   = world;
    this.entries = [];
    this._geoms  = [];
    this._mats   = [];
    this._mat    = null;
    this._eyeMat = null;
    this._initGeoms();
    for (const c of this.crows) this._buildEntry(c);
  }

  _initGeoms() {
    this._mat = new THREE.MeshStandardMaterial({
      color:       BODY_COLOR,
      roughness:   0.90,
      metalness:   0.0,
      flatShading: true,
    });
    this._eyeMat = new THREE.MeshStandardMaterial({
      color:     EYE_COLOR,
      roughness: 0.22,
      side:      THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits:  1,
    });
    this._pupilMat = new THREE.MeshStandardMaterial({
      color:     PUPIL_COLOR,
      roughness: 0.35,
      side:      THREE.DoubleSide,
      depthWrite: false,
    });
    this._mats.push(this._mat, this._eyeMat, this._pupilMat);

    // Body: upright cone.  THREE.js ConeGeometry puts apex at +Y, base at -Y.
    // 8 radial segments + flatShading → 8 large angular faces.
    // radius 0.16, height 0.30 → base radius matches the MV1 wide-bottomed silhouette.
    this._bodyGeom = new THREE.ConeGeometry(0.16, 0.30, 8);

    // Head + beak merged into one mesh (same material, continuous silhouette).
    const headR = 0.105;
    const beakH = 0.20;
    const beakBaseR = 0.10;
    const sphere = new THREE.SphereGeometry(headR, 7, 5);
    const cone = new THREE.ConeGeometry(beakBaseR, beakH, 3);
    const beakHolder = new THREE.Mesh(cone);
    beakHolder.rotation.x = -Math.PI / 2;
    beakHolder.position.set(0, -0.028, -headR - beakH * 0.5);
    beakHolder.updateMatrix();
    cone.applyMatrix4(beakHolder.matrix);
    this._headBeakGeom = mergeGeometries([sphere, cone]);
    sphere.dispose();
    cone.dispose();

    // Eyes: very large side eyes with huge pupils and a thin white rim.
    this._EYE_R_OUTER = 0.085;
    this._EYE_R_PUPIL = 0.066;
    this._eyeRingGeom = new THREE.CircleGeometry(this._EYE_R_OUTER, 40);
    this._pupilDiscGeom = new THREE.CircleGeometry(this._EYE_R_PUPIL, 32);

    // Wings: flat slabs, visible only when flying
    this._wingGeom = new THREE.BoxGeometry(0.44, 0.040, 0.22);

    // Legs: very thin, 5-sided (slight angularity), moderately long
    this._legGeom  = new THREE.CylinderGeometry(0.013, 0.011, 0.20, 5);
    // Feet: visible single triangular foot per leg
    this._toeGeom = new THREE.ConeGeometry(0.020, 0.060, 3);

    this._geoms.push(
      this._bodyGeom, this._headBeakGeom,
      this._eyeRingGeom, this._pupilDiscGeom, this._wingGeom, this._legGeom, this._toeGeom,
    );
  }

  _buildEntry(crowSim) {
    const mat      = this._mat;
    const eyeMat   = this._eyeMat;
    const pupilMat = this._pupilMat;

    const root = new THREE.Group();

    // ── Legs ─────────────────────────────────────────────────────────────
    // Leg height 0.20, centred at y = 0.10 → bottom edge at y = 0 (ground).
    const legL = new THREE.Mesh(this._legGeom, mat);
    const legR = new THREE.Mesh(this._legGeom, mat);
    legL.position.set(-0.046, 0.10, 0.01);
    legR.position.set( 0.046, 0.10, 0.01);
    legL.castShadow = legR.castShadow = true;
    root.add(legL, legR);

    const buildFoot = (x) => {
      const foot = new THREE.Group();
      foot.position.set(x, 0.0008, 0.012);
      const toe = new THREE.Mesh(this._toeGeom, mat);
      toe.rotation.x = 0;
      toe.position.set(0, 0.030, -0.024);
      toe.castShadow = true;
      foot.add(toe);
      return foot;
    };
    const footL = buildFoot(-0.046);
    const footR = buildFoot(0.046);
    root.add(footL, footR);

    // ── Body cone ─────────────────────────────────────────────────────────
    // Centre at y = 0.32 → base at y = 0.17 (just above leg tops),
    // apex (tip) at y = 0.47.
    const bodyMesh = new THREE.Mesh(this._bodyGeom, mat);
    bodyMesh.position.set(0, 0.32, 0);
    bodyMesh.castShadow = true;
    root.add(bodyMesh);

    // ── Wing pivot groups ─────────────────────────────────────────────────
    // Shoulders at roughly mid-cone height. Wings fold to near-vertical
    // when standing so they're invisible from the front — exactly like MV1.
    const wingGroupL = new THREE.Group();
    wingGroupL.position.set(-0.11, 0.30, 0.02);
    const wingPanelL = new THREE.Mesh(this._wingGeom, mat);
    wingPanelL.position.set(-0.22, 0, 0);
    wingPanelL.castShadow = true;
    wingGroupL.add(wingPanelL);
    root.add(wingGroupL);

    const wingGroupR = new THREE.Group();
    wingGroupR.position.set(0.11, 0.30, 0.02);
    const wingPanelR = new THREE.Mesh(this._wingGeom, mat);
    wingPanelR.position.set(0.22, 0, 0);
    wingPanelR.castShadow = true;
    wingGroupR.add(wingPanelR);
    root.add(wingGroupR);
    wingGroupL.visible = wingGroupR.visible = false;

    // ── Head ─────────────────────────────────────────────────────────────
    // Centred at y = 0.52, slightly above the cone apex (0.47).
    // The overlap hides the join — no visible neck, just like MV1.
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.52, 0);

    const headBeakMesh = new THREE.Mesh(this._headBeakGeom, mat);
    headBeakMesh.castShadow = true;
    headGroup.add(headBeakMesh);

    // Lateral eyes: white disc + black pupil disc, anchored on head surface.
    const headR = 0.105;
    const eyeSurfaceOffset = 0.002;
    const inset = headR + eyeSurfaceOffset;
    const dirL = new THREE.Vector3(-1, 0.18, -0.16).normalize();
    const dirR = new THREE.Vector3(1, 0.18, -0.16).normalize();
    const zWhite = 0.0002;
    const zPupil = 0.0004;

    const addEye = (dir) => {
      const g = new THREE.Group();
      g.position.copy(dir.clone().multiplyScalar(inset));
      g.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        dir.clone(),
      );
      const white = new THREE.Mesh(this._eyeRingGeom, eyeMat);
      white.position.z = zWhite;
      white.castShadow = false;
      white.renderOrder = 10;
      const pupil = new THREE.Mesh(this._pupilDiscGeom, pupilMat);
      pupil.position.z = zPupil;
      pupil.castShadow = false;
      pupil.renderOrder = 11;
      g.add(white, pupil);
      return g;
    };

    headGroup.add(addEye(dirL), addEye(dirR));

    root.add(headGroup);

    this.scene.add(root);
    this.entries.push({
      root, crowSim,
      bodyMesh, headGroup,
      wingGroupL, wingGroupR,
      legL, legR, footL, footR,
    });
  }

  /** Dynamically add a crow after initial construction. */
  addCrow(crowSim) {
    this.crows.push(crowSim);
    this._buildEntry(crowSim);
  }

  update(delta) {
    for (const {
      root, crowSim,
      bodyMesh, headGroup,
      wingGroupL, wingGroupR,
      legL, legR, footL, footR,
    } of this.entries) {
      const tile  = this.world.getTile(Math.floor(crowSim.x), Math.floor(crowSim.z));
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.1;

      const fx  = crowSim.facingX;
      const fz  = crowSim.facingZ;
      const len = Math.hypot(fx, fz) || 1;

      root.position.set(
        crowSim.x * TILE_SIZE,
        surfY + crowSim.y,
        crowSim.z * TILE_SIZE,
      );
      root.rotation.y = Math.atan2(-fx / len, -fz / len);

      const phase  = crowSim.walkPhase;
      const wPhase = crowSim.wingPhase;
      const isFlying = crowSim.state === 'flying';
      const isHop    = crowSim.state === 'hopping';

      if (isFlying) {
        wingGroupL.visible = wingGroupR.visible = true;
        const flap = Math.sin(wPhase) * 0.45 - 0.06;
        wingGroupL.rotation.z = flap;
        wingGroupR.rotation.z = -flap;

        // Slight nose-down pitch for forward flight
        root.rotation.x = -0.12;

        // Retract legs during flight
        legL.visible = legR.visible = false;
        footL.visible = footR.visible = false;

        headGroup.rotation.x = 0;
        bodyMesh.position.y  = 0.32;
        headGroup.position.y = 0.52;

      } else {
        wingGroupL.visible = wingGroupR.visible = false;
        wingGroupL.rotation.z = -1.32;
        wingGroupR.rotation.z =  1.32;

        root.rotation.x = 0;
        legL.visible = legR.visible = true;
        footL.visible = footR.visible = true;

        if (isHop) {
          // Two-beat hop: body and head lift together
          const bounce = Math.abs(Math.sin(phase * 2)) * 0.045;
          bodyMesh.position.y  = 0.32 + bounce;
          headGroup.position.y = 0.52 + bounce;
          headGroup.rotation.x = Math.sin(phase) * 0.07;

          // Leg swing
          legL.rotation.x =  Math.sin(phase)           * 0.18;
          legR.rotation.x =  Math.sin(phase + Math.PI) * 0.18;
        } else {
          // Idle: still body, slow curious head tilt
          bodyMesh.position.y  = 0.32;
          headGroup.position.y = 0.52;
          headGroup.rotation.x = Math.sin(phase * 0.5) * 0.04;

          legL.rotation.x = 0;
          legR.rotation.x = 0;
        }
      }
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
}
