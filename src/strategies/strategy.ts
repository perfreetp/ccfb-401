import type { DeploymentPlan, DeploymentUnit, GameMap, UnitTypeId } from '../sim/types';
import type { GameConfig, ScenarioConfig } from '../config/types';
import { generateMap, isDeployable } from '../sim/mapgen';
import { hashString } from '../sim/prng';

export interface StrategyDefinition {
  id: string;
  name: string;
  shortName: string;
  color: string;
  description: string;
  order: UnitTypeId[];
  placement: 'forward' | 'balanced' | 'base';
}

export const BUILTIN_STRATEGIES: StrategyDefinition[] = [
  {
    id: 'ground-first',
    name: '地面前推',
    shortName: '地面优先',
    color: '#e0a13c',
    description: '集中扑火队抵近火线，靠人工隔离带和水背具切断火头。机动慢，但单位成本低。',
    order: ['ground', 'ground', 'ground', 'ground', 'tender', 'ground', 'ground', 'tender', 'helicopter'],
    placement: 'forward',
  },
  {
    id: 'air-first',
    name: '空中压制',
    shortName: '空中优先',
    color: '#e8d69a',
    description: '优先投入直升机越过断崖快速投水，地面单位负责守住资产。覆盖快，续航受水源距离限制。',
    order: ['helicopter', 'helicopter', 'ground', 'tender', 'ground', 'helicopter', 'tender', 'ground'],
    placement: 'balanced',
  },
  {
    id: 'balanced',
    name: '水陆空协同',
    shortName: '协同部署',
    color: '#7dc2ad',
    description: '地面队、水罐车与直升机按 2:1:1 混编，先建立水源补给链，再进行分区压制。',
    order: ['ground', 'tender', 'helicopter', 'ground', 'tender', 'ground', 'helicopter', 'ground', 'tender'],
    placement: 'base',
  },
];

function candidateScore(
  map: GameMap,
  x: number,
  y: number,
  placement: StrategyDefinition['placement'],
): number {
  const ignition = map.scenario.ignition;
  const base = map.scenario.base;
  if (placement === 'forward') {
    return Math.hypot(x - ignition.x, y - ignition.y);
  }
  if (placement === 'base') {
    return Math.hypot(x - base.x, y - base.y);
  }
  const ideal = Math.hypot(ignition.x - base.x, ignition.y - base.y) * 0.55;
  const fromBase = Math.hypot(x - base.x, y - base.y);
  return Math.abs(ideal - fromBase) + Math.hypot(x - ignition.x, y - ignition.y) * 0.35;
}

export function buildStrategyPlan(
  scenario: ScenarioConfig,
  config: GameConfig,
  strategy: StrategyDefinition,
  mapOverride?: GameMap,
): DeploymentPlan {
  const map = mapOverride ?? generateMap(scenario, config);
  const candidates: { x: number; y: number; score: number }[] = [];
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      if (!isDeployable(map, x, y, config)) continue;
      const cell = map.cells[y][x];
      if (cell.asset) continue;
      candidates.push({ x, y, score: candidateScore(map, x, y, strategy.placement) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  const units: DeploymentUnit[] = [];
  const counts: Record<UnitTypeId, number> = { ground: 0, tender: 0, helicopter: 0 };
  let budget = scenario.budget;
  let orderIndex = 0;
  let candidateIndex = 0;

  while (orderIndex < strategy.order.length) {
    const type = strategy.order[orderIndex];
    const cfg = config.units[type];
    if (budget < cfg.cost) break;
    if (counts[type] >= cfg.maxCount) {
      orderIndex++;
      continue;
    }
    const chosen: { x: number; y: number } | null = pickPlacement(candidates, units);
    if (!chosen) break;
    units.push({
      id: `${strategy.id}-${type}-${units.length + 1}`,
      type,
      cell: { x: chosen.x, y: chosen.y },
      name: `${cfg.shortName} ${String(counts[type] + 1).padStart(2, '0')}`,
    });
    counts[type]++;
    budget -= cfg.cost;
    orderIndex++;
  }

  // Guarantee a usable plan even when the budget is extremely tight.
  if (units.length === 0 && candidates.length > 0) {
    const chosen = candidates[0];
    units.push({
      id: `${strategy.id}-ground-1`,
      type: 'ground',
      cell: { x: chosen.x, y: chosen.y },
      name: '扑火队 01',
    });
  }

  return {
    missionId: scenario.id,
    name: strategy.name,
    templateId: strategy.id,
    units,
  };
}

function pickPlacement(
  candidates: { x: number; y: number; score: number }[],
  units: DeploymentUnit[],
): { x: number; y: number } | null {
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[(i + units.length * 3) % candidates.length];
    if (candidate.x < 0 || candidate.y < 0) continue;
    const occupied = units.some((unit) => Math.hypot(unit.cell.x - candidate.x, unit.cell.y - candidate.y) < 1.1);
    if (!occupied) {
      candidates.splice(candidates.indexOf(candidate), 1);
      return { x: candidate.x, y: candidate.y };
    }
  }
  return null;
}

export function buildAllStrategyPlans(
  scenario: ScenarioConfig,
  config: GameConfig,
): { strategy: StrategyDefinition; plan: DeploymentPlan }[] {
  const map = generateMap(scenario, config);
  return BUILTIN_STRATEGIES.map((strategy) => ({
    strategy,
    plan: buildStrategyPlan(scenario, config, strategy, map),
  }));
}

export function colorForStrategy(strategyId: string): string {
  const builtin = BUILTIN_STRATEGIES.find((strategy) => strategy.id === strategyId);
  if (builtin) return builtin.color;
  const hash = hashString(strategyId);
  const palette = ['#dc9b50', '#8cc9ad', '#7bb7d8', '#cf8b86', '#b9ac78'];
  return palette[hash % palette.length];
}
