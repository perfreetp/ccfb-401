import { describe, expect, it } from 'vitest';
import raw from '../config/gameConfig.json';
import type { GameConfig } from '../config/types';
import type { Cell, WeatherState } from '../sim/types';
import { computeSpreadChance } from '../sim/engine';

const config = raw as unknown as GameConfig;

function makeCell(overrides: Partial<Cell> = {}): Cell {
  return {
    x: 10,
    y: 10,
    terrain: 'plain',
    vegetation: 'grass',
    elevation: 80,
    moisture: 0.15,
    fuel: config.vegetation['grass'].fuel,
    fire: 0,
    intensity: 0,
    burningTime: 0,
    firebreak: false,
    breakProgress: 0,
    plannedBreak: false,
    wetness: 0,
    backfire: false,
    burnedAt: null,
    ignitionAt: null,
    ...overrides,
  };
}

function makeWind(overrides: Partial<WeatherState> = {}): WeatherState {
  return {
    fromDeg: 270,
    speed: 5,
    humidity: 35,
    temperature: 28,
    ...overrides,
  };
}

describe('fire spread model', () => {
  it('spreads faster downwind than upwind', () => {
    const source = makeCell({ fire: 1 });
    const east = makeCell({ x: 11 });
    const west = makeCell({ x: 9 });
    const eastChance = computeSpreadChance(config, source, east, makeWind({ fromDeg: 270 }));
    const westChance = computeSpreadChance(config, source, west, makeWind({ fromDeg: 270 }));
    expect(eastChance).toBeGreaterThan(westChance * 5);
  });

  it('is more aggressive in dry, hot, windy weather', () => {
    const source = makeCell({ fire: 1 });
    const target = makeCell({ x: 11 });
    const dry = computeSpreadChance(config, source, target, makeWind({ humidity: 20, temperature: 35, speed: 9 }));
    const humid = computeSpreadChance(config, source, target, makeWind({ humidity: 90, temperature: 18, speed: 2 }));
    expect(dry).toBeGreaterThan(humid);
  });

  it('reduces spread with wet fuel and increases it uphill', () => {
    const source = makeCell({ fire: 1 });
    const dryTarget = makeCell({ x: 11 });
    const wetTarget = makeCell({ x: 11, wetness: 0.8 });
    expect(computeSpreadChance(config, source, dryTarget, makeWind()))
      .toBeGreaterThan(computeSpreadChance(config, source, wetTarget, makeWind()));

    const uphill = makeCell({ x: 11, elevation: 140 });
    const downhill = makeCell({ x: 11, elevation: 20 });
    expect(computeSpreadChance(config, source, uphill, makeWind()))
      .toBeGreaterThan(computeSpreadChance(config, source, downhill, makeWind()));
  });

  it('treats a completed firebreak as a hard stop', () => {
    const source = makeCell({ fire: 1 });
    const breakCell = makeCell({ x: 11, firebreak: true, fuel: 0 });
    expect(computeSpreadChance(config, source, breakCell, makeWind())).toBe(0);
  });

  it('uses vegetation flammability and fuel load', () => {
    const source = makeCell({ fire: 1 });
    const grass = makeCell({ x: 11, vegetation: 'grass' });
    const pine = makeCell({ x: 11, vegetation: 'pine', fuel: config.vegetation['pine'].fuel });
    expect(computeSpreadChance(config, source, pine, makeWind()))
      .toBeGreaterThan(computeSpreadChance(config, source, grass, makeWind()));
  });
});
