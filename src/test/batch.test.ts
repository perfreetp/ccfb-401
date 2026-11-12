import { describe, expect, it } from 'vitest';
import raw from '../config/gameConfig.json';
import type { GameConfig } from '../config/types';
import { buildAllStrategyPlans } from '../strategies/strategy';
import { runBatch } from '../sim/batch';

const config = raw as unknown as GameConfig;

describe('headless batch simulation', () => {
  it('produces paired deterministic summaries for every strategy', () => {
    const scenario = config.scenarios[0];
    const plans = buildAllStrategyPlans(scenario, config).map((entry) => ({
      id: entry.strategy.id,
      name: entry.strategy.name,
      color: entry.strategy.color,
      plan: entry.plan,
    }));
    const request = { scenario, config, strategies: plans, runsPerStrategy: 2 };
    const first = runBatch(request);
    const second = runBatch(request);
    expect(first.strategies).toHaveLength(plans.length);
    expect(second.strategies).toHaveLength(plans.length);
    for (let i = 0; i < plans.length; i++) {
      expect(first.strategies[i].values).toEqual(second.strategies[i].values);
      expect(first.strategies[i].runs).toBe(2);
      expect(first.strategies[i].meanBurnedHa).toBeGreaterThanOrEqual(0);
      expect(first.strategies[i].p10BurnedHa).toBeLessThanOrEqual(first.strategies[i].medianBurnedHa);
      expect(first.strategies[i].medianBurnedHa).toBeLessThanOrEqual(first.strategies[i].p90BurnedHa);
      expect(first.strategies[i].successRate).toBeGreaterThanOrEqual(0);
      expect(first.strategies[i].successRate).toBeLessThanOrEqual(1);
    }
  });
});
