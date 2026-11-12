import type { GameConfig, GroundUnitConfig, ScenarioConfig, UnitType } from '../config/types';
import type {
  Cell,
  DeploymentPlan,
  EventLevel,
  FireStatsPoint,
  GameMap,
  MissionResult,
  SimEvent,
  SimSnapshot,
  Unit,
  WeatherState,
  WindAlert,
} from './types';
import { RNG, nowIso } from './prng';
import { generateMap } from './mapgen';
import { findNearestPassable, findPath, findRetreatCell, nearestWaterSource } from './pathfinding';
import type { AIHooks, AIContext } from './behavior';
import { BEHAVIOR_LABELS, BTStatus, buildBehaviorTree, type BTNode, type BehaviorNodeDescription } from './behavior';

const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function angleDelta(from: number, to: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  if (delta < -180) delta += 360;
  return delta;
}

function interpolateAngle(from: number, to: number, t: number): number {
  return (from + angleDelta(from, to) * t + 360) % 360;
}

function bearingBetween(ax: number, ay: number, bx: number, by: number): number {
  return (Math.atan2(bx - ax, -(by - ay)) * 180 / Math.PI + 360) % 360;
}

function euclidean(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function cellCenter(cell: { x: number; y: number }): { x: number; y: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

export function computeSpreadChance(
  config: GameConfig,
  source: Cell,
  target: Cell,
  wind: WeatherState,
): number {
  if (target.fire !== 0 || target.fuel <= 0 || target.firebreak) return 0;
  if (target.terrain === 'water' || target.terrain === 'cliff') return 0;
  const windTo = (wind.fromDeg + 180) % 360;
  const bearing = bearingBetween(source.x, source.y, target.x, target.y);
  const alignment = Math.cos(((bearing - windTo + 540) % 360 - 180) * Math.PI / 180);
  const alignmentFactor = Math.max(0, alignment) ** config.fire.windAlignmentPower;
  const directionFactor = config.fire.windDownwindFloor +
    (1 - config.fire.windDownwindFloor) * alignmentFactor;
  const speedFactor = 1 + wind.speed * config.fire.windSpeedFactorPerMs;
  const slopeDelta = target.elevation - source.elevation;
  const slopeFactor = clamp(
    Math.exp(slopeDelta * config.fire.slopeFactorPerMeter),
    config.fire.slopeFactorFloor,
    config.fire.maxSlopeFactor,
  );
  const effectiveMoisture = clamp(target.moisture + target.wetness * 0.55, 0, 0.98);
  const moistureFactor = Math.pow(Math.max(0.02, 1 - effectiveMoisture), config.fire.moistureExponent);
  const vegetation = config.vegetation[target.vegetation] ?? config.vegetation['grass'];
  const diagonalFactor = source.x !== target.x && source.y !== target.y ? 0.72 : 1;
  const fuelFactor = config.fire.fuelFactorFloor + target.fuel;
  const humidityFactor = Math.max(config.fire.humidityFactorFloor, 1 - Math.max(0, wind.humidity - 15) * config.fire.humiditySensitivity);
  const temperatureFactor = Math.max(0.7, 1 + (wind.temperature - 20) * config.fire.temperatureFactorPerDegree);
  const backfireFactor = source.backfire ? config.fire.backfireSpreadMultiplier : 1;
  const probability =
    config.fire.baseSpreadChance *
    vegetation.spread *
    fuelFactor *
    directionFactor *
    speedFactor *
    slopeFactor *
    moistureFactor *
    humidityFactor *
    temperatureFactor *
    diagonalFactor *
    backfireFactor;
  return clamp(probability, 0, config.fire.maxSpreadChancePerNeighbor);
}

export function compassLabel(degrees: number): string {
  const labels = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南', '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'];
  const index = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return labels[index];
}

export class Simulation {
  readonly map: GameMap;
  readonly config: GameConfig;
  readonly scenario: ScenarioConfig;
  readonly units: Unit[];
  readonly deployment: DeploymentPlan;
  readonly events: SimEvent[] = [];
  readonly timeline: FireStatsPoint[] = [];

  time = 0;
  finished = false;
  result: MissionResult | null = null;

  private readonly rng: RNG;
  private readonly tree: BTNode;
  private readonly behaviorDescription: BehaviorNodeDescription;
  private readonly hooks: AIHooks;
  private wind: WeatherState;
  private spreadAccumulator = 0;
  private timelineAccumulator = 0;
  private eventSequence = 1;
  private burningCellsCount = 0;
  private containedFor = 0;
  private lastSpotEvent = -99;
  private lastSuppressEvent = -99;
  private warnedEvents = new Set<number>();
  private startedEvents = new Set<number>();
  private breakClaims = new Map<string, string>();
  private burnedIndices = new Set<number>();
  private lostAssetIds = new Set<string>();
  private backfireIgnitions = 0;
  private firebreakCount = 0;
  private suppressedCount = 0;
  private waterUsed = 0;
  private peakBurning = 0;
  private windShiftCount = 0;
  private distressCount = 0;
  private readonly startedAt = nowIso();

  constructor(scenario: ScenarioConfig, config: GameConfig, deployment: DeploymentPlan, seedSalt = 0) {
    this.config = config;
    this.scenario = {
      ...scenario,
      windEvents: [...scenario.windEvents].sort((a, b) => a.atSec - b.atSec),
    };
    this.deployment = deployment;
    this.map = generateMap(scenario, config);
    this.rng = new RNG((scenario.seed ^ 0x9e3779b9 ^ (seedSalt * 2654435761)) >>> 0);
    this.wind = { ...scenario.weather };
    this.units = this.createUnits(deployment);

    this.hooks = {
      isTrapped: (unit) => this.isTrapped(unit),
      isLowWater: (unit) => this.isLowWater(unit),
      isInDanger: (unit) => this.isInDanger(unit),
      hasPlayerCommand: (unit) => this.hasPlayerCommand(unit),
      hasBreakWork: (unit) => this.hasBreakWork(unit),
      fireDetected: (unit) => this.hasFireNearby(unit),
      runDistress: (unit, dt) => this.runDistress(unit, dt),
      runRetreat: (unit, dt) => this.runRetreat(unit, dt, false),
      runResupply: (unit, dt) => this.runResupply(unit, dt),
      runCommand: (unit, dt) => this.runCommand(unit, dt),
      runBreak: (unit, dt) => this.runBreak(unit, dt),
      runFight: (unit, dt) => this.runFight(unit, dt),
      runIdle: (unit, dt) => this.runIdle(unit, dt),
    };
    const behavior = buildBehaviorTree(this.hooks);
    this.tree = behavior.tree;
    this.behaviorDescription = behavior.description;

    this.emit('info', `推演开始 · ${scenario.code} ${scenario.name}，火点坐标 ${scenario.ignition.x},${scenario.ignition.y}`);
    if (scenario.assets.length > 0) {
      this.emit('info', `需保护 ${scenario.assets.length} 处设施，预案过火上限 ${scenario.maxBurnedHa} 公顷`);
    }
    this.emit('warning', `初始风场 ${compassLabel(scenario.weather.fromDeg)}风 ${scenario.weather.speed.toFixed(1)} m/s，湿度 ${scenario.weather.humidity}%`);
    this.burningCellsCount = this.map.cells.flat().filter((cell) => cell.fire === 1).length;
    this.recordTimeline(true);
  }

  get windState(): WeatherState {
    return { ...this.wind };
  }

  get duration(): number {
    return this.scenario.durationSec;
  }

  get behaviorTreeDescription(): BehaviorNodeDescription {
    return this.behaviorDescription;
  }

  get activeBurningCells(): number {
    return this.burningCellsCount;
  }

  get assetsProtected(): number {
    return this.scenario.assets.length - this.lostAssetIds.size;
  }

  get burnedHa(): number {
    return this.burnedIndices.size * (this.config.meta.cellSizeMeters ** 2) / 10000;
  }

  get windShiftEventsCount(): number {
    return this.windShiftCount;
  }

  update(dt: number): void {
    if (this.finished) return;
    const step = clamp(dt, 0, 1);
    if (step <= 0) return;
    this.time += step;
    this.updateWind(step);
    this.spreadAccumulator += step;
    const interval = Math.max(0.1, this.config.fire.spreadIntervalSec);
    while (this.spreadAccumulator >= interval) {
      this.spreadAccumulator -= interval;
      this.spreadStep(interval);
    }
    this.updateFireCells(step);
    this.updateWetness(step);
    this.updateUnits(step);
    this.updateContainment(step);
    this.timelineAccumulator += step;
    if (this.timelineAccumulator >= 10) {
      this.timelineAccumulator = 0;
      this.recordTimeline();
    }
    this.peakBurning = Math.max(this.peakBurning, this.burningCellsCount);
    if (!this.finished && this.time >= this.scenario.durationSec) {
      this.finish();
    }
  }

  getSnapshot(): SimSnapshot {
    return {
      time: this.time,
      wind: this.windState,
      burningCells: this.burningCellsCount,
      burnedCells: this.burnedIndices.size,
      burnedHa: this.burnedHa,
      contained: this.burningCellsCount === 0,
      containedFor: this.containedFor,
      assetsLost: this.lostAssetIds.size,
      assetsTotal: this.scenario.assets.length,
      assetsProtected: this.assetsProtected,
      unitsLost: this.units.filter((unit) => unit.lost).length,
      waterUsed: this.waterUsed,
      firebreakCells: this.firebreakCount,
      backfireCells: this.backfireIgnitions,
      suppressedCells: this.suppressedCount,
      peakBurningCells: this.peakBurning,
      distressCount: this.distressCount,
      windShiftCount: this.windShiftCount,
      result: this.result,
    };
  }

  getUnit(id: string): Unit | undefined {
    return this.units.find((unit) => unit.id === id);
  }

  getWindAlert(): WindAlert | null {
    for (let index = 0; index < this.scenario.windEvents.length; index++) {
      const event = this.scenario.windEvents[index];
      if (this.time >= event.atSec && this.time <= event.atSec + event.transitionSec) {
        return {
          kind: 'shift',
          severity: 'danger',
          title: '风向正在突变',
          detail: `${event.label} · 转为 ${compassLabel(event.fromDeg)}风 ${event.speed.toFixed(1)} m/s`,
          secondsUntil: 0,
          eventIndex: index,
        };
      }
      const until = event.atSec - this.time;
      if (until > 0 && until <= event.warnSec) {
        return {
          kind: 'forecast',
          severity: until <= 6 ? 'danger' : 'warning',
          title: until <= 6 ? '即将转向' : '阵风预警',
          detail: `${event.label} · 预计 ${until.toFixed(0)} 秒后转向 ${compassLabel(event.fromDeg)}`,
          secondsUntil: until,
          eventIndex: index,
        };
      }
    }
    return null;
  }

  getUpcomingWindEvent(): { event: ScenarioConfig['windEvents'][number]; index: number } | null {
    const index = this.scenario.windEvents.findIndex((event) => event.atSec > this.time);
    if (index < 0) return null;
    return { event: this.scenario.windEvents[index], index };
  }

  windAt(time: number): WeatherState {
    let from = this.scenario.weather.fromDeg;
    let speed = this.scenario.weather.speed;
    for (const event of this.scenario.windEvents) {
      if (time < event.atSec) break;
      const transition = Math.max(0.001, event.transitionSec);
      const progress = smoothstep((time - event.atSec) / transition);
      from = interpolateAngle(from, event.fromDeg, progress);
      speed = speed + (event.speed - speed) * progress;
    }
    return {
      fromDeg: from,
      speed,
      humidity: this.scenario.weather.humidity,
      temperature: this.scenario.weather.temperature,
    };
  }

  getWindSamples(count = 120): { time: number; fromDeg: number; speed: number }[] {
    const samples: { time: number; fromDeg: number; speed: number }[] = [];
    for (let i = 0; i <= count; i++) {
      const time = this.duration * (i / count);
      const wind = this.windAt(time);
      samples.push({ time, fromDeg: wind.fromDeg, speed: wind.speed });
    }
    return samples;
  }

  orderBreakLine(cells: { x: number; y: number }[]): { ok: boolean; message: string; count: number } {
    if (this.finished) return { ok: false, message: '推演已结束', count: 0 };
    if (!this.units.some((unit) => this.config.units[unit.type].canDig && !unit.lost)) {
      return { ok: false, message: '没有可开挖隔离带的地面扑火队', count: 0 };
    }
    let count = 0;
    for (const point of cells) {
      const cell = this.cellAt(point.x, point.y);
      if (!cell) continue;
      if (cell.firebreak || cell.plannedBreak) continue;
      if (cell.terrain === 'water' || cell.terrain === 'cliff') continue;
      if (cell.fire === 1) continue;
      if (cell.fuel <= 0) continue;
      cell.plannedBreak = true;
      cell.breakProgress = 0;
      count++;
    }
    if (count > 0) {
      this.emit('info', `已下达隔离带作业：${count} 格，扑火队将自动前往开挖。`);
    } else {
      this.emit('warning', '所选位置无法开挖隔离带。');
    }
    return { ok: count > 0, message: count > 0 ? '隔离带计划已下达' : '无法在该位置开挖', count };
  }

  clearBreakPlan(): void {
    for (const row of this.map.cells) {
      for (const cell of row) {
        if (cell.plannedBreak && !cell.firebreak) {
          cell.plannedBreak = false;
          cell.breakProgress = 0;
        }
      }
    }
    this.breakClaims.clear();
    for (const unit of this.units) unit.assignedBreak = null;
    this.emit('info', '已取消尚未执行的隔离带计划。');
  }

  orderDrop(point: { x: number; y: number }): { ok: boolean; message: string } {
    if (this.finished) return { ok: false, message: '推演已结束' };
    const cell = this.cellAt(point.x, point.y);
    if (!cell) return { ok: false, message: '目标超出地图范围' };
    if (cell.terrain === 'water' || cell.terrain === 'cliff') {
      return { ok: false, message: '该位置无法实施洒水' };
    }
    const candidates = this.units
      .filter((unit) => !unit.lost)
      .filter((unit) => this.config.units[unit.type].canSpray)
      .map((unit) => {
        const cfg = this.config.units[unit.type];
        const isHeli = unit.type === 'helicopter';
        const minWater = isHeli && 'bucketSize' in cfg ? cfg.bucketSize : 5;
        const distance = euclidean(unit.pos.x, unit.pos.y, cell.x + 0.5, cell.y + 0.5);
        return { unit, distance, minWater, isHeli };
      })
      .filter((entry) => entry.unit.water >= entry.minWater)
      .filter((entry) => {
        if (entry.isHeli) return this.findPathFor(entry.unit, { x: cell.x, y: cell.y }, true) !== null;
        const sprayRange = (this.config.units[entry.unit.type] as GroundUnitConfig).sprayRange;
        if (euclidean(entry.unit.pos.x, entry.unit.pos.y, cell.x + 0.5, cell.y + 0.5) <= sprayRange) return true;
        return this.findGroundSprayPosition(entry.unit, cell, sprayRange) !== null;
      })
      .sort((a, b) => (a.isHeli === b.isHeli ? a.distance - b.distance : a.isHeli ? -1 : 1));

    const chosen = candidates[0];
    if (!chosen) {
      return {
        ok: false,
        message: this.units.some((unit) => this.config.units[unit.type].canSpray && !unit.lost)
          ? '可用单位水量不足，或目标不可达'
          : '没有可执行洒水的单位',
      };
    }
    if (chosen.unit.assignedBreak) this.releaseBreakAssignment(chosen.unit);
    chosen.unit.task = {
      kind: 'drop',
      target: { x: cell.x, y: cell.y },
      requestedByPlayer: true,
      label: `玩家指定洒水 ${cell.x},${cell.y}`,
    };
    chosen.unit.state = '机动';
    chosen.unit.action = `奉命前往 ${cell.x},${cell.y} 洒水`;
    chosen.unit.targetCell = null;
    chosen.unit.path = [];
    this.emit('info', `${this.unitDisplayName(chosen.unit)} 收到洒水指令，前往 ${cell.x},${cell.y}。`, cell, chosen.unit.id);
    return { ok: true, message: `${this.unitDisplayName(chosen.unit)} 正在前往洒水点` };
  }

  orderBackfire(point: { x: number; y: number }): { ok: boolean; message: string } {
    if (this.finished) return { ok: false, message: '推演已结束' };
    const cell = this.cellAt(point.x, point.y);
    if (!cell) return { ok: false, message: '目标超出地图范围' };
    if (cell.fire !== 0) return { ok: false, message: '只能从未燃区点燃逆火' };
    if (cell.firebreak) return { ok: false, message: '隔离带上不能点逆火' };
    if (cell.fuel <= 0 || cell.terrain === 'water' || cell.terrain === 'cliff') {
      return { ok: false, message: '该位置没有可燃物' };
    }
    const nearestCrew = this.units
      .filter((unit) => !unit.lost && this.config.units[unit.type].canDig)
      .map((unit) => ({ unit, distance: euclidean(unit.pos.x, unit.pos.y, cell.x + 0.5, cell.y + 0.5) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearestCrew || nearestCrew.distance > this.config.behavior.backfireCrewRadiusCells) {
      return {
        ok: false,
        message: `需有一支地面扑火队在 ${this.config.behavior.backfireCrewRadiusCells} 格内才能点火`,
      };
    }
    cell.fire = 1;
    cell.intensity = 0.22;
    cell.burningTime = 0;
    cell.ignitionAt = this.time;
    cell.backfire = true;
    this.backfireIgnitions++;
    this.emit('warning', `逆火在 ${this.cellLabel(cell)} 点燃。可控回烧会消耗隔离带内侧燃料，注意风向变化。`, cell, nearestCrew.unit.id);
    return { ok: true, message: '逆火已点燃' };
  }

  orderRetreatAll(): void {
    const active = this.units.filter((unit) => !unit.lost);
    for (const unit of active) {
      if (unit.assignedBreak) this.releaseBreakAssignment(unit);
      unit.task = { kind: 'retreat', requestedByPlayer: true, label: '全员撤离至安全地域' };
      unit.state = '避险';
      unit.action = '收到全员撤离命令';
      unit.targetCell = null;
      unit.path = [];
    }
    if (active.length > 0) this.emit('warning', `全员撤离命令已下达（${active.length} 个单位）。`, undefined);
  }

  orderUnitRetreat(unitId: string): void {
    const unit = this.getUnit(unitId);
    if (!unit || unit.lost) return;
    if (unit.assignedBreak) this.releaseBreakAssignment(unit);
    unit.task = { kind: 'retreat', requestedByPlayer: true, label: '玩家命令：撤至安全地域' };
    unit.state = '避险';
    unit.action = '收到撤离命令，寻找安全路线';
    unit.targetCell = null;
    unit.path = [];
    this.emit('warning', `${this.unitDisplayName(unit)} 收到撤离命令，正在脱离火线。`, undefined, unit.id);
  }

  endMissionEarly(): void {
    if (this.finished) return;
    this.emit('warning', '指挥员提前结束推演，按当前火场态势结算。');
    this.finish();
    if (this.result) this.result.events = [...this.events];
  }

  cancelOrder(unitId: string): void {
    const unit = this.getUnit(unitId);
    if (!unit) return;
    unit.task = { kind: 'idle' };
    unit.state = unit.lost ? '失联' : '待命';
    unit.action = '指令已取消，转入自主行动';
    unit.targetCell = null;
    unit.path = [];
    if (unit.assignedBreak) this.releaseBreakAssignment(unit);
    this.emit('info', `${this.unitDisplayName(unit)} 的指令已取消。`, undefined, unit.id);
  }

  private createUnits(deployment: DeploymentPlan): Unit[] {
    const counters: Record<UnitType, number> = { ground: 0, tender: 0, helicopter: 0 };
    return deployment.units.map((entry) => {
      const cfg = this.config.units[entry.type];
      counters[entry.type]++;
      const typeIndex = counters[entry.type];
      const name = entry.name ?? `${cfg.shortName} ${String(typeIndex).padStart(2, '0')}`;
      const pos = cellCenter(entry.cell);
      const waterCapacity = cfg.waterCapacity;
      return {
        id: entry.id,
        type: entry.type,
        name,
        pos,
        anchor: cellCenter(entry.cell),
        water: waterCapacity,
        waterCapacity,
        state: '待命',
        task: { kind: 'patrol' },
        path: [],
        pathIndex: 0,
        pathAge: 0,
        action: '已在部署点就位',
        btNode: 'idle',
        cooldown: 0,
        resupplyDwell: 0,
        distressTimer: 0,
        distressCooldown: 0,
        distressEpisode: false,
        retreatCooldown: 0,
        sprayProgress: 0,
        drops: 0,
        distanceTravelled: 0,
        lost: false,
        assignedBreak: null,
        targetCell: null,
        lastPathFailed: false,
      };
    });
  }

  private updateWind(dt: number): void {
    this.wind = this.windAt(this.time);
    for (let index = 0; index < this.scenario.windEvents.length; index++) {
      const event = this.scenario.windEvents[index];
      if (!this.warnedEvents.has(index) && event.warnSec > 0 && this.time >= event.atSec - event.warnSec) {
        this.warnedEvents.add(index);
        this.emit(
          'warning',
          `阵风预警：${event.label}，约 ${event.warnSec} 秒后转为 ${compassLabel(event.fromDeg)}风 ${event.speed.toFixed(1)} m/s。提前调整隔离带与单位位置。`,
        );
      }
      if (!this.startedEvents.has(index) && this.time >= event.atSec) {
        this.startedEvents.add(index);
        this.windShiftCount++;
        this.emit(
          'danger',
          `风向突变：${event.label}，转 ${compassLabel(event.fromDeg)}风 ${event.speed.toFixed(1)} m/s。火头可能快速偏转。`,
        );
      }
    }
    void dt;
  }

  private spreadChance(source: Cell, target: Cell, directionX: number, directionY: number): number {
    void directionX;
    void directionY;
    return computeSpreadChance(this.config, source, target, this.wind);
  }

  private spreadStep(interval: number): void {
    const burning: Cell[] = [];
    for (const row of this.map.cells) {
      for (const cell of row) if (cell.fire === 1) burning.push(cell);
    }
    if (burning.length === 0) return;

    for (const source of burning) {
      if (source.intensity < 0.06) continue;
      for (const [dx, dy] of DIRECTIONS) {
        const target = this.cellAt(source.x + dx, source.y + dy);
        if (!target || target.fire !== 0) continue;
        const chance = this.spreadChance(source, target, dx, dy);
        if (chance <= 0) continue;
        if (this.rng.chance(chance)) {
          this.igniteCell(target, 0.08 + Math.min(0.26, source.intensity * 0.22), false);
        }
        if (target.firebreak) {
          // A completed break is a hard stop; the probability check above is defensive only.
          target.fire = 0;
        }
      }

      if (
        this.wind.speed >= this.config.fire.spotting.minWindSpeed &&
        source.intensity >= this.config.fire.spotting.intensityThreshold &&
        this.rng.chance(this.config.fire.spotting.chancePerBurningCellPerSec * interval)
      ) {
        const distance = 2 + Math.floor(this.rng.next() * Math.max(1, this.config.fire.spotting.maxDistanceCells - 1));
        const jitter = (this.rng.next() * 2 - 1) * 18;
        const bearing = ((this.wind.fromDeg + 180 + jitter) + 360) % 360;
        const dx = Math.round(Math.sin(bearing * Math.PI / 180) * distance);
        const dy = -Math.round(Math.cos(bearing * Math.PI / 180) * distance);
        const target = this.cellAt(source.x + dx, source.y + dy);
        if (target && target.fire === 0 && target.fuel > 0 && target.terrain !== 'water' && target.terrain !== 'cliff' && !target.firebreak) {
          this.igniteCell(target, 0.12, false);
          if (this.time - this.lastSpotEvent > 12) {
            this.lastSpotEvent = this.time;
            this.emit('danger', `飞火：东南强风将燃烧物吹至 ${this.cellLabel(target)}，形成新火点。`, target);
          }
        }
      }
    }
  }

  private igniteCell(cell: Cell, intensity: number, backfire: boolean): void {
    if (cell.fire !== 0 || cell.firebreak || cell.fuel <= 0) return;
    cell.fire = 1;
    cell.intensity = Math.min(1, intensity);
    cell.burningTime = 0;
    cell.ignitionAt = this.time;
    cell.backfire = backfire;
    if (cell.asset) {
      this.emit('danger', `火线已进入 ${cell.asset.name}！`, cell);
    }
  }

  private updateFireCells(dt: number): void {
    for (const row of this.map.cells) {
      for (const cell of row) {
        if (cell.fire === 1) {
          cell.burningTime += dt;
          cell.intensity = Math.min(1, cell.intensity + this.config.fire.intensityGrowthPerSec * dt * (0.55 + cell.fuel));
          const duration = this.config.fire.burnDurationSec * (0.82 + cell.fuel * 0.32);
          if (cell.burningTime >= duration) {
            this.burnOut(cell, false);
          }
        } else if (cell.fire === 2) {
          cell.intensity = Math.max(0, cell.intensity - dt * 0.18);
        }
      }
    }
  }

  private updateWetness(dt: number): void {
    for (const row of this.map.cells) {
      for (const cell of row) {
        if (cell.wetness > 0) {
          cell.wetness = Math.max(0, cell.wetness - this.config.suppression.wetnessDryRatePerSec * dt);
        }
      }
    }
  }

  private burnOut(cell: Cell, suppressed: boolean): void {
    if (cell.fire !== 1) return;
    cell.fire = 2;
    cell.intensity = 0;
    cell.burnedAt = this.time;
    const index = cell.y * this.map.cols + cell.x;
    if (!this.burnedIndices.has(index)) {
      this.burnedIndices.add(index);
    }
    if (suppressed) {
      this.suppressedCount++;
      if (this.time - this.lastSuppressEvent > 4) {
        this.lastSuppressEvent = this.time;
        this.emit('success', `扑火单位在 ${this.cellLabel(cell)} 压制一处明火。`, cell);
      }
    }
    if (cell.asset && !this.lostAssetIds.has(cell.asset.id)) {
      this.lostAssetIds.add(cell.asset.id);
      this.emit('danger', `${cell.asset.name} 已被火线吞没。`, cell);
    }
  }

  private updateUnits(dt: number): void {
    for (const unit of this.units) {
      if (unit.lost) continue;
      unit.pathAge += dt;
      unit.cooldown = Math.max(0, unit.cooldown - dt);
      unit.retreatCooldown = Math.max(0, unit.retreatCooldown - dt);
      unit.distressCooldown = Math.max(0, unit.distressCooldown - dt);
      if (unit.distressEpisode && !this.isTrapped(unit)) {
        unit.distressTimer = Math.max(0, unit.distressTimer - dt * 2);
        if (unit.distressCooldown <= 0) unit.distressEpisode = false;
      }
      const ctx: AIContext = { unit, dt, hooks: this.hooks };
      this.tree.tick(ctx);
      if (unit.water < 0) unit.water = 0;
    }
  }

  private updateContainment(dt: number): void {
    let burning = 0;
    for (const row of this.map.cells) {
      for (const cell of row) if (cell.fire === 1) burning++;
    }
    this.burningCellsCount = burning;
    if (burning === 0) {
      this.containedFor += dt;
      if (this.containedFor >= this.config.rating.containmentStabilitySec && this.time > 12) {
        this.finish();
      }
    } else {
      this.containedFor = 0;
    }
    this.peakBurning = Math.max(this.peakBurning, burning);
  }

  private recordTimeline(initial = false): void {
    const point: FireStatsPoint = {
      time: this.time,
      burnedHa: this.burnedHa,
      burning: this.burningCellsCount,
      containedPct: Math.max(0, Math.min(100, 100 - this.burnedHa / Math.max(1, this.scenario.maxBurnedHa) * 100)),
    };
    if (initial || this.timeline.length === 0) {
      this.timeline.push(point);
    } else {
      this.timeline.push(point);
    }
  }

  private finish(): void {
    if (this.finished) return;
    let burning = 0;
    for (const row of this.map.cells) {
      for (const cell of row) if (cell.fire === 1) burning++;
    }
    this.burningCellsCount = burning;
    this.recordTimeline();
    const outcome = burning === 0 ? 'contained' : 'timeout';
    const burnedHa = this.burnedHa;
    const burnedRatio = burnedHa / Math.max(1, this.scenario.maxBurnedHa);
    const lostAssets = this.lostAssetIds.size;
    let stars = 0;
    if (outcome === 'contained') {
      if (
        burnedRatio <= this.config.rating.threeStarBurnRatio &&
        (!this.config.rating.threeStarRequiresAllAssets || lostAssets === 0)
      ) {
        stars = 3;
      } else if (burnedRatio <= this.config.rating.twoStarBurnRatio) {
        stars = 2;
      } else if (burnedRatio <= this.config.rating.passBurnRatio) {
        stars = 1;
      }
    } else if (burnedRatio <= this.config.rating.passBurnRatio && lostAssets < this.scenario.assets.length) {
      stars = 1;
    }
    if (this.scenario.assets.length > 0 && lostAssets >= this.scenario.assets.length) stars = 0;

    const notes: string[] = [];
    if (outcome === 'contained') notes.push('明火已全部扑灭，火场实现阶段性控制。');
    else notes.push('推演时限结束时仍有明火，火场未完全控制。');
    if (lostAssets > 0) notes.push(`有 ${lostAssets} 处设施被火线吞没，设施保护出现缺口。`);
    if (this.distressCount > 0) notes.push(`共收到 ${this.distressCount} 次被困求救，建议复盘单位避险路线。`);
    if (this.windShiftCount > 0) notes.push(`遭遇 ${this.windShiftCount} 次风向突变，隔离带需要预留转向余量。`);
    if (this.firebreakCount > 0) notes.push(`地面队伍完成 ${this.firebreakCount} 格隔离带。`);
    if (this.backfireIgnitions > 0) notes.push(`实施 ${this.backfireIgnitions} 处逆火，需核对回烧是否越过控制线。`);
    if (this.waterUsed > 0) notes.push(`累计消耗水量 ${Math.round(this.waterUsed / 100) / 10} 吨。`);

    const result: MissionResult = {
      id: `${this.scenario.id}-${this.scenario.seed}-${Math.round(this.time)}-${this.deployment.units.length}`,
      missionId: this.scenario.id,
      missionName: this.scenario.name,
      scenarioCode: this.scenario.code,
      scenarioSnapshot: JSON.parse(JSON.stringify(this.scenario)) as ScenarioConfig,
      startedAt: this.startedAt,
      finishedAt: nowIso(),
      durationSec: this.time,
      outcome,
      stars,
      burnedCells: this.burnedIndices.size,
      burnedHa,
      maxBurnedHa: this.scenario.maxBurnedHa,
      containedPct: Math.max(0, Math.min(100, 100 - burnedRatio * 100)),
      assetsTotal: this.scenario.assets.length,
      assetsProtected: this.assetsProtected,
      unitsDeployed: this.units.length,
      unitsLost: this.units.filter((unit) => unit.lost).length,
      distressCount: this.distressCount,
      waterUsed: this.waterUsed,
      firebreakCells: this.firebreakCount,
      backfireCells: this.backfireIgnitions,
      suppressedCells: this.suppressedCount,
      windShiftCount: this.windShiftCount,
      peakBurningCells: this.peakBurning,
      events: [...this.events],
      timeline: [...this.timeline],
      burnedCellIndices: [...this.burnedIndices],
      deployment: this.deployment,
      notes,
      seed: this.scenario.seed,
    };
    this.result = result;
    this.finished = true;
    this.emit(
      stars >= 2 ? 'success' : 'warning',
      `推演结束：${outcome === 'contained' ? '明火扑灭' : '时限结束'}，过火 ${burnedHa.toFixed(1)} 公顷，评级 ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}。`,
    );
    result.events = [...this.events];
  }

  private cellAt(x: number, y: number): Cell | null {
    const rx = Math.floor(x);
    const ry = Math.floor(y);
    if (rx < 0 || ry < 0 || rx >= this.map.cols || ry >= this.map.rows) return null;
    return this.map.cells[ry][rx];
  }

  private nearestBurning(unit: Unit, maxDistance: number): { cell: Cell; distance: number } | null {
    let best: { cell: Cell; distance: number } | null = null;
    const radius = Math.ceil(maxDistance);
    const cx = Math.floor(unit.pos.x);
    const cy = Math.floor(unit.pos.y);
    for (let y = Math.max(0, cy - radius); y <= Math.min(this.map.rows - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(this.map.cols - 1, cx + radius); x++) {
        const cell = this.map.cells[y][x];
        if (cell.fire !== 1) continue;
        const distance = euclidean(unit.pos.x, unit.pos.y, x + 0.5, y + 0.5);
        if (distance <= maxDistance && (!best || distance < best.distance)) best = { cell, distance };
      }
    }
    return best;
  }

  private nearestBurningDistance(unit: Unit, maxDistance = 8): number {
    const nearest = this.nearestBurning(unit, maxDistance);
    return nearest ? nearest.distance : 99;
  }

  private countFireNear(unit: Unit, radius: number): number {
    let count = 0;
    const cx = Math.floor(unit.pos.x);
    const cy = Math.floor(unit.pos.y);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > radius) continue;
        const cell = this.cellAt(cx + dx, cy + dy);
        if (cell?.fire === 1) count++;
      }
    }
    return count;
  }

  private isTrapped(unit: Unit): boolean {
    if (this.config.units[unit.type].canFly) return false;
    const burningNear = this.countFireNear(unit, this.config.behavior.trappedFireRadius);
    if (burningNear >= 5) return true;
    const nearest = this.nearestBurningDistance(unit, 2);
    if (nearest <= 0.95) {
      const cx = Math.floor(unit.pos.x);
      const cy = Math.floor(unit.pos.y);
      let open = 0;
      for (const [dx, dy] of DIRECTIONS) {
        const cell = this.cellAt(cx + dx, cy + dy);
        if (cell && cell.fire !== 1 && cell.terrain !== 'water' && cell.terrain !== 'cliff') open++;
      }
      return open <= 2;
    }
    return false;
  }

  private isLowWater(unit: Unit): boolean {
    if (unit.lost) return false;
    return unit.water <= unit.waterCapacity * this.config.behavior.lowWaterThreshold;
  }

  private isInDanger(unit: Unit): boolean {
    if (this.config.units[unit.type].canFly || unit.lost) return false;
    const nearest = this.nearestBurningDistance(unit, this.config.behavior.dangerRadiusCells + 0.5);
    if (nearest <= this.config.behavior.unsafeFireRadius) return true;
    if (this.countFireNear(unit, 1) >= 3) return true;
    if (unit.water <= 1 && nearest <= this.config.behavior.dangerRadiusCells) return true;
    return false;
  }

  private hasPlayerCommand(unit: Unit): boolean {
    return Boolean(unit.task.requestedByPlayer) && !unit.lost && unit.task.kind !== 'idle';
  }

  private hasFireNearby(unit: Unit): boolean {
    const radius = this.config.units[unit.type].detectionRadius;
    return this.nearestBurning(unit, radius) !== null;
  }

  private hasBreakWork(unit: Unit): boolean {
    if (!this.config.units[unit.type].canDig || unit.lost) return false;
    if (unit.assignedBreak) {
      const cell = this.cellAt(unit.assignedBreak.x, unit.assignedBreak.y);
      if (cell && cell.plannedBreak && !cell.firebreak) return true;
      unit.assignedBreak = null;
    }
    for (const row of this.map.cells) {
      for (const cell of row) {
        if (cell.plannedBreak && !cell.firebreak && cell.fire !== 1) {
          const key = `${cell.x},${cell.y}`;
          if (!this.breakClaims.has(key) || this.breakClaims.get(key) === unit.id) return true;
        }
      }
    }
    return false;
  }

  private runDistress(unit: Unit, dt: number): BTStatus {
    unit.state = '被困求救';
    if (!unit.distressEpisode) {
      unit.distressEpisode = true;
      unit.distressTimer = 0;
      unit.distressCooldown = this.config.behavior.distressCooldownSec;
      this.distressCount++;
      this.emit('danger', `SOS：${this.unitDisplayName(unit)} 在 ${this.unitGridLabel(unit)} 被火线围困，请求支援！`, undefined, unit.id);
    }
    unit.distressTimer += dt;
    if (unit.distressCooldown <= 0) {
      unit.distressCooldown = this.config.behavior.distressCooldownSec;
      this.emit('danger', `${this.unitDisplayName(unit)} 再次发出求救坐标 ${this.unitGridLabel(unit)}。`, undefined, unit.id);
    }
    if (unit.distressTimer > this.config.behavior.lostAfterDistressSec) {
      unit.lost = true;
      unit.state = '失联';
      unit.action = '失去联络';
      unit.task = { kind: 'idle' };
      if (unit.assignedBreak) this.releaseBreakAssignment(unit);
      this.emit('danger', `${this.unitDisplayName(unit)} 已失联，退出推演。`, undefined, unit.id);
      return BTStatus.Failure;
    }
    if (unit.assignedBreak) this.releaseBreakAssignment(unit);
    const target = this.findSafeCell(unit);
    unit.action = target ? '寻找突围空隙，向安全地域机动' : '原地构筑避险点，等待救援';
    if (target) {
      const moved = this.moveTo(unit, target, dt, 0.3);
      if (moved) unit.action = '已脱离火线围困';
    }
    return BTStatus.Running;
  }

  private runRetreat(unit: Unit, dt: number, forced: boolean): BTStatus {
    if (!forced && !this.isInDanger(unit)) return BTStatus.Success;
    if (unit.assignedBreak) this.releaseBreakAssignment(unit);
    const target = this.findSafeCell(unit);
    if (!target) {
      unit.state = '避险';
      unit.action = '被火线封堵，等待救援';
      return BTStatus.Running;
    }
    unit.state = '避险';
    unit.task = { kind: 'retreat', target, requestedByPlayer: unit.task.requestedByPlayer, label: '撤向安全地域' };
    unit.action = `撤向安全地域 ${target.x},${target.y}`;
    const arrived = this.moveTo(unit, target, dt, 0.4);
    if (arrived) {
      unit.retreatCooldown = this.config.behavior.retreatCooldownSec;
      unit.state = '待命';
      unit.action = '已到达安全地域';
      if (forced) {
        unit.task = { kind: 'idle' };
        this.emit('info', `${this.unitDisplayName(unit)} 已撤至安全地域。`, undefined, unit.id);
      }
      return BTStatus.Success;
    }
    return BTStatus.Running;
  }

  private findSafeCell(unit: Unit): { x: number; y: number } | null {
    const flying = this.config.units[unit.type].canFly;
    const base = this.map.scenario.base;
    const path = this.findPathFor(unit, base, flying);
    if (path) return base;
    const candidate = findRetreatCell(
      this.map,
      unit.pos,
      flying,
      this.config.behavior.safeSearchRadiusCells,
    );
    if (!candidate) return null;
    if (!this.findPathFor(unit, candidate, flying)) return null;
    return candidate;
  }

  private runResupply(unit: Unit, dt: number): BTStatus {
    unit.state = '补水';
    const cfg = this.config.units[unit.type];
    if (unit.water >= unit.waterCapacity - 0.5) {
      unit.task = { kind: 'idle' };
      unit.state = '待命';
      return BTStatus.Success;
    }
    let target = unit.task.kind === 'resupply' ? unit.task.target ?? null : null;
    if (!target) {
      target = this.findRefillTarget(unit);
      if (!target) {
        unit.action = '附近没有可达水源，无法补水';
        unit.state = '待命';
        unit.task = { kind: 'idle' };
        return BTStatus.Failure;
      }
    }
    if (!unit.task.target || unit.task.kind !== 'resupply') {
      unit.task = { kind: 'resupply', target, label: '前往水源补水' };
      unit.targetCell = null;
      unit.path = [];
    }
    unit.action = `前往水源补水（${Math.round(unit.water / Math.max(1, cfg.waterCapacity) * 100)}%）`;
    const arrived = this.moveTo(unit, target, dt, cfg.canFly ? 0.8 : 0.35);
    if (!arrived) return BTStatus.Running;
    unit.resupplyDwell += dt;
    if (unit.resupplyDwell >= this.config.behavior.resupplyDwellSec) {
      unit.water = unit.waterCapacity;
      unit.waterCapacity = cfg.waterCapacity;
      unit.resupplyDwell = 0;
      unit.state = '待命';
      unit.action = '补水完成，返回任务';
      unit.task = { kind: 'idle' };
      return BTStatus.Success;
    }
    unit.state = '补水';
    unit.action = `正在补水 ${Math.round(unit.resupplyDwell / this.config.behavior.resupplyDwellSec * 100)}%`;
    return BTStatus.Running;
  }

  private findRefillTarget(unit: Unit): { x: number; y: number } | null {
    const cfg = this.config.units[unit.type];
    if (cfg.canFly) {
      return nearestWaterSource(this.map, unit.pos, true);
    }
    const source = nearestWaterSource(this.map, unit.pos, false);
    if (source && this.findPathFor(unit, source, false)) return source;
    const base = this.map.scenario.base;
    if (this.findPathFor(unit, base, false)) return base;
    return null;
  }

  private runCommand(unit: Unit, dt: number): BTStatus {
    const task = unit.task;
    if (!task.requestedByPlayer) return BTStatus.Success;
    if (task.kind === 'retreat') {
      return this.runRetreat(unit, dt, true);
    }
    if (task.kind === 'move' && task.target) {
      unit.state = '机动';
      unit.action = `前往 ${task.target.x},${task.target.y}`;
      if (this.moveTo(unit, task.target, dt, 0.25)) {
        this.completePlayerTask(unit, '已到达指定位置');
      }
      return BTStatus.Running;
    }
    if (task.kind === 'drop' && task.target) {
      return this.executeDropCommand(unit, task.target, dt);
    }
    // Commands whose target disappeared fall back to autonomous behavior.
    this.completePlayerTask(unit, '指令目标已失效，转自主行动');
    return BTStatus.Success;
  }

  private executeDropCommand(unit: Unit, target: { x: number; y: number }, dt: number): BTStatus {
    const cfg = this.config.units[unit.type];
    const targetCenter = cellCenter(target);
    if (cfg.canFly) {
      const targetCell = this.cellAt(target.x, target.y);
      if (!targetCell) {
        this.completePlayerTask(unit, '洒水目标无效');
        return BTStatus.Failure;
      }
      if (unit.water < ('bucketSize' in cfg ? cfg.bucketSize : 0)) {
        this.completePlayerTask(unit, '水量不足，转自主补水');
        return BTStatus.Failure;
      }
      unit.state = '吊桶作业';
      unit.action = `飞往 ${target.x},${target.y} 执行吊桶投水`;
      const distance = euclidean(unit.pos.x, unit.pos.y, targetCenter.x, targetCenter.y);
      if (distance > this.config.suppression.helicopterDropRadius) {
        const moved = this.moveTo(unit, targetCenter, dt, this.config.suppression.helicopterDropRadius - 0.15);
        if (!moved) return BTStatus.Running;
      }
      this.dropBucketAt(unit, targetCell);
      this.completePlayerTask(unit, '吊桶投水完成');
      return BTStatus.Running;
    }
    const cell = this.cellAt(target.x, target.y);
    if (!cell) {
      this.completePlayerTask(unit, '洒水目标无效');
      return BTStatus.Failure;
    }
    const surfaceCfg = cfg as GroundUnitConfig;
    const range = surfaceCfg.sprayRange;
    if (euclidean(unit.pos.x, unit.pos.y, targetCenter.x, targetCenter.y) > range) {
      const pos = this.findGroundSprayPosition(unit, cell, range);
      if (!pos) {
        this.completePlayerTask(unit, '目标不可达');
        return BTStatus.Failure;
      }
      unit.state = '机动';
      unit.action = `机动至 ${pos.x},${pos.y} 执行洒水`;
      if (!this.moveTo(unit, pos, dt, 0.3)) return BTStatus.Running;
    }
    unit.state = '扑救';
    unit.action = `执行玩家洒水指令 ${target.x},${target.y}`;
    this.applySpray(unit, cell, dt);
    this.setWetArea(cell, this.config.suppression.truckWetRadius, 0.4);
    this.completePlayerTask(unit, '洒水完毕');
    return BTStatus.Running;
  }

  private runBreak(unit: Unit, dt: number): BTStatus {
    const cfg = this.config.units[unit.type];
    if (!cfg.canDig) return BTStatus.Failure;
    if (!unit.assignedBreak || !this.breakCellValid(unit.assignedBreak)) {
      const target = this.claimBreakCell(unit);
      if (!target) return BTStatus.Failure;
      unit.assignedBreak = target;
      unit.targetCell = null;
      unit.path = [];
    }
    const target = unit.assignedBreak;
    if (!target) return BTStatus.Failure;
    const cell = this.cellAt(target.x, target.y);
    if (!cell) {
      this.releaseBreakAssignment(unit);
      return BTStatus.Failure;
    }
    if (cell.fire === 1) {
      cell.plannedBreak = false;
      this.releaseBreakAssignment(unit);
      this.emit('warning', `隔离带计划点 ${this.cellLabel(cell)} 已被火线吞没。`, cell, unit.id);
      return BTStatus.Failure;
    }
    unit.state = '开挖隔离带';
    const center = cellCenter(target);
    unit.action = `前往 ${target.x},${target.y} 开挖隔离带`;
    const distance = euclidean(unit.pos.x, unit.pos.y, center.x, center.y);
    if (distance > 0.32) {
      const arrived = this.moveTo(unit, center, dt, 0.3);
      if (!arrived) return BTStatus.Running;
    }
    unit.state = '开挖隔离带';
    unit.action = `开挖隔离带 ${Math.round(cell.breakProgress * 100)}%`;
    cell.breakProgress = Math.min(1, cell.breakProgress + cfg.digRate * this.config.suppression.firebreakProgressPerSec * dt);
    if (cell.breakProgress >= 1) {
      cell.breakProgress = 1;
      cell.firebreak = true;
      cell.plannedBreak = false;
      cell.fuel = 0;
      cell.moisture = Math.max(cell.moisture, 0.65);
      this.firebreakCount++;
      this.releaseBreakAssignment(unit);
      this.emit('success', `${this.unitDisplayName(unit)} 完成 ${this.cellLabel(cell)} 隔离带开挖。`, cell, unit.id);
      return BTStatus.Success;
    }
    return BTStatus.Running;
  }

  private runFight(unit: Unit, dt: number): BTStatus {
    const cfg = this.config.units[unit.type];
    const near = this.chooseFightTarget(unit, cfg.detectionRadius);
    if (!near) return BTStatus.Failure;
    const isHeli = cfg.canFly;
    if (isHeli) {
      const helicopter = cfg as typeof cfg & { bucketSize: number; dropCooldownSec: number };
      if (unit.water < helicopter.bucketSize) return BTStatus.Failure;
      unit.state = '吊桶作业';
      unit.action = `锁定 ${this.cellLabel(near.cell)} 火点，准备吊桶投水`;
      if (unit.cooldown > 0) {
        unit.action = `吊桶冷却 ${unit.cooldown.toFixed(1)}s`;
        return BTStatus.Running;
      }
      if (near.distance > this.config.suppression.helicopterDropRadius) {
        const moved = this.moveTo(unit, cellCenter(near.cell), dt, this.config.suppression.helicopterDropRadius - 0.2);
        if (!moved) return BTStatus.Running;
      }
      this.dropBucketAt(unit, near.cell);
      return BTStatus.Running;
    }
    const range = (cfg as GroundUnitConfig).sprayRange;
    if (near.distance > range) {
      const pos = this.findGroundSprayPosition(unit, near.cell, range);
      if (!pos) return BTStatus.Failure;
      unit.state = '机动';
      unit.action = `向 ${this.cellLabel(near.cell)} 火线抵近`;
      if (!this.moveTo(unit, pos, dt, 0.3)) return BTStatus.Running;
    }
    unit.state = '扑救';
    unit.action = `压制 ${this.cellLabel(near.cell)} 火点`;
    this.applySpray(unit, near.cell, dt);
    this.setWetArea(near.cell, this.config.suppression.truckWetRadius, this.config.suppression.wettedMoisture * 0.7);
    return BTStatus.Running;
  }

  private runIdle(unit: Unit, dt: number): BTStatus {
    const cfg = this.config.units[unit.type];
    unit.state = '待命';
    unit.task = { kind: 'patrol' };
    unit.assignedBreak = null;
    const distance = euclidean(unit.pos.x, unit.pos.y, unit.anchor.x, unit.anchor.y);
    if (distance > this.config.behavior.unitIdleRadiusCells) {
      unit.state = '机动';
      unit.action = '返回部署点警戒';
      this.moveTo(unit, unit.anchor, dt, 0.5);
    } else {
      unit.action = `在部署点警戒（水 ${Math.round(unit.water / Math.max(1, unit.waterCapacity) * 100)}%）`;
    }
    return BTStatus.Running;
  }

  private dropBucketAt(unit: Unit, target: Cell): void {
    const cfg = this.config.units[unit.type];
    if (!('bucketSize' in cfg)) return;
    if (unit.water < cfg.bucketSize) return;
    unit.water -= cfg.bucketSize;
    this.waterUsed += cfg.bucketSize;
    unit.cooldown = cfg.dropCooldownSec;
    unit.drops++;
    const radius = this.config.suppression.helicopterDropRadius;
    const cx = target.x;
    const cy = target.y;
    const cut = this.config.suppression.helicopterDropIntensityCut;
    const wet = this.config.suppression.helicopterDropWetness;
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
        const cell = this.cellAt(cx + dx, cy + dy);
        if (!cell) continue;
        if (cell.terrain === 'water' || cell.terrain === 'cliff') continue;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        const falloff = 1 - d / (radius + 0.1) * 0.55;
        cell.wetness = Math.max(cell.wetness, wet * falloff);
        if (cell.fire === 1) {
          cell.intensity = Math.max(0, cell.intensity - cut * falloff);
          if (cell.intensity <= this.config.suppression.extinguishIntensity) this.burnOut(cell, true);
        }
      }
    }
    this.emit('success', `${this.unitDisplayName(unit)} 在 ${this.cellLabel(target)} 完成吊桶投水（余水 ${Math.round(unit.water)}L）。`, target, unit.id);
  }

  private applySpray(unit: Unit, cell: Cell, dt: number): void {
    const cfg = this.config.units[unit.type] as GroundUnitConfig;
    if (unit.water <= 0) {
      unit.state = '待命';
      return;
    }
    const consumption = Math.min(unit.water, cfg.sprayRate * dt);
    unit.water -= consumption;
    this.waterUsed += consumption;
    const strength = cfg.suppressPower * dt * this.config.suppression.sprayEfficiency;
    if (cell.fire === 1) {
      cell.intensity = Math.max(0, cell.intensity - strength);
      cell.wetness = Math.max(cell.wetness, this.config.suppression.wettedMoisture * 0.5);
      if (cell.intensity <= this.config.suppression.extinguishIntensity) {
        this.burnOut(cell, true);
      }
    } else {
      cell.wetness = Math.max(cell.wetness, this.config.suppression.wettedMoisture * 0.3);
    }
    unit.sprayProgress += dt;
    if (unit.water <= 0.5) {
      unit.action = '水量耗尽，准备补水';
    }
  }

  private setWetArea(center: Cell, radius: number, amount: number): void {
    if (radius <= 0) return;
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
        const cell = this.cellAt(center.x + dx, center.y + dy);
        if (!cell || cell.terrain === 'water' || cell.terrain === 'cliff') continue;
        if (Math.hypot(dx, dy) <= radius) cell.wetness = Math.max(cell.wetness, amount);
      }
    }
  }

  private chooseFightTarget(unit: Unit, maxDistance: number): { cell: Cell; distance: number } | null {
    const cfg = this.config.units[unit.type];
    const candidates: { cell: Cell; distance: number; score: number }[] = [];
    const radius = Math.ceil(maxDistance);
    const cx = Math.floor(unit.pos.x);
    const cy = Math.floor(unit.pos.y);
    for (let y = Math.max(0, cy - radius); y <= Math.min(this.map.rows - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(this.map.cols - 1, cx + radius); x++) {
        const cell = this.map.cells[y][x];
        if (cell.fire !== 1) continue;
        if (cfg.canFly && cell.intensity < this.config.behavior.heliMinDropIntensity) continue;
        const distance = euclidean(unit.pos.x, unit.pos.y, x + 0.5, y + 0.5);
        if (distance > maxDistance) continue;
        let exposure = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue;
            const other = this.cellAt(x + dx, y + dy);
            if (other?.fire === 1) exposure++;
          }
        }
        const approachPenalty = cfg.canFly ? 0 : exposure * 0.45;
        candidates.push({ cell, distance, score: distance + approachPenalty + (cell.intensity > 0.65 ? 2 : 0) });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0] ? { cell: candidates[0].cell, distance: candidates[0].distance } : null;
  }

  private findGroundSprayPosition(unit: Unit, fireCell: Cell, range: number): { x: number; y: number } | null {
    const candidates: { x: number; y: number; score: number }[] = [];
    const radius = Math.ceil(range + 0.2);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.hypot(dx, dy) > range + 0.1) continue;
        const x = fireCell.x + dx;
        const y = fireCell.y + dy;
        const cell = this.cellAt(x, y);
        if (!cell) continue;
        if (cell.fire === 1 || cell.terrain === 'water' || cell.terrain === 'cliff') continue;
        let exposure = 0;
        for (let ey = -1; ey <= 1; ey++) {
          for (let ex = -1; ex <= 1; ex++) {
            if (ex === 0 && ey === 0) continue;
            const adjacent = this.cellAt(x + ex, y + ey);
            if (adjacent?.fire === 1) exposure++;
          }
        }
        candidates.push({
          x,
          y,
          score: euclidean(unit.pos.x, unit.pos.y, x + 0.5, y + 0.5) + exposure * 2.4,
        });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const candidate of candidates.slice(0, 6)) {
      const path = this.findPathFor(unit, candidate, false);
      if (path) return candidate;
    }
    return null;
  }

  private findPathFor(unit: Unit, target: { x: number; y: number }, flying: boolean): { x: number; y: number }[] | null {
    return findPath(
      this.map,
      unit.pos,
      target,
      { flying, avoidFire: !flying, dangerPenalty: 5.5, maxNodes: this.map.cols * this.map.rows * 2 },
    );
  }

  private ensurePath(unit: Unit, target: { x: number; y: number }, force = false): boolean {
    const tx = Math.round(target.x);
    const ty = Math.round(target.y);
    const flying = this.config.units[unit.type].canFly;
    const sameTarget = unit.targetCell?.x === tx && unit.targetCell?.y === ty;
    const pathInvalidated = !sameTarget || force;
    if (
      pathInvalidated ||
      (unit.path.length === 0 && !unit.lastPathFailed) ||
      (unit.path.length > 0 && unit.pathAge >= this.config.behavior.pathReplanSec)
    ) {
      unit.targetCell = { x: tx, y: ty };
      unit.path = [];
      unit.pathIndex = 0;
      const path = this.findPathFor(unit, { x: tx, y: ty }, flying);
      unit.lastPathFailed = !path;
      if (path) {
        const first = path[0];
        if (path.length > 1) {
          unit.path = path.slice(1).map(cellCenter);
        } else {
          unit.path = [cellCenter({ x: tx, y: ty })];
        }
        unit.pathIndex = 0;
      }
      unit.pathAge = 0;
    }
    if (unit.lastPathFailed && unit.pathAge < this.config.behavior.pathReplanSec) return false;
    if (unit.path.length > 0) {
      for (let i = unit.pathIndex; i < Math.min(unit.path.length, unit.pathIndex + 2); i++) {
        const point = unit.path[i];
        const cell = this.cellAt(point.x, point.y);
        if (cell?.fire === 1 && !this.config.units[unit.type].canFly) {
          force = true;
          break;
        }
      }
      if (force) {
        const path = this.findPathFor(unit, { x: tx, y: ty }, flying);
        unit.lastPathFailed = !path;
        unit.path = path ? path.slice(1).map(cellCenter) : [];
        unit.pathIndex = 0;
        unit.pathAge = 0;
        if (!path) return false;
      }
    }
    return true;
  }

  private moveTo(unit: Unit, target: { x: number; y: number }, dt: number, stopDistance = 0.25): boolean {
    const center = target.x === Math.round(target.x) ? cellCenter(target) : target;
    if (euclidean(unit.pos.x, unit.pos.y, center.x, center.y) <= stopDistance) {
      unit.path = [];
      unit.pathIndex = 0;
      return true;
    }
    if (!this.ensurePath(unit, target)) return false;
    const cfg = this.config.units[unit.type];
    const currentCell = this.cellAt(unit.pos.x, unit.pos.y);
    let speedFactor = 1;
    if (!cfg.canFly && currentCell) {
      speedFactor = this.config.terrain[currentCell.terrain]?.speedFactor ?? 1;
    }
    let distanceBudget = cfg.speedCellsPerSec * speedFactor * dt;
    if (distanceBudget <= 0) return false;
    let guard = 0;
    while (distanceBudget > 0.0001 && unit.pathIndex < unit.path.length && guard++ < 30) {
      const next = unit.path[unit.pathIndex];
      const dx = next.x - unit.pos.x;
      const dy = next.y - unit.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= distanceBudget) {
        unit.pos.x = next.x;
        unit.pos.y = next.y;
        unit.distanceTravelled += dist;
        distanceBudget -= dist;
        unit.pathIndex++;
      } else {
        unit.pos.x += dx / dist * distanceBudget;
        unit.pos.y += dy / dist * distanceBudget;
        unit.distanceTravelled += distanceBudget;
        distanceBudget = 0;
      }
    }
    if (unit.pathIndex >= unit.path.length) {
      unit.path = [];
      unit.pathIndex = 0;
      return euclidean(unit.pos.x, unit.pos.y, center.x, center.y) <= stopDistance + 0.05;
    }
    return false;
  }

  private claimBreakCell(unit: Unit): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestScore = Infinity;
    for (const row of this.map.cells) {
      for (const cell of row) {
        if (!cell.plannedBreak || cell.firebreak || cell.fire === 1) continue;
        const key = `${cell.x},${cell.y}`;
        if (this.breakClaims.has(key) && this.breakClaims.get(key) !== unit.id) continue;
        if (cell.terrain === 'water' || cell.terrain === 'cliff') continue;
        const score = euclidean(unit.pos.x, unit.pos.y, cell.x + 0.5, cell.y + 0.5);
        if (score < bestScore) {
          bestScore = score;
          best = { x: cell.x, y: cell.y };
        }
      }
    }
    if (best) this.breakClaims.set(`${best.x},${best.y}`, unit.id);
    return best;
  }

  private breakCellValid(point: { x: number; y: number }): boolean {
    const cell = this.cellAt(point.x, point.y);
    return Boolean(cell && cell.plannedBreak && !cell.firebreak && cell.fire !== 1);
  }

  private releaseBreakAssignment(unit: Unit): void {
    if (!unit.assignedBreak) return;
    const key = `${unit.assignedBreak.x},${unit.assignedBreak.y}`;
    if (this.breakClaims.get(key) === unit.id) this.breakClaims.delete(key);
    unit.assignedBreak = null;
  }

  private completePlayerTask(unit: Unit, message: string): void {
    unit.task = { kind: 'idle' };
    unit.state = '待命';
    unit.action = message;
    unit.path = [];
    unit.targetCell = null;
    this.emit('info', `${this.unitDisplayName(unit)}：${message}。`, undefined, unit.id);
  }

  private emit(level: EventLevel, message: string, cell?: { x: number; y: number }, unitId?: string): void {
    const event: SimEvent = {
      id: this.eventSequence++,
      time: this.time,
      level,
      message,
      cell: cell ? { x: cell.x, y: cell.y } : undefined,
      unitId,
    };
    this.events.push(event);
    if (this.events.length > 260) this.events.shift();
  }

  private unitDisplayName(unit: Unit): string {
    return `${unit.name}`;
  }

  private unitGridLabel(unit: Unit): string {
    return `${Math.round(unit.pos.x)},${Math.round(unit.pos.y)}`;
  }

  private cellLabel(cell: { x: number; y: number }): string {
    return `${cell.x},${cell.y}`;
  }
}

