import type { AssetConfig, GameConfig, ScenarioConfig, UnitType } from '../config/types';

export type FireState = 0 | 1 | 2;
export type ToolMode = 'inspect' | 'break' | 'drop' | 'backfire' | 'place';

export interface Cell {
  x: number;
  y: number;
  terrain: string;
  vegetation: string;
  elevation: number;
  moisture: number;
  fuel: number;
  fire: FireState;
  intensity: number;
  burningTime: number;
  firebreak: boolean;
  breakProgress: number;
  plannedBreak: boolean;
  wetness: number;
  backfire: boolean;
  burnedAt: number | null;
  ignitionAt: number | null;
  asset?: AssetConfig;
  base?: boolean;
}

export interface GameMap {
  scenario: ScenarioConfig;
  cols: number;
  rows: number;
  cells: Cell[][];
  assets: AssetConfig[];
  startTime: number;
  wind: WeatherState;
}

export interface WeatherState {
  fromDeg: number;
  speed: number;
  humidity: number;
  temperature: number;
}

export interface WindTimelinePoint {
  at: number;
  wind: WeatherState;
  label?: string;
  kind: 'base' | 'event-start' | 'event-end';
}

export type EventLevel = 'info' | 'success' | 'warning' | 'danger';

export interface SimEvent {
  id: number;
  time: number;
  level: EventLevel;
  message: string;
  cell?: { x: number; y: number };
  unitId?: string;
}

export type UnitState =
  | '待命'
  | '机动'
  | '扑救'
  | '开挖隔离带'
  | '补水'
  | '避险'
  | '吊桶作业'
  | '被困求救'
  | '失联';

export type UnitTypeId = UnitType;

export interface UnitTask {
  kind: 'idle' | 'break' | 'drop' | 'move' | 'resupply' | 'fight' | 'retreat' | 'distress' | 'patrol';
  target?: { x: number; y: number };
  breakTarget?: { x: number; y: number };
  requestedByPlayer?: boolean;
  label?: string;
}

export interface Unit {
  id: string;
  type: UnitTypeId;
  name: string;
  pos: { x: number; y: number };
  anchor: { x: number; y: number };
  water: number;
  waterCapacity: number;
  state: UnitState;
  task: UnitTask;
  path: { x: number; y: number }[];
  pathIndex: number;
  pathAge: number;
  action: string;
  btNode: string;
  cooldown: number;
  resupplyDwell: number;
  distressTimer: number;
  distressCooldown: number;
  distressEpisode: boolean;
  retreatCooldown: number;
  sprayProgress: number;
  drops: number;
  distanceTravelled: number;
  lost: boolean;
  assignedBreak: { x: number; y: number } | null;
  targetCell: { x: number; y: number } | null;
  targetUnitId?: string;
  lastPathFailed: boolean;
}

export interface DeploymentUnit {
  id: string;
  type: UnitTypeId;
  cell: { x: number; y: number };
  name?: string;
}

export interface DeploymentPlan {
  missionId: string;
  units: DeploymentUnit[];
  createdAt?: string;
  name?: string;
  templateId?: string;
}

export interface FireStatsPoint {
  time: number;
  burnedHa: number;
  burning: number;
  containedPct: number;
}

export interface MissionResult {
  id: string;
  missionId: string;
  missionName: string;
  scenarioCode: string;
  scenarioSnapshot?: ScenarioConfig;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  outcome: 'contained' | 'uncontained' | 'timeout';
  stars: number;
  burnedCells: number;
  burnedHa: number;
  maxBurnedHa: number;
  containedPct: number;
  assetsTotal: number;
  assetsProtected: number;
  unitsDeployed: number;
  unitsLost: number;
  distressCount: number;
  waterUsed: number;
  firebreakCells: number;
  backfireCells: number;
  suppressedCells: number;
  windShiftCount: number;
  peakBurningCells: number;
  events: SimEvent[];
  timeline: FireStatsPoint[];
  burnedCellIndices: number[];
  deployment: DeploymentPlan;
  notes: string[];
  seed: number;
}

export interface BatchStrategySummary {
  strategyId: string;
  strategyName: string;
  color: string;
  runs: number;
  meanBurnedHa: number;
  medianBurnedHa: number;
  p10BurnedHa: number;
  p90BurnedHa: number;
  successRate: number;
  meanDuration: number;
  meanWaterUsed: number;
  meanUnitsLost: number;
  values: number[];
}

export interface BatchResult {
  missionId: string;
  missionName: string;
  runsPerStrategy: number;
  completedAt: string;
  elapsedMs: number;
  strategies: BatchStrategySummary[];
  notes: string[];
}

export interface SimSnapshot {
  time: number;
  wind: WeatherState;
  burningCells: number;
  burnedCells: number;
  burnedHa: number;
  contained: boolean;
  containedFor: number;
  assetsLost: number;
  assetsTotal: number;
  assetsProtected: number;
  unitsLost: number;
  waterUsed: number;
  firebreakCells: number;
  backfireCells: number;
  suppressedCells: number;
  peakBurningCells: number;
  distressCount: number;
  windShiftCount: number;
  result: MissionResult | null;
}

export interface WindAlert {
  kind: 'forecast' | 'shift';
  severity: 'watch' | 'warning' | 'danger';
  title: string;
  detail: string;
  secondsUntil: number;
  eventIndex: number;
}

export interface BattleConfig {
  config: GameConfig;
  scenario: ScenarioConfig;
}
