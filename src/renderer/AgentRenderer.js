import * as THREE from 'three';
import { AgentState } from '../simulation/Agent.js';
import { TileType, TILE_SIZE } from '../simulation/World.js';
import { TerrainRenderer } from './TerrainRenderer.js';

// State body colours
const STATE_COLOR = {
  [AgentState.WANDERING]:   new THREE.Color(0x94a3b8),
  [AgentState.GATHERING]:   new THREE.Color(0xfbbf24),
  [AgentState.SLEEPING]:    new THREE.Color(0x4c6ef5),
  [AgentState.SOCIALIZING]: new THREE.Color(0xa78bfa),
  [AgentState.DISCOVERING]: new THREE.Color(0xfb923c),
};

const DEAD_COLOR = new THREE.Color(0x2a2a2a);

// Six varied skin tones, assigned round-robin by agent ID
const SKIN_TONES = [0xf5d0a9, 0xebb98a, 0xd4956e, 0xc98b6a, 0xe8c49a, 0xbf8860];

export class AgentRenderer {
  constructor(scene, agents, world) {
    this.scene  = scene;
    this.agents = agents;
    this.world  = world;
    this.meshes = [];
    this._build();
  }

  _build() {
    // Shared geometries — agents
    this._bodyGeom = new THREE.CapsuleGeometry(0.155, 0.36, 4, 8);
    this._headGeom = new THREE.SphereGeometry(0.155, 8, 7);
    this._eyeGeom  = new THREE.SphereGeometry(0.038, 5, 4);
    this._eyeMat   = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.5 });

    // Shared boat geometries
    this._boatHullGeom = new THREE.BoxGeometry(0.70, 0.11, 0.32);
    this._boatMastGeom = new THREE.CylinderGeometry(0.018, 0.018, 0.52, 5);
    this._sailGeom     = new THREE.PlaneGeometry(0.24, 0.34);
    this._boatHullMat  = new THREE.MeshStandardMaterial({ color: 0x8b5e3c, roughness: 0.9 });
    this._boatMastMat  = new THREE.MeshStandardMaterial({ color: 0x5a3e28, roughness: 0.9 });
    this._sailMat      = new THREE.MeshStandardMaterial({ color: 0xf0e8d0, side: THREE.DoubleSide, roughness: 0.8 });

    // One shared selection ring, repositioned each frame
    this._ring = new THREE.Mesh(
      new THREE.RingGeometry(0.30, 0.44, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
      }),
    );
    this._ring.rotation.x = -Math.PI / 2;
    this._ring.visible = false;
    this.scene.add(this._ring);

    for (const agent of this.agents) {
      this._createMeshFor(agent);
    }
  }

  _buildBoat() {
    const bg = new THREE.Group();

    const hull = new THREE.Mesh(this._boatHullGeom, this._boatHullMat);
    hull.position.y = -0.27; // below agent torso, sits on water surface
    hull.castShadow = true;

    const mast = new THREE.Mesh(this._boatMastGeom, this._boatMastMat);
    mast.position.set(0, -0.27 + 0.26, 0);

    const sail = new THREE.Mesh(this._sailGeom, this._sailMat);
    sail.position.set(0.01, -0.27 + 0.33, 0);
    sail.rotation.y = Math.PI / 2; // sail billows sideways

    bg.add(hull, mast, sail);
    return bg;
  }

  _createMeshFor(agent) {
    const skinColor = SKIN_TONES[agent.id % SKIN_TONES.length];

    const bodyMat = new THREE.MeshStandardMaterial({
      color: STATE_COLOR[agent.state] ?? STATE_COLOR[AgentState.WANDERING],
      roughness: 0.78,
    });
    const headMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.85 });

    const body = new THREE.Mesh(this._bodyGeom, bodyMat);
    body.castShadow = true;

    const head = new THREE.Mesh(this._headGeom, headMat);
    head.castShadow = true;
    head.position.y = 0.39;

    // Eyes — share geometry + material
    const eyeL = new THREE.Mesh(this._eyeGeom, this._eyeMat);
    const eyeR = new THREE.Mesh(this._eyeGeom, this._eyeMat);
    eyeL.position.set(-0.065, 0.42, 0.125);
    eyeR.position.set( 0.065, 0.42, 0.125);

    const boatGroup = this._buildBoat();
    boatGroup.visible = false;

    const group = new THREE.Group();
    group.add(body, head, eyeL, eyeR, boatGroup);
    group.userData.agentId = agent.id;

    this.scene.add(group);
    this.meshes.push({ group, body, bodyMat, headMat, boatGroup, agent });
  }

  /** Call this when a new agent is born at runtime */
  addAgent(agent) {
    this._createMeshFor(agent);
  }

  /** Remove all agent meshes and free GPU memory */
  dispose() {
    for (const { group, bodyMat, headMat } of this.meshes) {
      this.scene.remove(group);
      bodyMat.dispose();
      headMat.dispose();
    }
    this._bodyGeom.dispose();
    this._headGeom.dispose();
    this._eyeGeom.dispose();
    this._eyeMat.dispose();
    this._boatHullGeom.dispose();
    this._boatMastGeom.dispose();
    this._sailGeom.dispose();
    this._boatHullMat.dispose();
    this._boatMastMat.dispose();
    this._sailMat.dispose();
    this.scene.remove(this._ring);
    this._ring.geometry.dispose();
    this._ring.material.dispose();
    this.meshes = [];
  }

  update() {
    let ringTarget = null;

    // Periodic dead-mesh cleanup: remove GPU resources for long-dead agents
    // Runs every ~600 frames (≈10s at 60fps) to prevent unbounded mesh growth
    this._cleanupTick = (this._cleanupTick ?? 0) + 1;
    if (this._cleanupTick % 600 === 0) {
      const toRemove = this.meshes.filter(e => e.agent.health <= 0);
      if (toRemove.length > 30) {
        for (const entry of toRemove) {
          this.scene.remove(entry.group);
          entry.bodyMat.dispose();
          entry.headMat.dispose();
        }
        this.meshes = this.meshes.filter(e => e.agent.health > 0);
      }
    }

    for (const { group, bodyMat, boatGroup, agent } of this.meshes) {
      if (agent.health <= 0) {
        bodyMat.color.copy(DEAD_COLOR);
        bodyMat.emissive.set(0x000000);
        group.visible = false;
        continue;
      }

      // World position
      const tile = this.world.getTile(Math.floor(agent.x), Math.floor(agent.z));
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;
      group.position.set(
        agent.x * TILE_SIZE,
        surfY + 0.30,
        agent.z * TILE_SIZE,
      );

      // Face movement direction
      group.rotation.y = Math.atan2(agent.facingX, agent.facingZ);

      // Boat: visible when sailing on water
      const onWater = tile?.type === TileType.WATER || tile?.type === TileType.DEEP_WATER;
      const hasSailing = agent.knowledge?.has('sailing') ?? false;
      boatGroup.visible = onWater && hasSailing;

      // Body colour + emissive selection highlight
      if (agent.discoveryFlash > 0) {
        bodyMat.color.copy(STATE_COLOR[AgentState.DISCOVERING]);
        bodyMat.emissive.setHex(0x3a1a00);
      } else {
        bodyMat.color.copy(STATE_COLOR[agent.state] ?? STATE_COLOR[AgentState.WANDERING]);
        bodyMat.emissive.setHex(agent.selected ? 0x222244 : 0x000000);
      }

      if (agent.selected) ringTarget = group;

      // Juveniles are visibly smaller
      group.scale.setScalar(agent.isAdult ? 1.0 : 0.55);

      // Slight bob
      group.position.y += Math.sin(Date.now() * 0.003 + agent.id * 1.3) * 0.04;
    }

    // Selection ring follows selected agent with a gentle pulse
    if (ringTarget) {
      this._ring.visible = true;
      const pulse = 0.92 + Math.sin(Date.now() * 0.004) * 0.08;
      this._ring.scale.setScalar(pulse);
      this._ring.position.set(
        ringTarget.position.x,
        ringTarget.position.y - 0.26,
        ringTarget.position.z,
      );
    } else {
      this._ring.visible = false;
    }
  }

  /** Returns the agent whose mesh was hit by a raycast, or null */
  hitTest(raycaster) {
    const allMeshes = this.meshes.map(m => m.group.children[0]);
    const hits = raycaster.intersectObjects(allMeshes, false);
    if (hits.length === 0) return null;
    const hitBody = hits[0].object;
    const entry = this.meshes.find(m => m.body === hitBody);
    return entry ? entry.agent : null;
  }
}
