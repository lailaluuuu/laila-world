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
  [AgentState.PERFORMING]:  new THREE.Color(0xf472b6),
};

const MUSIC_NOTES = ['♪', '♫', '𝅗𝅥', '♩', '🎵'];

const DEAD_COLOR = new THREE.Color(0x2a2a2a);

// Six varied skin tones, assigned round-robin by agent ID
const SKIN_TONES = [0xf5d0a9, 0xebb98a, 0xd4956e, 0xc98b6a, 0xe8c49a, 0xbf8860];


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

    // Music notes DOM overlay
    this._notesContainer = document.createElement('div');
    this._notesContainer.id = 'music-notes';
    document.body.appendChild(this._notesContainer);
    /** Map<agentId, { timer: number }> — tracks when to spawn next note */
    this._noteTimers = new Map();

    this._build();
  }

  _build() {
    // Shared geometries — upright humanoid people
    this._bodyGeom = new THREE.CapsuleGeometry(0.155, 0.36, 4, 8);
    this._headGeom = new THREE.SphereGeometry(0.155, 8, 7);
    this._eyeGeom  = new THREE.SphereGeometry(0.038, 5, 4);
    this._eyeMat   = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.5 });
    this._lashGeom = new THREE.BoxGeometry(0.007, 0.043, 0.006);
    this._lashMat  = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.5 });

    // Instrument geometries (lute + drum)
    this._luteBodyGeom  = new THREE.SphereGeometry(0.095, 8, 6);
    this._luteNeckGeom  = new THREE.CylinderGeometry(0.016, 0.012, 0.26, 5);
    this._drumGeom      = new THREE.CylinderGeometry(0.10, 0.10, 0.07, 10);
    this._drumTopGeom   = new THREE.CylinderGeometry(0.102, 0.102, 0.008, 10);
    this._woodMat       = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8 });
    this._drumMat       = new THREE.MeshStandardMaterial({ color: 0x5c3d1e, roughness: 0.85 });
    this._drumskinMat   = new THREE.MeshStandardMaterial({ color: 0xe8d5a3, roughness: 0.9 });

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

  _addEyelashes(group, eyePos) {
    const offsets = [-0.028, -0.010, 0.010, 0.028];
    const tilts   = [  0.35,   0.12, -0.12, -0.35];
    for (let i = 0; i < 4; i++) {
      const lash = new THREE.Mesh(this._lashGeom, this._lashMat);
      lash.position.set(eyePos.x + offsets[i], eyePos.y + 0.043, eyePos.z + 0.004);
      lash.rotation.z = tilts[i];
      group.add(lash);
    }
  }

  _buildInstrument(isLute) {
    const g = new THREE.Group();
    if (isLute) {
      const body = new THREE.Mesh(this._luteBodyGeom, this._woodMat);
      body.scale.set(1, 1.1, 0.55);
      const neck = new THREE.Mesh(this._luteNeckGeom, this._woodMat);
      neck.position.y = 0.19;
      g.add(body, neck);
    } else {
      const shell = new THREE.Mesh(this._drumGeom, this._drumMat);
      const top   = new THREE.Mesh(this._drumTopGeom, this._drumskinMat);
      top.position.y = 0.039;
      g.add(shell, top);
    }
    // Held at right side, chest height, angled outward
    g.position.set(0.22, 0.05, 0.08);
    g.rotation.set(0, 0, -0.4);
    g.visible = false;
    return g;
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

    const boatGroup       = this._buildBoat();
    boatGroup.visible = false;

    const instrumentGroup = this._buildInstrument(agent.id % 2 === 0);

    const group = new THREE.Group();
    group.add(body, head, eyeL, eyeR, boatGroup, instrumentGroup);

    if (agent.gender === 'female') {
      this._addEyelashes(group, eyeL.position);
      this._addEyelashes(group, eyeR.position);
    }
    group.userData.agentId = agent.id;

    this.scene.add(group);
    this.meshes.push({ group, body, bodyMat, headMat, boatGroup, instrumentGroup, agent });
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
    this._lashGeom.dispose();
    this._lashMat.dispose();
    this._boatHullGeom.dispose();
    this._boatMastGeom.dispose();
    this._sailGeom.dispose();
    this._boatHullMat.dispose();
    this._boatMastMat.dispose();
    this._sailMat.dispose();
    this._luteBodyGeom.dispose();
    this._luteNeckGeom.dispose();
    this._drumGeom.dispose();
    this._drumTopGeom.dispose();
    this._woodMat.dispose();
    this._drumMat.dispose();
    this._drumskinMat.dispose();
    this.scene.remove(this._ring);
    this._ring.geometry.dispose();
    this._ring.material.dispose();
    this.meshes = [];
    this._bubbleEls.forEach(el => el.remove());
    this._bubbleEls.clear();
    this._bubbleContainer.remove();
    this._notesContainer.remove();
    this._noteTimers.clear();
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
          entry.headMat.dispose();
        }
        this.meshes = this.meshes.filter(e => e.agent.health > 0);
      }
    }

    for (const { group, bodyMat, boatGroup, instrumentGroup, agent } of this.meshes) {
      if (agent.health <= 0) {
        bodyMat.color.copy(DEAD_COLOR);
        bodyMat.emissive.set(0x000000);
        group.visible = false;
        continue;
      }

      // World position
      const tile = this.world.getTile(Math.floor(agent.x), Math.floor(agent.z));
      const surfY = tile ? TerrainRenderer.surfaceY(tile.type) : 0.14;
      const liftY = agent.isDragged ? 1.2 : 0;
      group.position.set(
        agent.x * TILE_SIZE,
        surfY + 0.30 + liftY,
        agent.z * TILE_SIZE,
      );

      // Face movement direction
      group.rotation.y = Math.atan2(agent.facingX, agent.facingZ);

      // Boat: visible when sailing on water
      const onWater = tile?.type === TileType.WATER || tile?.type === TileType.DEEP_WATER;
      const hasSailing = agent.knowledge?.has('sailing') ?? false;
      boatGroup.visible = onWater && hasSailing;

      // Body colour + discovery flash
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

      // Instrument: visible while performing, gentle strum sway
      const performing = agent.state === AgentState.PERFORMING;
      instrumentGroup.visible = performing;
      if (performing) {
        const strum = Math.sin(Date.now() * 0.005 + agent.id) * 0.18;
        instrumentGroup.rotation.z = -0.4 + strum;
      }
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

    // Speech bubbles + music notes: project 3D agent positions to screen space
    if (camera) {
      this._updateBubbles(camera);
      this._updateMusicNotes(camera);
    }
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

  _updateMusicNotes(camera) {
    const canvas = camera.userData._canvas ?? document.getElementById('world-canvas');
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!this._bubblePos) this._bubblePos = new THREE.Vector3();
    const _pos = this._bubblePos;
    const now = performance.now();

    for (const { group, agent } of this.meshes) {
      if (agent.health <= 0 || agent.state !== AgentState.PERFORMING) {
        this._noteTimers.delete(agent.id);
        continue;
      }

      const camDist = group.position.distanceTo(camera.position);
      if (camDist > 18) continue;

      // Track per-agent note spawn timer (real milliseconds)
      let nt = this._noteTimers.get(agent.id);
      if (!nt) { nt = { next: now }; this._noteTimers.set(agent.id, nt); }
      if (now < nt.next) continue;
      nt.next = now + 700 + Math.random() * 500;

      // Project position above head to screen
      _pos.set(group.position.x, group.position.y + 0.9, group.position.z);
      _pos.project(camera);
      if (_pos.z > 1) continue;

      const sx = ( _pos.x * 0.5 + 0.5) * w + (Math.random() - 0.5) * 14;
      const sy = (-_pos.y * 0.5 + 0.5) * h;

      const el = document.createElement('div');
      el.className = 'music-note';
      el.textContent = MUSIC_NOTES[Math.floor(Math.random() * MUSIC_NOTES.length)];
      el.style.left = `${sx}px`;
      el.style.top  = `${sy}px`;
      this._notesContainer.appendChild(el);

      // Remove after animation ends (~1.8s)
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }
  }

  /** Returns the agent whose mesh was hit by a raycast, or null */
  hitTest(raycaster) {
    const allMeshes = this.meshes.map(m => m.body);
    const hits = raycaster.intersectObjects(allMeshes, false);
    if (hits.length === 0) return null;
    const hitBody = hits[0].object;
    const entry = this.meshes.find(m => m.body === hitBody);
    return entry ? entry.agent : null;
  }
}
