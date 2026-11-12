import type { GameConfig, ScenarioConfig } from '../config/types';
import type { BatchResult, BatchStrategySummary, DeploymentPlan } from './types';
import { Simulation } from './engine';

export interface BatchStrategyInput {
  id: string;
  name: string;
  color: string;
  plan: DeploymentPlan;
}

export interface BatchRequest {
  scenario: ScenarioConfig;
  config: GameConfig;
  strategies: BatchStrategyInput[];
  runsPerStrategy: number;
}

export interface BatchProgress {
  strategyId: string;
  strategyName: string;
  completed: number;
  total: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function runStrategyBatch(
  request: BatchRequest,
  strategy: BatchStrategyInput,
  onProgress?: (progress: BatchProgress) => void,
): BatchStrategySummary {
  const values: number[] = [];
  let durationSum = 0;
  let waterSum = 0;
  let lostSum = 0;
  let successes = 0;

  for (let run = 0; run < request.runsPerStrategy; run++) {
    const simulation = new Simulation(
      request.scenario,
      request.config,
      strategy.plan,
      run + 1,
    );
    const tick = Math.max(0.25, request.config.batch.tickSeconds);
    const maxTime = request.scenario.durationSec + request.config.batch.timeoutGuardSec;
    let guard = 0;
    while (!simulation.finished && simulation.time < maxTime && guard++ < 20000) {
      simulation.update(tick);
    }
    const result = simulation.result;
    if (!result) {
      values.push(request.scenario.maxBurnedHa * 2);
      continue;
    }
    values.push(result.burnedHa);
    durationSum += result.durationSec;
    waterSum += result.waterUsed;
    lostSum += result.unitsLost;
    if (result.outcome === 'contained' && result.burnedHa <= request.scenario.maxBurnedHa) {
      successes++;
    }
    onProgress?.({
      strategyId: strategy.id,
      strategyName: strategy.name,
      completed: run + 1,
      total: request.runsPerStrategy,
    });
  }

  const sorted = [...values].sort((a, b) => a - b);
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    color: strategy.color,
    runs: request.runsPerStrategy,
    meanBurnedHa: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    medianBurnedHa: percentile(sorted, 0.5),
    p10BurnedHa: percentile(sorted, 0.1),
    p90BurnedHa: percentile(sorted, 0.9),
    successRate: successes / Math.max(1, request.runsPerStrategy),
    meanDuration: durationSum / Math.max(1, values.length),
    meanWaterUsed: waterSum / Math.max(1, values.length),
    meanUnitsLost: lostSum / Math.max(1, values.length),
    values,
  };
}

export function runBatch(
  request: BatchRequest,
  onProgress?: (progress: BatchProgress) => void,
): BatchResult {
  const startedAt = performance.now();
  const summaries = request.strategies.map((strategy) =>
    runStrategyBatch(request, strategy, onProgress),
  );
  const completedAt = new Date().toISOString();
  return {
    missionId: request.scenario.id,
    missionName: request.scenario.name,
    runsPerStrategy: request.runsPerStrategy,
    completedAt,
    elapsedMs: performance.now() - startedAt,
    strategies: summaries,
    notes: [
      `每套部署使用相同随机种子组，共 ${request.runsPerStrategy} 局，便于成对比较。`,
      `无头推演步长 ${request.config.batch.tickSeconds}s，与实时指挥存在轻微差异。`,
      '达成率定义为：明火扑灭且过火面积不超过预案上限。',
    ],
  };
}
