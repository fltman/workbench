// main.ts — kopplar ihop skalet. Världen (yta, kamera, fönster, ritande) och HUD:en (chatten)
// pratar bara via bus.ts, store.ts och gränssnitten i types.ts.
import './styles/tokens.css';
import './styles/base.css';
import { store } from './store.ts';
import { bus } from './bus.ts';
import { createWorld } from './world/world.ts';
import { createHud } from './hud/hud.ts';

const stage = document.getElementById('stage');
const hudLayer = document.getElementById('hud-layer');
if (!stage || !hudLayer) throw new Error('index.html saknar #stage eller #hud-layer');

const world = createWorld(stage);
createHud(hudLayer, world);
// Bara i dev: en krok för tester (Playwright) att läsa tillstånd och sända bus-händelser.
if (import.meta.env.DEV) (window as unknown as { __wb: unknown }).__wb = { store, bus, world };
store.connect();
