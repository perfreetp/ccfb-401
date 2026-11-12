import rawDefaults from './gameConfig.json';
import type { GameConfig } from './types';

const STORAGE_KEY = 'lfr.config.v1';
const CONFIG_EVENT = 'lfr-config-change';

const defaults = rawDefaults as unknown as GameConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) {
    const baseItems = base as unknown[];
    const patchItems = patch as unknown[];
    const hasIds = patchItems.every((item) => isRecord(item) && typeof item['id'] === 'string');
    if (!hasIds) return clone(patch);
    const mergedById = patchItems.map((item) => {
      const patchRecord = item as Record<string, unknown>;
      const matched = baseItems.find(
        (baseItem) => isRecord(baseItem) && baseItem['id'] === patchRecord['id'],
      );
      return matched ? mergeValue(matched, item) : clone(item);
    });
    const patchIds = new Set(patchItems.map((item) => (item as Record<string, unknown>)['id']));
    const futureDefaults = baseItems.filter(
      (item) => isRecord(item) && typeof item['id'] === 'string' && !patchIds.has(item['id']),
    );
    return [...mergedById, ...clone(futureDefaults)];
  }
  if (isRecord(base) && isRecord(patch)) {
    const result: Record<string, unknown> = clone(base);
    for (const [key, value] of Object.entries(patch)) {
      result[key] = key in result ? mergeValue(result[key], value) : clone(value);
    }
    return result;
  }
  return clone(patch);
}

export function mergeConfig(patch: Partial<GameConfig>): GameConfig {
  return mergeValue(defaults, patch) as GameConfig;
}

function validateConfig(config: GameConfig): void {
  const errors: string[] = [];
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) errors.push('scenarios 不能为空');
  if (!finite(config.meta.cellSizeMeters) || config.meta.cellSizeMeters <= 0) errors.push('meta.cellSizeMeters 必须为正数');
  if (!finite(config.fire.baseSpreadChance) || config.fire.baseSpreadChance < 0) errors.push('fire.baseSpreadChance 必须为非负数');
  if (!finite(config.fire.spreadIntervalSec) || config.fire.spreadIntervalSec <= 0) errors.push('fire.spreadIntervalSec 必须为正数');
  for (const [type, unit] of Object.entries(config.units)) {
    if (!finite(unit.cost) || unit.cost <= 0) errors.push(`units.${type}.cost 必须为正数`);
    if (!finite(unit.speedCellsPerSec) || unit.speedCellsPerSec <= 0) errors.push(`units.${type}.speedCellsPerSec 必须为正数`);
    if (!finite(unit.waterCapacity) || unit.waterCapacity <= 0) errors.push(`units.${type}.waterCapacity 必须为正数`);
  }
  for (const scenario of config.scenarios) {
    if (!scenario.id || !scenario.name) errors.push('每个战区必须包含 id 与 name');
    if (!finite(scenario.cols) || !finite(scenario.rows) || scenario.cols < 8 || scenario.rows < 8) {
      errors.push(`${scenario.id}: 地图尺寸至少为 8×8`);
      continue;
    }
    const inBounds = (point: { x: number; y: number }, label: string): void => {
      if (!finite(point.x) || !finite(point.y) || point.x < 0 || point.y < 0 || point.x >= scenario.cols || point.y >= scenario.rows) {
        errors.push(`${scenario.id}: ${label} 超出地图范围`);
      }
    };
    inBounds(scenario.base, '基地');
    inBounds(scenario.ignition, '火点');
    scenario.assets.forEach((asset) => inBounds(asset, `设施 ${asset.name}`));
    scenario.lakes.forEach((lake) => inBounds(lake, '水域中心'));
    scenario.cliffs.forEach((cliff) => inBounds(cliff, '断崖中心'));
    if (!finite(scenario.budget) || scenario.budget <= 0) errors.push(`${scenario.id}: 预算必须为正数`);
    if (!finite(scenario.durationSec) || scenario.durationSec <= 0) errors.push(`${scenario.id}: 推演时限必须为正数`);
    if (!finite(scenario.weather.speed) || scenario.weather.speed < 0) errors.push(`${scenario.id}: 初始风速必须为非负数`);
    if (!finite(scenario.weather.humidity) || scenario.weather.humidity < 0 || scenario.weather.humidity > 100) errors.push(`${scenario.id}: 湿度必须在 0–100 之间`);
    for (const event of scenario.windEvents) {
      if (!finite(event.atSec) || event.atSec < 0) errors.push(`${scenario.id}: 风变事件时间必须为非负数`);
      if (!finite(event.fromDeg) || event.fromDeg < 0 || event.fromDeg >= 360) errors.push(`${scenario.id}: 风变方向必须在 0–359 之间`);
      if (!finite(event.speed) || event.speed < 0) errors.push(`${scenario.id}: 风变风速必须为非负数`);
      if (!finite(event.transitionSec) || event.transitionSec <= 0) errors.push(`${scenario.id}: 风变过渡时长必须为正数`);
      if (!finite(event.warnSec) || event.warnSec < 0) errors.push(`${scenario.id}: 风变预警时长必须为非负数`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`配置校验失败：${errors.slice(0, 6).join('；')}${errors.length > 6 ? `（另有 ${errors.length - 6} 项）` : ''}`);
  }
}

function readStored(): Partial<GameConfig> | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as Partial<GameConfig>;
  } catch {
    return null;
  }
}

export class ConfigStore {
  private config: GameConfig;
  private readonly listeners = new Set<(config: GameConfig) => void>();

  constructor() {
    const stored = readStored();
    try {
      const candidate = stored ? mergeConfig(stored) : clone(defaults);
      validateConfig(candidate);
      this.config = candidate;
    } catch {
      this.config = clone(defaults);
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }

  get(): GameConfig {
    return this.config;
  }

  getDefaults(): GameConfig {
    return clone(defaults);
  }

  set(next: GameConfig): void {
    const merged = mergeConfig(next);
    validateConfig(merged);
    this.config = merged;
    this.persist();
    this.emit();
  }

  patch(updater: (draft: GameConfig) => void): void {
    const draft = clone(this.config);
    updater(draft);
    this.set(draft);
  }

  reset(): void {
    this.config = clone(defaults);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage can be unavailable in private contexts; the in-memory config still resets.
    }
    this.emit();
  }

  importJson(json: string): GameConfig {
    const parsed = JSON.parse(json) as Partial<GameConfig>;
    if (!isRecord(parsed) || !Array.isArray(parsed.scenarios) || !isRecord(parsed.fire)) {
      throw new Error('配置文件缺少必要字段（fire / scenarios）');
    }
    const next = mergeConfig(parsed);
    validateConfig(next);
    this.set(next);
    return next;
  }

  exportJson(): string {
    return JSON.stringify(this.config, null, 2);
  }

  subscribe(listener: (config: GameConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch {
      // Ignore quota or privacy-mode failures.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.config);
    window.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail: this.config }));
  }
}

export const configStore = new ConfigStore();

export function getConfig(): GameConfig {
  return configStore.get();
}
