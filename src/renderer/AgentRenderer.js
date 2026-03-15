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


export class AgentRenderer {
  constructor(scene, agents, world) {
    this.scene  = scene;
    this.agents = agents;
    this.world  = world;
    this.meshes = [];

    // Speech bubble DOM overlay
    this._bubbleContainer = document.createElement('div');
    this._bubbleContainer.id = 'speech-bubbles';
    document.body.appendChild(this._bubbleContainer);
    /** Map<agentId, HTMLElement> */
    this._bubbleEls = new Map();

    this._build();
  }

  _build() {
    // Sheep wool — overlapping spheres make a fluffy cloud-like body
    this._puffData = [
      { geom: new THREE.SphereGeometry(0.22, 8, 6),  x:  0,     y: 0.15, z:  0    },
      { geom: new THREE.SphereGeometry(0.18, 7, 5),  x: -0.17,  y: 0.13, z:  0.02 },
      { geom: new THREE.SphereGeometry(0.18, 7, 5),  x:  0.17,  y: 0.13, z:  0.02 },
      { geom: new THREE.SphereGeometry(0.17, 7, 5),  x:  0,     y: 0.27, z: -0.02 },
      { geom: new THREE.SphereGeometry(0.155, 7, 5), x: -0.09,  y: 0.22, z:  0.12 },
      { geom: new THREE.SphereGeometry(0.155, 7, 5), x:  0.09,  y: 0.22, z:  0.12 },
      { geom: new THREE.SphereGeometry(0.14, 7, 5),  x:  0,     y: 0.13, z: -0.17 },
    ];

    this._headGeom  = new THREE.SphereGeometry(0.10, 8, 6);
    this._eyeGeom   = new THREE.SphereGeometry(0.022, 5, 4);
    this._legGeom   = new THREE.CylinderGeometry(0.036, 0.030, 0.16, 5);

    this._eyeMat   = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.5 });
    this._faceMat  = new THREE.MeshStandardMaterial({ color: 0xdcc8a0, roughness: 0.85 });
    this._legMat   = new THREE.MeshStandardMaterial({ color: 0xbcaa90, roughness: 0.90 });

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
    const isBlackSheep = agent.id === 1;
    const bodyMat = new THREE.MeshStandardMaterial({
      color: isBlackSheep ? 0x1a1a1a : 0xf5f2ec,
      roughness: 0.72,
    });

    // Wool puffs — all share bodyMat so state colour tints the whole fleece
    const woolPuffs = this._puffData.map(({ geom, x, y, z }) => {
      const puff = new THREE.Mesh(geom, bodyMat);
      puff.position.set(x, y, z);
      puff.castShadow = true;
      return puff;
    });
    const body = woolPuffs[0]; // used for hit-testing

    // Head — small, forward-facing
    const head = new THREE.Mesh(this._headGeom, this._faceMat);
    head.position.set(0, 0.12, 0.26);

    // Eyes
    const eyeL = new THREE.Mesh(this._eyeGeom, this._eyeMat);
    const eyeR = new THREE.Mesh(this._eyeGeom, this._eyeMat);
    eyeL.position.set(-0.048, 0.15, 0.30);
    eyeR.position.set( 0.048, 0.15, 0.30);

    // Four stubby legs — stored for walk animation (diagonal pairs: [0,3] and [1,2])
    const legOffsets = [[-0.09, -0.12, 0.07], [0.09, -0.12, 0.07], [-0.09, -0.12, -0.07], [0.09, -0.12, -0.07]];
    const legs = legOffsets.map(([x, y, z]) => {
      const leg = new THREE.Mesh(this._legGeom, this._legMat);
      leg.position.set(x, y, z);
      return leg;
    });

    const boatGroup = this._buildBoat();
    boatGroup.visible = false;

    const group = new THREE.Group();
    group.add(...woolPuffs, head, eyeL, eyeR, ...legs, boatGroup);
    group.userData.agentId = agent.id;

    this.scene.add(group);
    this.meshes.push({ group, body, bodyMat, boatGroup, legs, agent });
  }

  /** Call this when a new agent is born at runtime */
  addAgent(agent) {
    this._createMeshFor(agent);
  }

  /** Remove all agent meshes and free GPU memory */
  dispose() {
    for (const { group, bodyMat } of this.meshes) {
      this.scene.remove(group);
      bodyMat.dispose();
    }
    for (const { geom } of this._puffData) geom.dispose();
    this._headGeom.dispose();
    this._eyeGeom.dispose();
    this._legGeom.dispose();
    this._eyeMat.dispose();
    this._faceMat.dispose();
    this._legMat.dispose();
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
    this._bubbleEls.forEach(el => el.remove());
    this._bubbleEls.clear();
    this._bubbleContainer.remove();
  }

  update(camera) {
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
        }
        this.meshes = this.meshes.filter(e => e.agent.health > 0);
      }
    }

    for (const { group, bodyMat, boatGroup, legs, agent } of this.meshes) {
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
      bodyMat.emissive.setHex(agent.selected ? 0x222244 : 0x000000);

      if (agent.selected) ringTarget = group;

      // Juveniles are visibly smaller
      group.scale.setScalar(agent.isAdult ? 1.0 : 0.55);

      // Leg walk animation — slow amble, stops when sleeping
      const walking = agent.state !== AgentState.SLEEPING;
      const t = Date.now() * 0.00038 + agent.id * 2.4;
      const swing = walking ? 0.28 * Math.sin(t) : 0;
      legs[0].rotation.x =  swing;       // front-left
      legs[3].rotation.x =  swing;       // back-right  (same diagonal pair)
      legs[1].rotation.x = -swing;       // front-right
      legs[2].rotation.x = -swing;       // back-left   (opposite pair)

      // Gentle body bob in sync with step
      group.position.y += walking
        ? Math.abs(Math.sin(t)) * 0.018   // lifts slightly on each stride
        : Math.sin(Date.now() * 0.0004 + agent.id * 1.3) * 0.010; // slow sleeping sway
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

    // Speech bubbles: project 3D agent positions to screen space
    if (camera) this._updateBubbles(camera);
  }

  _updateBubbles(camera) {
    const canvas = camera.userData._canvas ?? (camera.userData._canvas = document.getElementById('world-canvas'));
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!this._bubblePos) this._bubblePos = new THREE.Vector3();
    const _pos = this._bubblePos;

    const activeIds = new Set();

    for (const { group, agent } of this.meshes) {
      const camDist = group.position.distanceTo(camera.position);
      if (agent.health <= 0 || !agent.speechBubble || camDist > 10) {
        const el = this._bubbleEls.get(agent.id);
        if (el) { el.style.display = 'none'; }
        continue;
      }

      activeIds.add(agent.id);

      // Project the world position (slightly above head) to NDC
      _pos.set(group.position.x, group.position.y + 0.7 * (agent.isAdult ? 1.0 : 0.55), group.position.z);
      _pos.project(camera);

      // NDC to CSS pixels
      const sx = ( _pos.x * 0.5 + 0.5) * w;
      const sy = (-_pos.y * 0.5 + 0.5) * h;

      // Don't show if behind camera
      if (_pos.z > 1) {
        const el = this._bubbleEls.get(agent.id);
        if (el) el.style.display = 'none';
        continue;
      }

      let el = this._bubbleEls.get(agent.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'speech-bubble';
        this._bubbleContainer.appendChild(el);
        this._bubbleEls.set(agent.id, el);
      }

      if (!el._typing) {
        el.innerHTML = '<span></span><span></span><span></span>';
        el._typing = true;
      }
      el.style.display = '';
      el.style.left = `${sx}px`;
      el.style.top  = `${sy}px`;

      // Fade out as timer runs low
      const fade = Math.min(1, agent.speechBubbleTimer / 0.5);
      el.style.opacity = fade.toFixed(2);
    }

    // Hide bubbles for agents not in active set
    this._bubbleEls.forEach((el, id) => {
      if (!activeIds.has(id)) el.style.display = 'none';
    });
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
