import { describe, expect, it } from 'vitest';
import raw from '../config/gameConfig.json';
import type { GameConfig } from '../config/types';
import { generateMap } from '../sim/mapgen';
import { findPath } from '../sim/pathfinding';

const config = raw as unknown as GameConfig;
const scenario = config.scenarios[0];

describe('pathfinding', () => {
  it('never routes a ground unit through a burning fire line', () => {
    const map = generateMap(scenario, config);
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) map.cells[y][x].fire = 0;
    }
    for (let x = 0; x < map.cols; x++) map.cells[15][x].fire = 1;
    const path = findPath(map, { x: 8, y: 24 }, { x: 8, y: 5 }, { avoidFire: true, flying: false });
    expect(path).toBeNull();
    const airPath = findPath(map, { x: 8, y: 24 }, { x: 8, y: 5 }, { flying: true });
    expect(airPath).not.toBeNull();
  });

  it('rejects impassable cliff targets for ground units', () => {
    const map = generateMap(scenario, config);
    let cliff: { x: number; y: number } | null = null;
    for (let y = 0; y < map.rows && !cliff; y++) {
      for (let x = 0; x < map.cols; x++) {
        if (map.cells[y][x].terrain === 'cliff') {
          cliff = { x, y };
          break;
        }
      }
    }
    expect(cliff).not.toBeNull();
    const path = findPath(map, { x: 5, y: 25 }, cliff!, { avoidFire: false, flying: false });
    expect(path).toBeNull();
    const airPath = findPath(map, { x: 5, y: 25 }, cliff!, { flying: true });
    expect(airPath).not.toBeNull();
  });

  it('rounds down cell-center coordinates at the last map row', () => {
    const map = generateMap(scenario, config);
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) map.cells[y][x].fire = 0;
    }
    const path = findPath(map, { x: 8.5, y: map.rows - 0.5 }, { x: 12, y: map.rows - 1 }, { flying: true });
    expect(path?.length).toBeGreaterThan(0);
    expect(path?.[0]).toEqual({ x: 8, y: map.rows - 1 });
  });
});
