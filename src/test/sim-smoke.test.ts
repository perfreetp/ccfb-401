import { describe, it, expect } from 'vitest';
import raw from '../config/gameConfig.json';
import type { GameConfig } from '../config/types';
import { Simulation } from '../sim/engine';
import { buildStrategyPlan, BUILTIN_STRATEGIES } from '../strategies/strategy';
import { generateMap } from '../sim/mapgen';
import type { DeploymentPlan } from '../sim/types';

const config = raw as unknown as GameConfig;
const scenario = config.scenarios[0];

describe('simulation smoke', () => {
  it('generates map with protected points', () => {
    const map = generateMap(scenario, config);
    expect(map.cols).toBe(scenario.cols);
    expect(map.cells[scenario.ignition.y][scenario.ignition.x].fire).toBe(1);
    expect(map.cells[scenario.base.y][scenario.base.x].terrain).toBe('base');
  });

  it('runs a full strategy simulation', () => {
    const plan = buildStrategyPlan(scenario, config, BUILTIN_STRATEGIES[0]);
    expect(plan.units.length).toBeGreaterThan(0);
    const sim = new Simulation(scenario, config, plan, 1);
    let guard = 0;
    while (!sim.finished && guard++ < 600) sim.update(1);
    expect(sim.time).toBeGreaterThan(0);
    expect(sim.result?.timeline.length).toBeGreaterThan(0);
    expect(sim.result?.outcome).toBeDefined();
    expect(sim.result?.burnedHa).toBeGreaterThanOrEqual(0);
    expect(sim.result?.stars).toBeGreaterThanOrEqual(0);
  });
});
