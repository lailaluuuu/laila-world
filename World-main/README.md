# World

A passive emergent-civilisation simulator. Watch primitive agents discover fire, language, and society — or fade from the earth.

## Running the Game

1. Open a terminal in the project directory
2. Run: `python -m http.server 8080`
3. Open http://localhost:8080 in a modern browser

See [guide.html](guide.html) for the full game guide.

## Future Features

### In Progress
- Improved night/day cycle behavior
- Fire gives both light and heat
- More animals
- Animals don't swim unless they're meant to

### Simulation Depth
- Starvation death — agents die when hunger stays at 0
- Disease — infection spreading between nearby agents; Medicine reduces risk
- Old-age weakening — slower movement/gathering near max age
- Natural disasters — droughts, floods, blights affecting tiles or food
- Seasonal migration — agents (or animals) moving toward better tiles in winter

### World & Environment
- Save/load — persist world, agents, discoveries
- Multiple biomes — deserts, swamps, tundra with different rules
- Rivers — flowing water tiles; crossings require Rope or bridge concept
- Caves — shelter from weather, early discovery hotspots
- Resource depletion feedback — tiles slowly degrading (overgrazed grass → barren)

### Animals & Hunting
- Huntable wildlife — Hunting concept actually removes animals for meat
- Predators — wolves/bears that can kill weak agents
- Animal populations — reproduction, migration, extinction
- Domestication feedback — tamed animals that provide food or labour

### Society & Concepts
- Era 3+ — philosophy, governance, trade
- Conflict — rival groups or warfare at higher population
- Visible buildings — houses, workshops, shrines from Housing/Shelter concepts
- Trade — agents exchanging food or resources
- Religion/culture — beliefs that spread and influence behaviour

### UX & Polish
- Mini-map — overview of terrain and settlements
- Timeline/history — scrollable log of discoveries and major events
- Achievements — "Survive 100 days", "Discover all Era 1 concepts"
- World seed input — replay or share specific worlds
- Replay mode — watch a past run from save data

### Technical
- Web Workers — simulation runs off main thread for larger populations
- Progressive Web App — installable, offline-capable
- Mobile support — touch controls and streamlined UI
