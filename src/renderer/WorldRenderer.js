import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TILE_SIZE, WORLD_WIDTH, WORLD_HEIGHT } from '../simulation/World.js';

const CENTER_X = (WORLD_WIDTH  * TILE_SIZE) / 2;
const CENTER_Z = (WORLD_HEIGHT * TILE_SIZE) / 2;
const WORLD_SPAN = Math.max(WORLD_WIDTH, WORLD_HEIGHT) * TILE_SIZE;

const SKY_COLOR = 0x5080a0;

export class WorldRenderer {
  constructor(canvas) {
    this.canvas = canvas;

    // ── Scene ──────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.FogExp2(SKY_COLOR, 0.006);

    // Sky colour lerp targets
    this._targetSky = new THREE.Color(SKY_COLOR);
    this._targetFog = 0.006;
    this._timeOfDay = 0.5; // 0=midnight, 0.5=noon
    this._weatherSunMult = 1;

    // ── Camera ─────────────────────────────────────────────────────────
    const w = canvas.clientWidth  || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
    this.camera.position.set(CENTER_X, 36, CENTER_Z + 28);
    this.camera.lookAt(CENTER_X, 0, CENTER_Z);

    // ── Renderer ───────────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    // ── Controls ───────────────────────────────────────────────────────
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(CENTER_X, 0, CENTER_Z);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 90;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.update();

    // ── Lighting ───────────────────────────────────────────────────────
    this._hemi = new THREE.HemisphereLight(0x9dcce8, 0x5a7040, 0.5);
    this.scene.add(this._hemi);

    const ambient = new THREE.AmbientLight(0xd8ecff, 0.5);
    this.scene.add(ambient);

    this.sun = new THREE.DirectionalLight(0xffe8b0, 2.0);
    this.sun.position.set(24, 45, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near   =  1;
    this.sun.shadow.camera.far    = 200;
    this.sun.shadow.camera.left   = -72;
    this.sun.shadow.camera.right  =  72;
    this.sun.shadow.camera.top    =  72;
    this.sun.shadow.camera.bottom = -72;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);

    const fill = new THREE.DirectionalLight(0x7ab8e8, 0.35);
    fill.position.set(-12, 15, -12);
    this.scene.add(fill);

    // ── Rain particles ─────────────────────────────────────────────────
    this._buildRain();

    // ── Rainbow ────────────────────────────────────────────────────────
    this._buildRainbow();

    // ── Sun disc ───────────────────────────────────────────────────────
    this._buildSunDisc();

    // ── Clouds ─────────────────────────────────────────────────────────
    this._buildClouds();

    // ── Aurora borealis ────────────────────────────────────────────────
    this._buildAurora();

    // ── Milky Way ──────────────────────────────────────────────────────
    this._buildMilkyWay();

    // ── Stars / shooting star ──────────────────────────────────────────
    this._buildStars();

    // ── Resize ─────────────────────────────────────────────────────────
    window.addEventListener('resize', () => this._handleResize());
  }

  _buildSunDisc() {
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff5aa, transparent: true, opacity: 1, fog: false });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.18, fog: false, depthWrite: false });
    const core = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), coreMat);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(3.8, 16, 12), glowMat);
    this._sunGroup = new THREE.Group();
    this._sunGroup.add(core, glow);
    this._sunGroup.visible = false;
    this.scene.add(this._sunGroup);
  }

  _buildAurora() {
    const COLORS  = [0x00ff77, 0x00ddbb, 0x44aaff, 0x9944ff, 0xff44bb, 0x00ff77, 0x22ddcc];
    this._auroraCurtains = [];
    const COUNT = 7;
    for (let i = 0; i < COUNT; i++) {
      const angle = (i / COUNT) * Math.PI * 2;
      const R = 68;
      const geom  = new THREE.PlaneGeometry(32, 24, 1, 12);
      // Store base X positions for wave animation
      geom.userData.baseX = Float32Array.from(
        geom.attributes.position.array.filter((_, idx) => idx % 3 === 0),
      );
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS[i], transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(CENTER_X + R * Math.cos(angle), 50, CENTER_Z + R * Math.sin(angle));
      mesh.lookAt(CENTER_X, 50, CENTER_Z);
      mesh.userData.phase = Math.random() * Math.PI * 2;
      mesh.userData.speed = 0.5 + Math.random() * 0.5;
      this.scene.add(mesh);
      this._auroraCurtains.push(mesh);
    }
    this._auroraState = { phase: 'hidden', opacity: 0, timer: 0, duration: 0 };
  }

  _buildClouds() {
    this._cloudMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this._cloudTargetOpacity = 0;
    this._cloudTargetColor   = new THREE.Color(0xffffff);
    this._cloudWindMult      = 1.0;

    this._cloudGroup = new THREE.Group();
    this._cloudList  = [];

    const COUNT  = 22;
    const SPREAD = 150;
    for (let i = 0; i < COUNT; i++) {
      const cloud = this._makeCloudMesh();
      cloud.position.set(
        CENTER_X + (Math.random() - 0.5) * SPREAD,
        24 + Math.random() * 14,
        CENTER_Z + (Math.random() - 0.5) * SPREAD,
      );
      const speed = 1.0 + Math.random() * 1.8;
      const angle = (Math.random() - 0.5) * 0.5; // mostly along +X with slight Z drift
      cloud.userData.baseVx = Math.cos(angle) * speed;
      cloud.userData.baseVz = Math.sin(angle) * speed;
      this._cloudGroup.add(cloud);
      this._cloudList.push(cloud);
    }
    this.scene.add(this._cloudGroup);
  }

  _makeCloudMesh() {
    const group  = new THREE.Group();
    const puffs  = 4 + Math.floor(Math.random() * 4);
    const scaleX = 0.8 + Math.random() * 0.8;
    const scaleZ = 0.6 + Math.random() * 0.6;
    for (let i = 0; i < puffs; i++) {
      const r    = 2.2 + Math.random() * 3.2;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), this._cloudMat);
      mesh.position.set(
        i === 0 ? 0 : (Math.random() - 0.5) * 11 * scaleX,
        (Math.random() - 0.5) * 2.5,
        (Math.random() - 0.5) * 6  * scaleZ,
      );
      group.add(mesh);
    }
    return group;
  }

  _buildRain() {
    const COUNT = 2000;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3]     = (Math.random() - 0.1) * WORLD_SPAN + CENTER_X;
      pos[i * 3 + 1] = Math.random() * 18;
      pos[i * 3 + 2] = (Math.random() - 0.1) * WORLD_SPAN + CENTER_Z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._rainMat = new THREE.PointsMaterial({
      color: 0xa8c8e0,
      size: 0.08,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this._rainParticles = new THREE.Points(geom, this._rainMat);
    this._rainParticles.visible = false;
    this.scene.add(this._rainParticles);
  }

  _buildRainbow() {
    // Seven concentric half-torus arcs (XY-plane semicircle) facing the camera.
    // Positioned behind the world so it sits on the far horizon.
    const COLORS  = [0xff2200, 0xff7700, 0xffee00, 0x22cc22, 0x1166ff, 0x4400bb, 0x8800dd];
    const RADII   = [43, 45, 47, 49, 51, 53, 55];
    const TUBE    = 1.25;
    this._rainbowMeshes = [];
    const group = new THREE.Group();
    group.position.set(CENTER_X, 0, CENTER_Z - 62);
    COLORS.forEach((col, idx) => {
      const geom = new THREE.TorusGeometry(RADII[idx], TUBE, 8, 72, Math.PI);
      const mat  = new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      // Torus sweeps in XY plane already — this gives us a vertical arch ✓
      group.add(mesh);
      this._rainbowMeshes.push(mat);
    });
    group.visible = false;
    this.scene.add(group);
    this._rainbowGroup = group;
    this._rainbowState = { phase: 'hidden', opacity: 0, timer: 0, duration: 0 };
  }

  _buildMilkyWay() {
    const COUNT = 3200;
    const R     = 175;
    const pos   = new Float32Array(COUNT * 3);

    // Band plane: pole tilted ~30° off vertical, angled diagonally across the sky
    const pole = new THREE.Vector3(0.45, 0.82, 0.36).normalize();
    const ref  = Math.abs(pole.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u    = new THREE.Vector3().crossVectors(pole, ref).normalize();
    const v    = new THREE.Vector3().crossVectors(pole, u).normalize();

    for (let i = 0; i < COUNT; i++) {
      const theta  = Math.random() * Math.PI * 2;
      // Two gaussians summed for a natural bell-curve spread across the band width
      const spread = (Math.random() + Math.random() + Math.random() - 1.5) * 0.28;
      const x = Math.cos(theta) * u.x + Math.sin(theta) * v.x + spread * pole.x;
      const y = Math.cos(theta) * u.y + Math.sin(theta) * v.y + spread * pole.y;
      const z = Math.cos(theta) * u.z + Math.sin(theta) * v.z + spread * pole.z;
      const len = Math.sqrt(x * x + y * y + z * z);
      pos[i * 3]     = CENTER_X + R * x / len;
      pos[i * 3 + 1] = R * y / len;
      pos[i * 3 + 2] = CENTER_Z + R * z / len;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._milkyWayMat = new THREE.PointsMaterial({
      color: 0xb8d0ff,
      size: 0.9,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      sizeAttenuation: false,
    });
    this._milkyWay = new THREE.Points(geom, this._milkyWayMat);
    this.scene.add(this._milkyWay);
  }

  _buildStars() {
    const COUNT = 420;
    const pos = new Float32Array(COUNT * 3);
    const R = 180;
    for (let i = 0; i < COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(1 - Math.random() * 2); // full sphere
      pos[i * 3]     = CENTER_X + R * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = R * Math.cos(phi);
      pos[i * 3 + 2] = CENTER_Z + R * Math.sin(phi) * Math.sin(theta);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._starMat = new THREE.PointsMaterial({
      color: 0xd8e8ff,
      size: 1.2,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      sizeAttenuation: false,
    });
    this._stars = new THREE.Points(geom, this._starMat);
    this.scene.add(this._stars);

    // Shooting star: animated line segment
    const ssGeom = new THREE.BufferGeometry();
    ssGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this._shootingStarMat = new THREE.LineBasicMaterial({
      color: 0xeef4ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this._shootingStarLine = new THREE.Line(ssGeom, this._shootingStarMat);
    this._shootingStarLine.visible = false;
    this.scene.add(this._shootingStarLine);

    this._ssActive   = false;
    this._ssProgress = 0;
    this._ssDuration = 1.0;
    this._ssNextAt   = performance.now() / 1000 + 12 + Math.random() * 20;
    this._ssOrigin   = new THREE.Vector3();
    this._ssVec      = new THREE.Vector3();
  }

  _spawnShootingStar() {
    const R     = 175;
    const theta = Math.random() * Math.PI * 2;
    const phi   = 0.2 + Math.random() * 0.55; // roughly 12–50° from zenith
    this._ssOrigin.set(
      CENTER_X + R * Math.sin(phi) * Math.cos(theta),
      R * Math.cos(phi),
      CENTER_Z + R * Math.sin(phi) * Math.sin(theta),
    );
    // Travel direction: move tangentially downward across the sky
    const dTheta = (Math.random() - 0.5) * 0.7;
    const dPhi   = 0.18 + Math.random() * 0.22;
    const ex = R * Math.sin(phi + dPhi) * Math.cos(theta + dTheta);
    const ey = R * Math.cos(phi + dPhi);
    const ez = R * Math.sin(phi + dPhi) * Math.sin(theta + dTheta);
    this._ssVec.set(
      ex - this._ssOrigin.x + CENTER_X,
      ey - this._ssOrigin.y,
      ez - this._ssOrigin.z + CENTER_Z,
    ).normalize().multiplyScalar(28 + Math.random() * 22);

    this._ssActive      = true;
    this._ssProgress    = 0;
    this._ssDuration    = 0.7 + Math.random() * 0.7;
    this._shootingStarLine.visible = true;
  }

  _updateShootingStar(_now, _dt, nightness) {
    if (!this._ssActive) {
      if (nightness > 0.85 && _now >= this._ssNextAt) this._spawnShootingStar();
      return;
    }

    this._ssProgress += _dt / this._ssDuration;
    if (this._ssProgress >= 1) {
      this._ssActive = false;
      this._shootingStarLine.visible = false;
      this._ssNextAt = _now + 5 + Math.random() * 10;
      return;
    }

    const p    = this._ssProgress;
    const fade = p < 0.15 ? p / 0.15 : p > 0.65 ? (1 - p) / 0.35 : 1;
    this._shootingStarMat.opacity = fade * 0.95;

    const tailP = Math.max(0, p - 0.18);
    const arr   = this._shootingStarLine.geometry.attributes.position.array;
    arr[0] = this._ssOrigin.x + this._ssVec.x * tailP;
    arr[1] = this._ssOrigin.y + this._ssVec.y * tailP;
    arr[2] = this._ssOrigin.z + this._ssVec.z * tailP;
    arr[3] = this._ssOrigin.x + this._ssVec.x * p;
    arr[4] = this._ssOrigin.y + this._ssVec.y * p;
    arr[5] = this._ssOrigin.z + this._ssVec.z * p;
    this._shootingStarLine.geometry.attributes.position.needsUpdate = true;
  }

  /** Trigger a rainbow with a given probability (0–1). Call after rain ends. */
  triggerRainbow(chance = 0.65) {
    if (Math.random() > chance) return;
    const s = this._rainbowState;
    s.phase    = 'fadein';
    s.opacity  = 0;
    s.timer    = 0;
    s.duration = 40 + Math.random() * 35; // visible for 40–75 real seconds
    this._rainbowGroup.visible = true;
  }

  _updateRainbow(realDelta) {
    const s = this._rainbowState;
    if (s.phase === 'hidden') return;

    if (s.phase === 'fadein') {
      s.opacity = Math.min(1, s.opacity + realDelta / 4);
      if (s.opacity >= 1) s.phase = 'visible';
    } else if (s.phase === 'visible') {
      s.timer += realDelta;
      if (s.timer >= s.duration) s.phase = 'fadeout';
    } else if (s.phase === 'fadeout') {
      s.opacity = Math.max(0, s.opacity - realDelta / 7);
      if (s.opacity <= 0) {
        s.phase = 'hidden';
        this._rainbowGroup.visible = false;
      }
    }
    // Each band peaks at slightly different opacity for a natural look
    this._rainbowMeshes.forEach((mat, i) => {
      const bandMult = 0.55 + 0.45 * Math.sin((i / 6) * Math.PI); // middle bands brighter
      mat.opacity = s.opacity * 0.72 * bandMult;
    });
  }

  /** Called each visual frame with real (wall-clock) delta */
  updateRain(realDelta, isRaining, isStorm) {
    this._updateRainbow(realDelta);
    if (!isRaining) {
      this._rainParticles.visible = false;
      return;
    }
    this._rainParticles.visible = true;
    this._rainMat.opacity = isStorm ? 0.75 : 0.50;
    this._rainMat.size    = isStorm ? 0.10 : 0.07;

    const pos   = this._rainParticles.geometry.attributes.position.array;
    const speed = isStorm ? 22 : 12;
    const windX = isStorm ?  3 :  0.5;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i]     += windX * realDelta;
      pos[i + 1] -= speed * realDelta;
      if (pos[i + 1] < 0) {
        pos[i]     = (Math.random() - 0.1) * WORLD_SPAN + CENTER_X;
        pos[i + 1] = 14 + Math.random() * 6;
        pos[i + 2] = (Math.random() - 0.1) * WORLD_SPAN + CENTER_Z;
      }
    }
    this._rainParticles.geometry.attributes.position.needsUpdate = true;
  }

  /** Update lighting/sky for day–night cycle. t: 0=midnight, 0.25=dawn, 0.5=noon, 0.75=dusk */
  setTimeOfDay(t) {
    this._timeOfDay = t;
  }

  /** Smoothly transition sky/fog to match new weather */
  setWeather(meta) {
    this._targetSky.setHex(meta.sky);
    this._targetFog = meta.fog;
    this._weatherSunMult = meta.energyMult > 1.2 ? 0.6 : 1.0;
    this._cloudTargetOpacity = meta.cloudOpacity ?? 0;
    this._cloudTargetColor.setHex(meta.cloudColor ?? 0xffffff);
    this._cloudWindMult = meta.cloudWind ?? 1.0;
  }

  /** Add a persistent fire (light + visible mesh). Call removeFireLight when fire ends. */
  addFireLight(x, z) {
    const key = `${x},${z}`;
    if (this._fireLights?.has(key)) return;
    const wx = x * 2 + 1; // tile center in world units (TILE_SIZE=2)
    const wz = z * 2 + 1;

    // Point light
    const light = new THREE.PointLight(0xff6600, 1.8, 14);
    light.position.set(wx, 1.2, wz);
    this.scene.add(light);

    // Visible fire: cluster of orange/yellow cones
    const fireGroup = new THREE.Group();
    const flameData = [
      { ox: 0,     oz: 0,    h: 0.55, color: 0xff4400 },
      { ox:  0.08, oz: 0.05, h: 0.38, color: 0xff8800 },
      { ox: -0.06, oz: 0.08, h: 0.42, color: 0xffaa00 },
      { ox:  0.03, oz:-0.07, h: 0.32, color: 0xffee44 },
    ];
    for (const f of flameData) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.10, f.h, 5),
        new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0.88 }),
      );
      cone.position.set(wx + f.ox, 0.20 + f.h / 2, wz + f.oz);
      cone.userData.baseH = f.h;
      cone.userData.phase = Math.random() * Math.PI * 2;
      fireGroup.add(cone);
    }
    this.scene.add(fireGroup);
    (this._fireLights ??= new Map()).set(key, { light, fireGroup });
  }

  removeFireLight(x, z) {
    const key = `${x},${z}`;
    const entry = this._fireLights?.get(key);
    if (entry) {
      this.scene.remove(entry.light);
      this.scene.remove(entry.fireGroup);
      entry.fireGroup.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); });
      this._fireLights.delete(key);
    }
  }

  /** Add a temporary point light for discovery effects.
   *  Lights are tracked in _flashLights and faded in render() — no separate rAF loops. */
  addFlash(x, z, color = 0xff8800) {
    // Cap concurrent flashes to prevent memory/perf issues at high speed
    if ((this._flashLights?.length ?? 0) >= 24) return;
    const light = new THREE.PointLight(color, 4, 8);
    light.position.set(x, 1.5, z);
    this.scene.add(light);
    (this._flashLights ??= []).push({ light, t: 0 });
  }

  render() {
    this.controls.update();

    // Compute render-frame delta (used for flash light decay)
    const _now = performance.now() / 1000;
    const _dt  = Math.min(0.1, _now - (this._lastRenderT ?? _now));
    this._lastRenderT = _now;

    // Decay and remove expired flash lights
    if (this._flashLights?.length) {
      this._flashLights = this._flashLights.filter(fl => {
        fl.t += _dt;
        fl.light.intensity = Math.max(0, 4 - fl.t * 2.5);
        if (fl.light.intensity <= 0) { this.scene.remove(fl.light); return false; }
        return true;
      });
    }

    // Animate persistent fire meshes (flicker)
    if (this._fireLights?.size) {
      for (const { light, fireGroup } of this._fireLights.values()) {
        const flicker = 0.85 + Math.sin(_now * 7.3) * 0.15 + Math.sin(_now * 11.7 + 1.1) * 0.07;
        light.intensity = 1.8 * flicker;
        for (const cone of fireGroup.children) {
          const ph = cone.userData.phase ?? 0;
          const sc = 0.85 + Math.sin(_now * 6 + ph) * 0.15;
          cone.scale.set(sc, 0.9 + Math.sin(_now * 8.4 + ph + 0.5) * 0.1, sc);
        }
      }
    }

    // Day–night cycle: sun orbit and sky tint
    const t = this._timeOfDay;
    const arc  = (t - 0.25) * Math.PI * 2; // 0=dawn, π/2=noon, π=dusk
    const R = 28;
    const sunX = CENTER_X + R * Math.cos(arc); // rises west (+X), sets east (-X)
    const sunY = R * Math.sin(arc);
    const sunZ = CENTER_Z;
    this.sun.position.set(sunX, sunY, sunZ);
    const baseIntensity = sunY > 0 ? Math.min(2, 0.3 + sunY / 40) : 0.02;
    this.sun.intensity = baseIntensity * (this._weatherSunMult ?? 1);
    this.sun.color.setHSL(0.12 - t * 0.04, 0.3, 0.92);

    // Sky: blend day/night based on sun elevation
    const daySky = new THREE.Color(this._targetSky);
    const nightSky = new THREE.Color(0x0c0c24);
    const dayness = Math.max(0, Math.min(1, sunY / 30 + 0.5));
    this.scene.background.copy(nightSky).lerp(daySky, dayness);
    this.scene.fog.color.copy(this.scene.background);
    this.scene.fog.density += (this._targetFog - this.scene.fog.density) * 0.02;

    this._hemi.intensity = 0.3 + dayness * 0.4;
    this._hemi.color.copy(nightSky).lerp(new THREE.Color(0x9dcce8), dayness);
    this._hemi.groundColor.copy(new THREE.Color(0x0a0a18)).lerp(new THREE.Color(0x5a7040), dayness);

    // Stars: fade in as night falls, gentle collective twinkle
    const nightness = 1 - dayness;
    const starBase  = nightness > 0.3 ? Math.min(1, (nightness - 0.3) / 0.35) : 0;
    if (starBase > 0) {
      const twinkle = 0.88 + 0.12 * Math.sin(_now * 1.9) * Math.cos(_now * 2.7 + 0.5);
      this._starMat.opacity = starBase * twinkle;
    } else {
      this._starMat.opacity = 0;
    }

    // Milky Way: fades in on clear dark nights, hidden behind clouds
    const mwBase  = nightness > 0.55 ? Math.min(1, (nightness - 0.55) / 0.35) : 0;
    const mwCloud = Math.max(0, 1 - this._cloudMat.opacity * 2);
    this._milkyWayMat.opacity = mwBase * mwCloud * 0.45;

    // Shooting star
    this._updateShootingStar(_now, _dt, nightness);

    // Sun disc: follow DirectionalLight position, fade at horizon
    const sunVis = Math.max(0, Math.min(1, sunY / 8));
    this._sunGroup.visible = sunVis > 0.01;
    if (this._sunGroup.visible) {
      this._sunGroup.position.set(sunX, sunY, sunZ);
      this._sunGroup.children[0].material.opacity = sunVis;
      this._sunGroup.children[1].material.opacity = 0.18 * sunVis;
    }

    // Northern lights (aurora borealis)
    const aurora = this._auroraState;
    if (nightness > 0.75 && aurora.phase === 'hidden' && Math.random() < _dt / 45) {
      aurora.phase    = 'fadein';
      aurora.opacity  = 0;
      aurora.timer    = 0;
      aurora.duration = 20 + Math.random() * 50;
    }
    if (aurora.phase !== 'hidden') {
      aurora.timer += _dt;
      if (aurora.phase === 'fadein') {
        aurora.opacity = Math.min(0.52, aurora.opacity + _dt / 6);
        if (aurora.opacity >= 0.52) aurora.phase = 'visible';
      } else if (aurora.phase === 'visible') {
        if (aurora.timer >= aurora.duration || nightness < 0.5) aurora.phase = 'fadeout';
      } else if (aurora.phase === 'fadeout') {
        aurora.opacity = Math.max(0, aurora.opacity - _dt / 8);
        if (aurora.opacity <= 0) aurora.phase = 'hidden';
      }
      // Cloud cover dims the aurora
      const auroraVis = aurora.opacity * (1 - this._cloudMat.opacity * 0.7);
      for (const curtain of this._auroraCurtains) {
        curtain.material.opacity = auroraVis;
        // Ripple wave along the curtain height
        const baseX = curtain.geometry.userData.baseX;
        const pos   = curtain.geometry.attributes.position.array;
        let bxi = 0;
        for (let vi = 0; vi < pos.length / 3; vi++) {
          const localY = pos[vi * 3 + 1];
          pos[vi * 3] = baseX[bxi++] + Math.sin(_now * curtain.userData.speed + localY * 0.22 + curtain.userData.phase) * 3.5;
        }
        curtain.geometry.attributes.position.needsUpdate = true;
      }
    } else {
      for (const curtain of this._auroraCurtains) curtain.material.opacity = 0;
    }

    // Clouds: drift across sky, lerp opacity/colour toward weather targets
    const HALF_SPREAD = 80;
    const lerpRate    = Math.min(1, _dt * 0.4);
    this._cloudMat.opacity = this._cloudMat.opacity + (this._cloudTargetOpacity - this._cloudMat.opacity) * lerpRate;
    this._cloudMat.color.lerp(this._cloudTargetColor, lerpRate);
    for (const cloud of this._cloudList) {
      cloud.position.x += cloud.userData.baseVx * this._cloudWindMult * _dt;
      cloud.position.z += cloud.userData.baseVz * this._cloudWindMult * _dt;
      if (cloud.position.x > CENTER_X + HALF_SPREAD) cloud.position.x -= HALF_SPREAD * 2;
      if (cloud.position.x < CENTER_X - HALF_SPREAD) cloud.position.x += HALF_SPREAD * 2;
      if (cloud.position.z > CENTER_Z + HALF_SPREAD) cloud.position.z -= HALF_SPREAD * 2;
      if (cloud.position.z < CENTER_Z - HALF_SPREAD) cloud.position.z += HALF_SPREAD * 2;
    }

    this.renderer.render(this.scene, this.camera);
  }

  _handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  getNDC(event) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width)  *  2 - 1,
      ((event.clientY - rect.top)  / rect.height) * -2 + 1,
    );
  }
}
