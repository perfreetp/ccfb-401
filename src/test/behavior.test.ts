import { describe, expect, it } from 'vitest';
import raw from '../config/gameConfig.json';
import type { GameConfig } from '../config/types';
import type { DeploymentPlan } from '../sim/types';
import { Simulation } from '../sim/engine';
import { generateMap } from '../sim/mapgen';

const config = raw as unknown as GameConfig;
const scenario = config.scenarios[0];

function deployAt(x: number, y: number, type: 'ground' | 'tender' | 'helicopter' = 'ground'): DeploymentPlan {
  return {
    missionId: scenario.id,
    units: [{ id: `test-${type}`, type, cell: { x, y }, name: '测试单位' }],
  };
}

describe('simulation command and autonomous behavior', () => {
  it('raises a wind forecast warning before a sudden shift', () => {
    const sim = new Simulation(scenario, config, { missionId: scenario.id, units: [] }, 500);
    for (let i = 0; i < 100; i++) sim.update(1);
    const alert = sim.getWindAlert();
    expect(alert?.kind).toBe('forecast');
    expect(alert?.secondsUntil).toBeGreaterThan(0);
    expect(alert?.eventIndex).toBe(0);
    for (let i = 0; i < 20; i++) sim.update(1);
    expect(sim.getWindAlert()?.kind).toBe('shift');
    expect(sim.windShiftEventsCount).toBeGreaterThan(0);
  });

  it('refills a low-water unit at a water source without player input', () => {
    const sim = new Simulation(scenario, config, deployAt(scenario.base.x, scenario.base.y), 3);
    const unit = sim.units[0];
    unit.water = 8;
    for (let i = 0; i < 8; i++) sim.update(1);
    expect(unit.water).toBeGreaterThan(unit.waterCapacity * 0.9);
    expect(unit.state).not.toBe('补水');
  });

  it('builds a planned firebreak through the ground crew behavior tree', () => {
    const sim = new Simulation(scenario, config, deployAt(scenario.base.x, scenario.base.y), 4);
    const nearby = [];
    for (let y = 0; y < sim.map.rows; y++) {
      for (let x = 0; x < sim.map.cols; x++) {
        const cell = sim.map.cells[y][x];
        if (
          cell.fuel > 0 &&
          !cell.asset &&
          cell.terrain !== 'water' &&
          cell.terrain !== 'cliff' &&
          Math.hypot(x - scenario.base.x, y - scenario.base.y) < 5
        ) {
          nearby.push({ x, y });
        }
      }
    }
    expect(nearby.length).toBeGreaterThan(0);
    const sorted = nearby
      .map((point) => ({ ...point, distance: Math.hypot(point.x - scenario.base.x, point.y - scenario.base.y) }))
      .sort((a, b) => a.distance - b.distance);
    const result = sim.orderBreakLine([sorted[0]]);
    expect(result.ok).toBe(true);
    for (let i = 0; i < 30; i++) sim.update(1);
    expect(sim.getSnapshot().firebreakCells).toBeGreaterThan(0);
  });

  it('broadcasts SOS when a crew is surrounded by fire', () => {
    const sim = new Simulation(scenario, config, deployAt(20, 20), 6);
    const unit = sim.units[0];
    const cx = Math.floor(unit.pos.x);
    const cy = Math.floor(unit.pos.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const cell = sim.map.cells[cy + dy]?.[cx + dx];
        if (cell) {
          cell.fire = 1;
          cell.intensity = 0.8;
          cell.fuel = 0.4;
        }
      }
    }
    sim.update(1);
    expect(sim.getSnapshot().distressCount).toBeGreaterThan(0);
    expect(sim.events.some((event) => event.message.includes('SOS'))).toBe(true);
  });

  it('retreats out of a three-sided fire pocket', () => {
    const sim = new Simulation(scenario, config, deployAt(20, 20), 10);
    const unit = sim.units[0];
    const cx = Math.floor(unit.pos.x);
    const cy = Math.floor(unit.pos.y);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1]] as const) {
      const cell = sim.map.cells[cy + dy]?.[cx + dx];
      if (cell) {
        cell.fire = 1;
        cell.intensity = 0.7;
        cell.fuel = 0.4;
      }
    }
    const start = { ...unit.pos };
    for (let i = 0; i < 8; i++) sim.update(1);
    expect(Math.hypot(unit.pos.x - start.x, unit.pos.y - start.y)).toBeGreaterThan(0.5);
    expect(unit.state === '避险' || unit.state === '待命' || unit.state === '机动').toBe(true);
  });

  it('issues a reachable surface water-drop order against a burning cell', () => {
    const map = generateMap(scenario, config);
    let unitCell: { x: number; y: number } | null = null;
    let burningCell: { x: number; y: number } | null = null;
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) {
        const cell = map.cells[y][x];
        if (cell.fire === 1 && !burningCell) burningCell = { x, y };
        if (
          !unitCell &&
          cell.terrain !== 'water' &&
          cell.terrain !== 'cliff' &&
          Math.hypot(x - scenario.ignition.x, y - scenario.ignition.y) < 7
        ) unitCell = { x, y };
      }
    }
    expect(burningCell).not.toBeNull();
    expect(unitCell).not.toBeNull();
    const sim = new Simulation(scenario, config, deployAt(unitCell!.x, unitCell!.y, 'tender'), 7);
    const result = sim.orderDrop(burningCell!);
    expect(result.ok).toBe(true);
    expect(sim.units[0].task.requestedByPlayer).toBe(true);
    expect(sim.units[0].task.kind).toBe('drop');
  });

  it('requires a nearby ground crew before igniting a backfire', () => {
    const empty = new Simulation(scenario, config, { missionId: scenario.id, units: [] }, 8);
    const point = { x: scenario.ignition.x + 3, y: scenario.ignition.y + 3 };
    expect(empty.orderBackfire(point).ok).toBe(false);

    const crew = new Simulation(scenario, config, deployAt(scenario.ignition.x + 3, scenario.ignition.y + 3), 9);
    const result = crew.orderBackfire({ x: scenario.ignition.x + 1, y: scenario.ignition.y + 4 });
    expect(result.ok).toBe(true);
    expect(crew.map.cells[scenario.ignition.y + 4][scenario.ignition.x + 1].backfire).toBe(true);
  });
});
