import * as THREE from 'three';
import { World, TILE_SIZE, TileType } from './simulation/World.js';
import { Agent }             from './simulation/Agent.js';
import { ConceptGraph }      from './simulation/ConceptGraph.js';
import { WorldRenderer }     from './renderer/WorldRenderer.js';
import { TerrainRenderer }   from './renderer/TerrainRenderer.js';
import { AgentRenderer }     from './renderer/AgentRenderer.js';
import { BuildingRenderer }  from './renderer/BuildingRenderer.js';
import { WildHorse }         from './simulation/WildHorse.js';
import { WildHorseRenderer } from './renderer/WildHorseRenderer.js';
import { ButterflyRenderer } from './renderer/ButterflyRenderer.js';
import { BeeRenderer }       from './renderer/BeeRenderer.js';
import { SheepRenderer }        from './renderer/SheepRenderer.js';
import { HighlandCowRenderer }  from './renderer/HighlandCowRenderer.js';
import { FlowerRenderer }       from './renderer/FlowerRenderer.js';
import { TimeSystem }        from './systems/TimeSystem.js';
import { WeatherSystem }     from './systems/WeatherSystem.js';

const AGENT_COUNT = 12;
const WILD_HORSE_COUNT = 4;

// ── Error handling ──────────────────────────────────────────────────────────

function showError(msg, err) {
  try {
    const banner = document.getElementById('error-banner');
    const el = document.getElementById('error-message');
    if (banner && el) {
      el.textContent = typeof msg === 'string' ? msg : String(msg);
      banner.classList.remove('hidden');
    }
    console.error('[World]', msg, err ?? '');
  } catch (e) {
    console.error('[World] showError failed', e);
  }
}

function hideError() {
  const banner = document.getElementById('error-banner');
  if (banner) banner.classList.add('hidden');
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  let conceptsData;
  try {
    const res = await fetch('./data/concepts.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    conceptsData = await res.json();
    if (!Array.isArray(conceptsData)) throw new Error('concepts.json must be an array');
  } catch (e) {
    showError('Could not load concepts.json – run via a local server', e);
    const loadingText = document.getElementById('loading-text');
    if (loadingText) loadingText.textContent = 'Error: run via python -m http.server 8080';
    return;
  }

  const canvas = document.getElementById('world-canvas');
  if (!canvas) {
    showError('Canvas element not found');
    return;
  }

  let world; let conceptGraph; let terrainRenderer; let ar; let buildingRenderer; let time; let weather;
  let horses = [];
  let horseRenderer;
  let butterflyRenderer;
  let beeRenderer;
  let sheepRenderer;
  let highlandCowRenderer;
  let flowerRenderer;
  try {
  world = new World();
  world.naturalFires = new Map();
  let lightningCooldown = 0;
  let glacierNotifyState = 'frozen'; // 'frozen' | 'melting' | 'melted'
  conceptGraph = new ConceptGraph(conceptsData);
  const agents = world.getSpawnPoints(AGENT_COUNT).map(p => new Agent(p.x, p.z));

  const wr = new WorldRenderer(canvas);
  terrainRenderer = new TerrainRenderer(wr.scene, world);
  ar = new AgentRenderer(wr.scene, agents, world);
  horses = world.getWildHorseSpawnPoints(WILD_HORSE_COUNT).map(p => new WildHorse(p.x, p.z));
  horseRenderer = new WildHorseRenderer(wr.scene, horses, world);
  butterflyRenderer = new ButterflyRenderer(wr.scene, world);
  beeRenderer = new BeeRenderer(wr.scene, world);
  sheepRenderer = new SheepRenderer(wr.scene, world);
  highlandCowRenderer = new HighlandCowRenderer(wr.scene, world);
  flowerRenderer = new FlowerRenderer(wr.scene, world);
  buildingRenderer = new BuildingRenderer(wr.scene, world);

  time = new TimeSystem();
  weather = new WeatherSystem();

  // ── Fade out loading screen ───────────────────────────────────────────
  const loading = document.getElementById('loading');
  loading.classList.add('fade-out');
  loading.addEventListener('transitionend', () => loading.remove(), { once: true });

  // ── Speed controls ─────────────────────────────────────────────────────
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = Number(btn.dataset.speed);
      time.setSpeed(speed);
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ── Info panel ─────────────────────────────────────────────────────────
  let selectedAgent = null;
  let selectedTile  = null;
  let gameOver = false;
  let gameOverAutoResetId = null;

  document.getElementById('info-close').addEventListener('click', () => {
    if (selectedAgent) selectedAgent.selected = false;
    selectedAgent = null;
    selectedTile  = null;
    document.getElementById('info-panel').classList.add('hidden');
  });

  // ── Stats (persisted to localStorage) ────────────────────────────────────
  const STATS_KEY = 'world-game-stats';
  const stats = (() => {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      if (raw) return { ...{ gameOvers: 0, worldsPlayed: 0, totalBirths: 0, longestSurvival: 0, peakPopulation: 0, bestDiscoveries: 0 }, ...JSON.parse(raw) };
    } catch (_) {}
    return { gameOvers: 0, worldsPlayed: 0, totalBirths: 0, longestSurvival: 0, peakPopulation: 0, bestDiscoveries: 0 };
  })();
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (_) {}
  }
  function updateStatsDisplay() {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('stat-game-overs', stats.gameOvers);
    set('stat-worlds', stats.worldsPlayed);
    set('stat-births', stats.totalBirths);
    set('stat-days', stats.longestSurvival > 0 ? `Day ${stats.longestSurvival}` : '—');
    set('stat-peak', stats.peakPopulation);
    set('stat-discoveries', stats.bestDiscoveries);
  }

  // ── Hamburger / settings ───────────────────────────────────────────────
  const hamburgerBtn  = document.getElementById('hamburger-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const popSlider     = document.getElementById('pop-slider');
  const popValue      = document.getElementById('pop-value');
  const maxPopSlider  = document.getElementById('max-pop-slider');
  const maxPopValue   = document.getElementById('max-pop-value');

  popSlider.addEventListener('input', () => {
    popValue.textContent = popSlider.value;
  });
  maxPopSlider.addEventListener('input', () => {
    maxPopValue.textContent = maxPopSlider.value;
  });

  hamburgerBtn.addEventListener('click', () => {
    const isOpen = !settingsPanel.classList.contains('hidden');
    settingsPanel.classList.toggle('hidden', isOpen);
    hamburgerBtn.classList.toggle('open', !isOpen);
    if (!isOpen) updateStatsDisplay();
  });

  // Close settings if user clicks outside it
  document.addEventListener('click', e => {
    if (!settingsPanel.contains(e.target) && e.target !== hamburgerBtn) {
      settingsPanel.classList.add('hidden');
      hamburgerBtn.classList.remove('open');
    }
  });

  function resetWorld() {
    try {
    terrainRenderer.dispose();
    ar.dispose();
    horseRenderer.dispose();
    butterflyRenderer.dispose();
    beeRenderer.dispose();
    sheepRenderer.dispose();
    highlandCowRenderer.dispose();
    flowerRenderer.dispose();
    buildingRenderer.dispose();

    world = new World();
    world.naturalFires = new Map();
    lightningCooldown = 0;
    conceptGraph = new ConceptGraph(conceptsData);
    agents.length = 0;
    const startPop = Number(popSlider.value);
    world.getSpawnPoints(startPop).forEach(p => agents.push(new Agent(p.x, p.z)));

    terrainRenderer = new TerrainRenderer(wr.scene, world);
    ar = new AgentRenderer(wr.scene, agents, world);
    horses.length = 0;
    world.getWildHorseSpawnPoints(WILD_HORSE_COUNT).forEach(p => horses.push(new WildHorse(p.x, p.z)));
    horseRenderer = new WildHorseRenderer(wr.scene, horses, world);
    butterflyRenderer = new ButterflyRenderer(wr.scene, world);
    beeRenderer = new BeeRenderer(wr.scene, world);
    sheepRenderer = new SheepRenderer(wr.scene, world);
    highlandCowRenderer = new HighlandCowRenderer(wr.scene, world);
    flowerRenderer = new FlowerRenderer(wr.scene, world);
    buildingRenderer = new BuildingRenderer(wr.scene, world);

    time.gameTime = (8 / 24) * 120; // reset to 08:00
    birthGameTimes.length = 0;
    weather.current = 'CLEAR';
    weather._timer  = 0;
    glacierNotifyState = 'frozen';
    gameOver = false;
    if (gameOverAutoResetId) {
      clearTimeout(gameOverAutoResetId);
      gameOverAutoResetId = null;
    }
    if (selectedAgent) selectedAgent.selected = false;
    selectedAgent = null;
    selectedTile  = null;
    document.getElementById('info-panel').classList.add('hidden');
    document.getElementById('game-over').classList.add('hidden');
    settingsPanel.classList.add('hidden');
    hamburgerBtn.classList.remove('open');

    stats.worldsPlayed++;
    saveStats();

    showNotification('A new world begins...', 'env');
    } catch (e) {
      showError('Reset failed', e);
    }
  }

  document.getElementById('reset-btn').addEventListener('click', resetWorld);
  document.getElementById('game-over-reset').addEventListener('click', resetWorld);

  const errDismiss = document.getElementById('error-dismiss');
  if (errDismiss) errDismiss.addEventListener('click', hideError);

  window.onerror = (msg, source, line, col, err) => {
    showError(msg || 'An unexpected error occurred', err);
    return true;
  };
  window.onunhandledrejection = (e) => {
    showError(e.reason?.message || 'Promise rejected', e.reason);
  };

  // ── Click detection ────────────────────────────────────────────────────
  // We raycast to the ground plane (y=0) to get a world position, then
  // find the nearest live agent within a generous pick radius. This is far
  // more reliable than trying to intersect tiny capsule meshes.
  const raycaster   = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const groundPoint = new THREE.Vector3();
  const PICK_RADIUS = TILE_SIZE * 1.5; // 3 world-units ≈ 1.5 tiles
  let mouseDownAt   = null;
  let draggedEntity = null; // agent or horse being held by the player

  canvas.addEventListener('mousedown', e => {
    mouseDownAt = { x: e.clientX, y: e.clientY };

    // Check if the player is clicking near an agent or horse to pick up
    const ndc = wr.getNDC(e);
    raycaster.setFromCamera(ndc, wr.camera);
    if (raycaster.ray.intersectPlane(groundPlane, groundPoint)) {
      let hit = null;
      let bestDist = PICK_RADIUS;
      for (const agent of agents) {
        if (agent.health <= 0) continue;
        const dist = Math.hypot(groundPoint.x - agent.x * TILE_SIZE, groundPoint.z - agent.z * TILE_SIZE);
        if (dist < bestDist) { bestDist = dist; hit = agent; }
      }
      for (const horse of horses) {
        const dist = Math.hypot(groundPoint.x - horse.x * TILE_SIZE, groundPoint.z - horse.z * TILE_SIZE);
        if (dist < bestDist) { bestDist = dist; hit = horse; }
      }
      if (hit) {
        draggedEntity = hit;
        hit.isDragged = true;
        wr.controls.enabled = false;
      }
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!draggedEntity) return;
    const ndc = wr.getNDC(e);
    raycaster.setFromCamera(ndc, wr.camera);
    if (raycaster.ray.intersectPlane(groundPlane, groundPoint)) {
      draggedEntity.x = groundPoint.x / TILE_SIZE;
      draggedEntity.z = groundPoint.z / TILE_SIZE;
      draggedEntity.targetX = draggedEntity.x;
      draggedEntity.targetZ = draggedEntity.z;
    }
  });

  canvas.addEventListener('mouseup', e => {
    // Release any dragged entity
    if (draggedEntity) {
      const ddx = mouseDownAt ? e.clientX - mouseDownAt.x : 999;
      const ddy = mouseDownAt ? e.clientY - mouseDownAt.y : 999;
      const wasDrag = Math.hypot(ddx, ddy) > 5;

      draggedEntity.isDragged = false;
      draggedEntity.targetX = draggedEntity.x;
      draggedEntity.targetZ = draggedEntity.z;
      const released = draggedEntity;
      draggedEntity = null;
      wr.controls.enabled = true;
      mouseDownAt = null;

      // If the mouse barely moved it was a click, not a drag — select the agent
      if (!wasDrag && released instanceof Agent) {
        if (selectedAgent) selectedAgent.selected = false;
        selectedAgent = released;
        selectedTile = null;
        released.selected = true;
        updateInfoPanel(released);
        document.getElementById('info-panel').classList.remove('hidden');
      }
      return;
    }

    if (!mouseDownAt) return;
    const dx = e.clientX - mouseDownAt.x;
    const dy = e.clientY - mouseDownAt.y;
    mouseDownAt = null;
    if (Math.hypot(dx, dy) > 5) return; // was a drag

    const ndc = wr.getNDC(e);
    raycaster.setFromCamera(ndc, wr.camera);
    if (!raycaster.ray.intersectPlane(groundPlane, groundPoint)) return;

    // Find nearest live agent to the click position
    let hit = null;
    let bestDist = PICK_RADIUS;
    for (const agent of agents) {
      if (agent.health <= 0) continue;
      const wx = agent.x * TILE_SIZE;
      const wz = agent.z * TILE_SIZE;
      const dist = Math.hypot(groundPoint.x - wx, groundPoint.z - wz);
      if (dist < bestDist) { bestDist = dist; hit = agent; }
    }

    if (hit) {
      if (selectedAgent) selectedAgent.selected = false;
      selectedAgent = hit;
      selectedTile  = null;
      hit.selected = true;
      updateInfoPanel(hit);
      document.getElementById('info-panel').classList.remove('hidden');
    } else {
      if (selectedAgent) selectedAgent.selected = false;
      selectedAgent = null;
      selectedTile  = null;

      // Check for nearby animal before falling back to tile
      const animal = terrainRenderer.hitTestAnimals(groundPoint.x, groundPoint.z);
      if (animal) {
        document.getElementById('info-content').innerHTML = `
          <div class="info-name">${animal.icon} ${animal.label}</div>
          <div class="info-state" style="opacity:.7;font-size:12px">Wildlife</div>
          <div style="margin-top:10px;font-size:12px;opacity:.85">${animal.description}</div>
        `;
        document.getElementById('info-panel').classList.remove('hidden');
      } else {
        // Check for tile click
        const tx = Math.floor(groundPoint.x / TILE_SIZE);
        const tz = Math.floor(groundPoint.z / TILE_SIZE);
        const tile = world.getTile(tx, tz);
        if (tile) {
          selectedTile = tile;
          updateTileInfoPanel(tile);
          document.getElementById('info-panel').classList.remove('hidden');
        } else {
          document.getElementById('info-panel').classList.add('hidden');
        }
      }
    }
  });

  // ── HUD update (throttled) ─────────────────────────────────────────────
  let lastHudUpdate = 0;
  const birthGameTimes = []; // gameTime when each birth occurred

  function updateHUD() {
    try {
    const now = performance.now();
    if (now - lastHudUpdate < 500) return;
    lastHudUpdate = now;

    const aliveAgents = agents.filter(a => a?.health > 0);
    const alive = aliveAgents.length;
    const aliveIds = new Set(aliveAgents.map(a => a.id));
    const hasAgriculture = aliveAgents.some(a => a.knowledge.has('agriculture'));
    const maxPop = Number(maxPopSlider?.value ?? 100);
    const carryingCapacity = Math.min(maxPop, Math.floor(world.getCarryingCapacity() * (hasAgriculture ? 1.25 : 1)));
    document.getElementById('population').textContent = `${alive} / ${carryingCapacity}`;
    const femaleCount = aliveAgents.filter(a => a.gender === 'female').length;
    const maleCount = alive - femaleCount;
    document.getElementById('pop-female').textContent = `♀ ${femaleCount}`;
    document.getElementById('pop-male').textContent = `♂ ${maleCount}`;

    // Replenishment rate: average births per game day (rolling 5-day window)
    const REPLENISH_WINDOW_DAYS = 5;
    const windowStart = time.gameTime - REPLENISH_WINDOW_DAYS * time.dayLength;
    const recent = birthGameTimes.filter(t => t > windowStart);
    const birthsInWindow = recent.length;
    if (birthGameTimes.length > 200) {
      birthGameTimes.length = 0;
      birthGameTimes.push(...recent);
    }
    const elapsedDays = time.gameTime / time.dayLength;
    const windowDays  = Math.min(REPLENISH_WINDOW_DAYS, Math.max(1, elapsedDays));
    const replenishRate = elapsedDays >= 1
      ? (birthsInWindow / windowDays).toFixed(2)
      : '—';
    document.getElementById('replenishment').textContent = `${replenishRate}/day`;
    const timeLabels = [[0, '🌙'], [0.2, '🌅'], [0.45, '☀️'], [0.7, '🌆'], [0.9, '🌙']];
    const tod = time.timeOfDay;
    const timeIcon = [...timeLabels].filter(([t]) => tod >= t).pop()?.[1] ?? '☀️';
    const todHours = tod * 24;
    const hh = Math.floor(todHours).toString().padStart(2, '0');
    const mm = Math.floor((todHours % 1) * 60).toString().padStart(2, '0');

    document.getElementById('world-day').textContent     = `Day ${time.day}`;
    document.getElementById('world-season').textContent  = time.season;
    document.getElementById('world-time').textContent    = `${timeIcon} ${hh}:${mm}`;
    document.getElementById('world-weather').textContent = weather.label;
    document.getElementById('world-temp').textContent    = weather.tempLabel;

    // ── Game over detection ───────────────────────────────────────────
    if (!gameOver && agents.length > 0 && alive === 0) {
      gameOver = true;
      const discovered = conceptGraph.getDiscoveredConcepts(); // no filter: count all ever discovered
      document.getElementById('game-over-stats').innerHTML =
        `<div>Lasted <strong>Day ${time.day}</strong> — ${time.season}</div>` +
        `<div>Peak population <strong>${agents.length}</strong></div>` +
        `<div>Discoveries <strong>${discovered.length}</strong></div>`;
      document.getElementById('game-over').classList.remove('hidden');
      gameOverAutoResetId = setTimeout(resetWorld, 30000);

      stats.gameOvers++;
      stats.totalBirths += birthGameTimes.length;
      stats.longestSurvival = Math.max(stats.longestSurvival, time.day);
      stats.peakPopulation = Math.max(stats.peakPopulation, agents.length);
      stats.bestDiscoveries = Math.max(stats.bestDiscoveries, discovered.length);
      saveStats();
    }

    const discovered = conceptGraph.getDiscoveredConcepts(aliveIds);
    const list = document.getElementById('concepts-list');
    if (discovered.length === 0) {
      list.innerHTML = '<em>None yet...</em>';
    } else {
      list.innerHTML = discovered.map(c =>
        `<div class="concept-item">
          <span class="concept-dot"></span>
          <span>${c.icon ?? ''} ${c.name}</span>
          <span class="concept-spread">${c.knownCount}/${alive}</span>
        </div>`
      ).join('');
    }

    if (selectedAgent && selectedAgent.health > 0) {
      updateInfoPanel(selectedAgent);
    } else if (selectedTile && world.getTile(selectedTile.x, selectedTile.z)) {
      updateTileInfoPanel(world.getTile(selectedTile.x, selectedTile.z));
    }
    } catch (e) {
      console.error('[World] HUD update failed', e);
    }
  }

  const TILE_LABELS = {
    [TileType.DEEP_WATER]: { icon: '🌊', name: 'Deep Water' },
    [TileType.WATER]:    { icon: '🌊', name: 'Water' },
    [TileType.GRASS]:    { icon: '🌿', name: 'Grassland' },
    [TileType.WOODLAND]: { icon: '🌳', name: 'Woodland' },
    [TileType.FOREST]:   { icon: '🌲', name: 'Forest' },
    [TileType.STONE]:    { icon: '🪨', name: 'Stone' },
    [TileType.MOUNTAIN]: { icon: '⛰️', name: 'Mountain' },
  };

  const TILE_FEATURES = {
    [TileType.DEEP_WATER]: 'Open ocean. Deep fish patrol these waters. Requires Sailing to cross.',
    [TileType.WATER]:    'Coastal water. Shallow fish swim here. Requires Sailing to cross.',
    [TileType.GRASS]:    'Berries, sheep, and pigs. Good for gathering food.',
    [TileType.WOODLAND]: 'Open woodland with scattered trees and herbs. Good for gathering and hunting.',
    [TileType.FOREST]:   'Trees, wild game, mushrooms, and healing herbs. Rich in food and natural resources.',
    [TileType.STONE]:    'Rocks and flint shards. Good for stone tools and pottery.',
    [TileType.MOUNTAIN]: 'Peaks and snow. Requires Mountain Climbing to traverse.',
  };

  function updateTileInfoPanel(tile) {
    if (!tile) return;
    const info = TILE_LABELS[tile.type] ?? { icon: '', name: tile?.type ?? '?' };
    const features = TILE_FEATURES[tile.type] ?? '';
    let resourceHtml = '';
    if (tile.type === TileType.GRASS || tile.type === TileType.WOODLAND || tile.type === TileType.FOREST) {
      const pct = Math.round(tile.resource * 100);
      resourceHtml = `
        <div class="info-row" style="margin-top:10px">
          <span class="info-label">Food</span>
          <div class="info-bar-wrap"><div class="info-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }
    if (tile.herbs !== undefined) {
      const pct = Math.round(tile.herbs * 100);
      resourceHtml += `
        <div class="info-row">
          <span class="info-label">🌿 Herbs</span>
          <div class="info-bar-wrap"><div class="info-bar-fill" style="width:${pct}%;background:#d97ef5"></div></div>
        </div>`;
    }
    if (tile.mushrooms !== undefined) {
      const pct = Math.round(tile.mushrooms * 100);
      resourceHtml += `
        <div class="info-row">
          <span class="info-label">🍄 Mushrooms</span>
          <div class="info-bar-wrap"><div class="info-bar-fill" style="width:${pct}%;background:#c8860a"></div></div>
        </div>`;
    }
    if (tile.flint !== undefined) {
      resourceHtml += `
        <div class="info-row">
          <span class="info-label">🪨 Flint</span>
          <span style="font-size:11px;opacity:.8">${tile.flint === 1 ? 'Present' : 'Gathered'}</span>
        </div>`;
    }
    document.getElementById('info-content').innerHTML = `
      <div class="info-name">${info.icon} ${info.name}</div>
      <div class="info-state" style="opacity:.7;font-size:12px">Tile (${tile.x}, ${tile.z})</div>
      <div style="margin-top:10px;font-size:12px;opacity:.85">${features}</div>
      ${resourceHtml}
    `;
  }

  const ITEM_DISPLAY = {
    herbs:     { icon: '🌿', label: 'Herbs',     color: '#86efac' },
    mushrooms: { icon: '🍄', label: 'Mushrooms', color: '#c8860a' },
    berries:   { icon: '🫐', label: 'Berries',   color: '#818cf8' },
    meat:      { icon: '🍖', label: 'Meat',      color: '#f87171' },
    eggs:      { icon: '🥚', label: 'Eggs',      color: '#f5f0e0' },
    milk:      { icon: '🥛', label: 'Milk',      color: '#f0f0f8' },
    flint:     { icon: '🪨', label: 'Flint',     color: '#94a3b8' },
    wood:      { icon: '🪵', label: 'Wood',      color: '#a16207' },
  };

  function updateInfoPanel(agent) {
    if (!agent) return;
    const hunger   = agent.needs?.hunger   ?? 0;
    const energy   = agent.needs?.energy   ?? 0;
    const vitality = agent.needs?.vitality ?? 1;
    const hCol = hunger   < 0.3 ? 'crit' : hunger   < 0.6 ? 'warn' : '';
    const eCol = energy   < 0.3 ? 'crit' : energy   < 0.6 ? 'warn' : '';
    const vCol = vitality < 0.3 ? 'crit' : vitality < 0.6 ? 'warn' : '';
    const concepts = [...agent.knowledge].map(id => {
      const c = conceptGraph.concepts.get(id);
      return c ? `<span class="info-tag">${c.icon ?? ''} ${c.name}</span>` : '';
    }).join('');
    const hasMedicine = agent.knowledge.has('medicine');

    const inv = agent.inventory ?? [];
    const inventoryHtml = inv.length > 0
      ? `<div style="margin-top:10px">
          <div class="info-label" style="margin-bottom:5px">Carrying</div>
          <div class="inventory-slots">
            ${inv.map(item => {
              const d = ITEM_DISPLAY[item] ?? { icon: '?', label: item, color: '#e0e0e0' };
              return `<span class="inventory-slot" title="${d.label}" style="border-color:${d.color}55;color:${d.color}">${d.icon}</span>`;
            }).join('')}
          </div>
        </div>`
      : '';

    document.getElementById('info-content').innerHTML = `
      <div class="info-name">${agent.name}</div>
      <div class="info-state">${(agent.state || 'wandering').charAt(0).toUpperCase() + (agent.state || 'wandering').slice(1)}</div>
      <div style="margin-top:10px">
        <div class="info-row">
          <span class="info-label">Hunger</span>
          <div class="info-bar-wrap"><div class="info-bar-fill ${hCol}" style="width:${hunger * 100}%"></div></div>
        </div>
        <div class="info-row">
          <span class="info-label">Energy</span>
          <div class="info-bar-wrap"><div class="info-bar-fill ${eCol}" style="width:${energy * 100}%"></div></div>
        </div>
        ${hasMedicine ? `
        <div class="info-row">
          <span class="info-label">🌿 Vitality</span>
          <div class="info-bar-wrap"><div class="info-bar-fill ${vCol}" style="width:${vitality * 100}%;background:#d97ef5"></div></div>
        </div>` : ''}
        <div class="info-row">
          <span class="info-label">Age</span>
          <span style="font-size:11px;opacity:.5">${Math.floor(agent.age)}s / ${Math.floor(agent.maxAge)}s ${agent.isAdult ? '' : '· juvenile'}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Curiosity</span>
          <span style="font-size:11px;opacity:.5">${(agent.curiosity * 100).toFixed(0)}%</span>
        </div>
        ${agent.task ? `<div class="info-row"><span class="info-label">Task</span><span class="info-tag">${Agent.TASKS[agent.task]?.icon ?? '•'} ${Agent.TASKS[agent.task]?.name ?? agent.task}</span></div>` : ''}
      </div>
      ${inventoryHtml}
      ${concepts ? `<div class="info-tags">${concepts}</div>` : '<div style="opacity:.3;font-size:12px;margin-top:10px">No discoveries yet</div>'}
    `;
  }

  // ── Notifications (max 3 per type, Environmental vs Social) ───────────
  const MAX_NOTIFICATIONS_PER_TYPE = 3;

  function showNotification(msg, type = 'env') {
    const container = document.getElementById(`notifications-${type}`);
    if (!container) return;
    // Spread into a real Array so length decreases as items are removed
    const items = [...container.querySelectorAll('.notification')];
    while (items.length >= MAX_NOTIFICATIONS_PER_TYPE) {
      items.shift().remove();
    }
    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  // ── Game loop ──────────────────────────────────────────────────────────
  let lastTimestamp = null;

  function frame(timestamp) {
    requestAnimationFrame(frame);
    try {
    const realDelta = lastTimestamp === null ? 0 : (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    const delta = time.update(realDelta);

    if (delta > 0) {
      // Update weather simulation — notify on significant changes
      const prevWeather = weather.current;
      weather.update(delta, time.season);
      if (weather.current !== prevWeather) {
        if (weather.current === 'STORM')  showNotification('A storm rolls in...', 'env');
        if (weather.current === 'RAIN')   showNotification('Rain begins to fall.', 'env');
        if (weather.current === 'CLEAR' && (prevWeather === 'STORM' || prevWeather === 'RAIN')) {
          showNotification('The skies clear.', 'env');
          wr.triggerRainbow();
        }
      }

      // Lightning strikes during storms — can set forest on fire
      if (weather.current === 'STORM') {
        lightningCooldown -= delta;
        if (lightningCooldown <= 0) {
          lightningCooldown = 35 + Math.random() * 25;
          const forestTiles = world.getTilesOfType(TileType.FOREST);
          if (forestTiles.length > 0) {
            const tile = forestTiles[Math.floor(Math.random() * forestTiles.length)];
            const key = `${tile.x},${tile.z}`;
            world.naturalFires.set(key, { endTime: time.gameTime + 28 + Math.random() * 18 });
            wr.addFireLight(tile.x, tile.z);
            wr.addFlash(tile.x * TILE_SIZE + TILE_SIZE / 2, tile.z * TILE_SIZE + TILE_SIZE / 2, 0xffcc44);
            showNotification('Lightning strikes the forest!', 'env');
          }
        }
      }
      // Prune expired natural fires
      for (const [key, data] of [...world.naturalFires.entries()]) {
        if (time.gameTime >= data.endTime) {
          world.naturalFires.delete(key);
          const [tx, tz] = key.split(',').map(Number);
          wr.removeFireLight(tx, tz);
        }
      }

      // Regenerate tile food resources (season-aware)
      world.updateResources(delta, time.season);
      // Tick tree regrowth countdowns
      world.updateCutTrees(delta);
      // Tick chicken egg-laying
      world.updateChickenNests(delta);
      // Tick cow milk refill
      world.updateCows(delta);

      // Melt/refreeze glaciers based on temperature
      world.updateGlaciers(delta, weather.temperature);
      if (world.glacierData.size > 0) {
        const avgMelt = [...world.glacierData.values()].reduce((s, g) => s + g.melt, 0) / world.glacierData.size;
        if (avgMelt > 0.35 && glacierNotifyState === 'frozen') {
          glacierNotifyState = 'melting';
          showNotification('The mountain glaciers are beginning to melt.', 'env');
        } else if (avgMelt < 0.08 && glacierNotifyState === 'melting') {
          glacierNotifyState = 'frozen';
          showNotification('Glaciers have refrozen in the cold.', 'env');
        }
      }

      // Handle woodcutting events
      if (world.woodcutEvents?.length) {
        for (const evt of world.woodcutEvents) {
          showNotification(`${evt.agentName} felled a tree. 🪵`, 'env');
        }
        world.woodcutEvents.length = 0;
      }

      // Handle agent-lit campfires
      if (world.campfireEvents?.length) {
        for (const evt of world.campfireEvents) {
          const key = `${evt.tx},${evt.tz}`;
          if (!world.naturalFires.has(key)) {
            world.naturalFires.set(key, { endTime: time.gameTime + 40 + Math.random() * 20 });
            wr.addFireLight(evt.tx, evt.tz);
            showNotification(`${evt.agentName} lights a fire to keep warm.`, 'env');
          }
        }
        world.campfireEvents.length = 0;
      }

      const wMult = weather.energyDrainMult;
      for (const h of horses) h.tick(delta, world, horses);
      for (const agent of agents) {
        if (agent?.health > 0) {
          try {
            agent.tick(delta, world, agents, conceptGraph, wMult);
          } catch (e) {
            console.error('[World] Agent tick failed', agent?.id, e);
          }
        }
      }

      // Horse mounting: agents with horse_taming can mount nearby riderless horses
      for (const agent of agents) {
        if (agent.health <= 0 || agent.mountedHorse) continue;
        if (!agent.knowledge.has('horse_taming')) continue;
        for (const horse of horses) {
          if (horse.rider) continue;
          if (Math.hypot(horse.x - agent.x, horse.z - agent.z) < 1.5) {
            if (Math.random() < 0.018 * delta * 60) {
              agent.mountedHorse = horse;
              horse.rider = agent;
              agent._rideTimer = 22 + Math.random() * 22;
              showNotification(`${agent.name} mounts a wild horse!`, 'social');
              break;
            }
          }
        }
      }

      // Handle simulation events
      for (const evt of conceptGraph.drainEvents()) {
        const concept = conceptGraph.concepts.get(evt.conceptId);
        const cName = concept ? `${concept.icon ?? ''} ${concept.name}` : evt.conceptId;

        if (evt.type === 'discovery') {
          showNotification(`${evt.agentName} discovered ${cName}!`, 'social');
          if (evt.conceptId === 'organisation') {
            const agent = agents.find(a => a.id === evt.agentId);
            if (agent) {
              agent._adoptTask(agents);
              const taskInfo = agent.task && Agent.TASKS[agent.task] ? Agent.TASKS[agent.task] : null;
              if (taskInfo) showNotification(`${evt.agentName} has taken up the role of ${taskInfo.name}`, 'social');
            }
          }
          // Flash at agent location
          const agent = agents.find(a => a.id === evt.agentId);
          if (agent) {
            const wx = agent.x * 2;
            const wz = agent.z * 2;
            wr.addFlash(wx, wz, 0xff8800);
          }
        }
        // Spread events are silent (too frequent to notify)
      }

      // Handle births
      const hasAgriculture = agents.some(a => a.health > 0 && a.knowledge.has('agriculture'));
      const maxPop = Number(maxPopSlider?.value ?? 100);
      const carryingCapacity = Math.min(maxPop, Math.floor(world.getCarryingCapacity() * (hasAgriculture ? 1.25 : 1)));
      for (const evt of conceptGraph.drainBirthEvents()) {
        const alive = agents.filter(a => a.health > 0).length;
        if (alive >= carryingCapacity) continue;

        // Find a walkable spawn tile near the birth position
        let bx = evt.x, bz = evt.z;
        if (!world.isWalkable(Math.floor(bx), Math.floor(bz))) {
          const tile = world.findNearest(Math.floor(bx), Math.floor(bz), [TileType.GRASS, TileType.FOREST], 4);
          if (!tile) continue;
          bx = tile.x + 0.5;
          bz = tile.z + 0.5;
        }

        const child = new Agent(bx, bz);
        agents.push(child);
        ar.addAgent(child);
        birthGameTimes.push(time.gameTime);
        showNotification(`${evt.parentName} has a child — ${child.name}`, 'social');
      }


    }

    // Rendering always runs (for smooth camera)
    wr.setTimeOfDay(time.timeOfDay);
    wr.setWeather(weather.meta);
    terrainRenderer.updateGlaciers(world.glacierData);
    terrainRenderer.updateResources(world);
    terrainRenderer.updateCutTrees(world);
    terrainRenderer.updateAnimals(delta > 0 ? delta : 0, {
      gameTime: time.gameTime,
      dayLength: time.dayLength,
    });
    ar.update(wr.camera);
    horseRenderer.update();
    butterflyRenderer.update(delta > 0 ? delta : 0, weather.current === 'CLEAR');
    beeRenderer.update(delta > 0 ? delta : 0, weather.current === 'CLEAR');
    sheepRenderer.update(delta > 0 ? delta : 0);
    highlandCowRenderer.update(delta > 0 ? delta : 0);
    flowerRenderer.update(delta > 0 ? delta : 0, time.season);
    buildingRenderer.checkAgents(agents);
    wr.updateRain(realDelta, weather.isRaining, weather.isStorm);
    wr.render();
    updateHUD();
    } catch (e) {
      const msg = e?.message || e?.toString?.() || 'Game loop error';
      showError(msg, e);
      console.error('[World] Frame error stack:', e?.stack);
      setTimeout(hideError, 8000);
    }
  }

  requestAnimationFrame(frame);
  } catch (e) {
    showError('Failed to initialize', e);
    const loadingText = document.getElementById('loading-text');
    if (loadingText) loadingText.textContent = 'Initialization failed. Check console.';
    return;
  }
}

init().catch(e => showError('Init failed', e));
