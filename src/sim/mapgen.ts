import type { GameConfig, ScenarioConfig } from '../config/types';
import type { Cell, GameMap } from './types';
import { findPath } from './pathfinding';

function hash2(ix: number, iy: number, seed: number): number {
  let h = ix * 374761393 + iy * 668265263 + seed * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967296);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

function fbm(x: number, y: number, seed: number): number {
  return (
    valueNoise(x, y, seed) * 0.62 +
    valueNoise(x * 2.13 + 17, y * 2.13 - 9, seed + 93) * 0.27 +
    valueNoise(x * 4.37 - 5, y * 4.37 + 21, seed + 211) * 0.11
  );
}

function insideEllipse(x: number, y: number, ellipse: { x: number; y: number; rx: number; ry: number }): number {
  const nx = (x - ellipse.x) / Math.max(0.5, ellipse.rx);
  const ny = (y - ellipse.y) / Math.max(0.5, ellipse.ry);
  return nx * nx + ny * ny;
}

function chooseVegetation(
  elevation: number,
  moisture: number,
  noise: number,
  road: boolean,
  nearWater: boolean,
): string {
  if (road) return 'grass';
  if (nearWater && moisture > 0.32) return 'wetland';
  if (elevation > 142 && noise > 0.4) return 'pine';
  if (moisture > 0.29) return 'mixed';
  if (noise > 0.57) return 'shrub';
  return 'grass';
}

export function generateMap(scenario: ScenarioConfig, config: GameConfig): GameMap {
  const cols = scenario.cols;
  const rows = scenario.rows;
  const cells: Cell[][] = [];
  const noiseSeed = scenario.seed;

  for (let y = 0; y < rows; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < cols; x++) {
      const broad = fbm(x * config.world.mapNoiseScale, y * config.world.mapNoiseScale, noiseSeed);
      const detail = fbm(x * config.world.detailNoiseScale + 50, y * config.world.detailNoiseScale - 40, noiseSeed + 33);
      const elevation = 14 + broad * 158 + detail * 38;
      const terrain = elevation >= config.world.ridgeElevation ? 'ridge' : 'plain';
      row.push({
        x,
        y,
        terrain,
        vegetation: 'grass',
        elevation,
        moisture: 0.2,
        fuel: 0,
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
      });
    }
    cells.push(row);
  }

  // Water bodies carve low ground and a narrow wetland shore.
  for (const lake of scenario.lakes) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = insideEllipse(x, y, lake);
        const cell = cells[y][x];
        if (d <= 1) {
          cell.terrain = 'water';
          cell.vegetation = 'none';
          cell.elevation = Math.min(cell.elevation, 18);
          cell.moisture = 1;
          cell.fuel = 0;
        } else if (d <= 1 + config.world.lakeShoreFalloff) {
          cell.moisture = Math.min(0.55, 0.3 + (1 - Math.min(1, d - 1)) * 0.3);
          cell.terrain = 'plain';
        }
      }
    }
  }

  // Cliff bands are impassable, elevated and fuel-free.
  for (const cliff of scenario.cliffs) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = insideEllipse(x, y, cliff);
        if (d <= 1) {
          const cell = cells[y][x];
          cell.terrain = 'cliff';
          cell.vegetation = 'none';
          cell.elevation = Math.max(cell.elevation, config.world.ridgeElevation + 30);
          cell.moisture = 0;
          cell.fuel = 0;
        }
      }
    }
  }

  const clearCell = (x: number, y: number, terrain = 'plain'): void => {
    const cell = cells[y][x];
    cell.terrain = terrain;
    cell.vegetation = 'grass';
    cell.moisture = 0.24;
    cell.fuel = config.vegetation['grass']?.fuel ?? 0.34;
    cell.elevation = Math.min(cell.elevation, 120);
  };

  clearCell(scenario.base.x, scenario.base.y);
  cells[scenario.base.y][scenario.base.x].base = true;
  cells[scenario.base.y][scenario.base.x].terrain = 'base';
  cells[scenario.base.y][scenario.base.x].vegetation = 'none';
  cells[scenario.base.y][scenario.base.x].moisture = 1;
  cells[scenario.base.y][scenario.base.x].fuel = 0;

  for (const asset of scenario.assets) {
    clearCell(asset.x, asset.y);
    cells[asset.y][asset.x].asset = asset;
  }

  clearCell(scenario.ignition.x, scenario.ignition.y);

  // Base apron.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = scenario.base.x + dx;
      const y = scenario.base.y + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const cell = cells[y][x];
      if (cell.terrain === 'water' || cell.terrain === 'cliff' || cell === cells[scenario.base.y][scenario.base.x]) continue;
      cell.terrain = 'base';
      cell.vegetation = 'none';
      cell.fuel = 0;
      cell.moisture = 0.9;
    }
  }

  // Fill vegetation and fuel values.
  const lakeShoreCells = new Set<string>();
  for (const lake of scenario.lakes) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = insideEllipse(x, y, lake);
        if (d > 1 && d <= 1.5) lakeShoreCells.add(`${x},${y}`);
      }
    }
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = cells[y][x];
      if (cell.terrain === 'cliff' || cell.terrain === 'water' || cell.vegetation === 'none') {
        cell.fuel = 0;
        continue;
      }
      const noise = fbm((x + 11) * 0.14, (y - 7) * 0.14, noiseSeed + 71);
      const vegId = chooseVegetation(
        cell.elevation,
        cell.moisture,
        noise,
        false,
        lakeShoreCells.has(`${x},${y}`),
      );
      const veg = config.vegetation[vegId] ?? config.vegetation['grass'];
      const moistureNoise = (fbm(x * 0.2 - 20, y * 0.2 + 30, noiseSeed + 17) - 0.5) * 0.08;
      cell.vegetation = vegId;
      cell.fuel = veg.fuel;
      cell.moisture = Math.max(
        0.04,
        Math.min(0.7, veg.moisture + scenario.fuelMoistureOffset + moistureNoise),
      );
    }
  }

  // Roads are carved only if a passable ground route exists.
  const placeRoadPath = (from: { x: number; y: number }, to: { x: number; y: number }): void => {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) cells[y][x].fire = 0;
    const proxy: GameMap = { scenario, cols, rows, cells, assets: scenario.assets, startTime: 0, wind: { ...scenario.weather } };
    const path = findPath(proxy, from, to, { avoidFire: false, dangerPenalty: 0 });
    if (!path) return;
    for (const point of path) {
      const cell = cells[point.y][point.x];
      if (cell.asset || cell.base) continue;
      if (cell.terrain === 'water' || cell.terrain === 'cliff') continue;
      cell.terrain = 'road';
      cell.vegetation = 'grass';
      cell.fuel = Math.max(0.12, cell.fuel * 0.45);
      cell.moisture = Math.max(cell.moisture, 0.32);
    }
  };

  for (const asset of scenario.assets) {
    placeRoadPath(scenario.base, { x: asset.x, y: asset.y });
  }
  placeRoadPath(scenario.ignition, scenario.base);

  // Ensure key points still have valid terrain after road carving.
  const baseCell = cells[scenario.base.y][scenario.base.x];
  baseCell.terrain = 'base';
  baseCell.base = true;
  baseCell.vegetation = 'none';
  baseCell.fuel = 0;

  const ignitionCell = cells[scenario.ignition.y][scenario.ignition.x];
  ignitionCell.terrain = 'plain';
  ignitionCell.vegetation = 'pine';
  ignitionCell.fuel = config.vegetation['pine'].fuel;
  ignitionCell.moisture = Math.min(0.45, config.vegetation['pine'].moisture + scenario.fuelMoistureOffset);
  ignitionCell.fire = 1;
  ignitionCell.intensity = config.fire.initialIgnitionIntensity;
  ignitionCell.ignitionAt = 0;

  const ignitionRadius = config.fire.initialIgnitionRadiusCells;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.hypot(dx, dy) > ignitionRadius) continue;
      const cell = cells[scenario.ignition.y + dy]?.[scenario.ignition.x + dx];
      if (!cell || cell.fire !== 0 || cell.fuel <= 0) continue;
      if (cell.terrain === 'water' || cell.terrain === 'cliff' || cell.asset) continue;
      cell.fire = 1;
      cell.intensity = config.fire.initialIgnitionIntensity * 0.3;
      cell.ignitionAt = 0;
    }
  }

  for (const asset of scenario.assets) {
    cells[asset.y][asset.x].asset = asset;
  }

  const map: GameMap = {
    scenario,
    cols,
    rows,
    cells,
    assets: scenario.assets,
    startTime: 0,
    wind: {
      fromDeg: scenario.weather.fromDeg,
      speed: scenario.weather.speed,
      humidity: scenario.weather.humidity,
      temperature: scenario.weather.temperature,
    },
  };

  return map;
}

export function cellIndex(map: GameMap, x: number, y: number): number {
  return y * map.cols + x;
}

export function cellAt(map: GameMap, x: number, y: number): Cell | null {
  if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return null;
  return map.cells[y][x];
}

export function isDeployable(map: GameMap, x: number, y: number, config: GameConfig): boolean {
  const cell = cellAt(map, x, y);
  if (!cell) return false;
  if (cell.terrain === 'water' || cell.terrain === 'cliff') return false;
  if (x < config.world.deploymentMinEdgeDistance || y < config.world.deploymentMinEdgeDistance) return false;
  if (x >= map.cols - config.world.deploymentMinEdgeDistance || y >= map.rows - config.world.deploymentMinEdgeDistance) return false;
  const fireDistance = Math.hypot(x - map.scenario.ignition.x, y - map.scenario.ignition.y);
  return fireDistance >= config.world.deploymentMinFireDistance;
}
