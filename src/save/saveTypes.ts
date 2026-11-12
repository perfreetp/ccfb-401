import type { DeploymentUnit, MissionResult } from '../sim/types';

export const SAVE_VERSION = 3;
export const SAVE_KEY = 'lfr.save.v3';
const LEGACY_KEYS = ['lfr.save.v2', 'lfr.save.v1', 'lfr.save'];

export interface CompletedMission {
  stars: number;
  bestBurnedHa: number;
  bestStars: number;
  runs: number;
  lastPlayedAt: string;
  lastOutcome: MissionResult['outcome'];
}

export interface DeploymentPreset {
  id: string;
  name: string;
  missionId: string;
  units: DeploymentUnit[];
  createdAt: string;
  templateId?: string;
}

export interface SaveDocument {
  schemaVersion: typeof SAVE_VERSION;
  savedAt: string;
  campaign: {
    unlockedMissions: string[];
    completed: Record<string, CompletedMission>;
  };
  deploymentPresets: DeploymentPreset[];
  records: MissionResult[];
  meta: {
    appVersion: string;
    configVersion: number;
    migrationNotes: string[];
  };
}

export interface LoadedSave {
  save: SaveDocument;
  migratedFrom: number | null;
  notes: string[];
}

export function createDefaultSave(): SaveDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: SAVE_VERSION,
    savedAt: now,
    campaign: {
      unlockedMissions: ['qingsongling'],
      completed: {},
    },
    deploymentPresets: [],
    records: [],
    meta: {
      appVersion: '1.0.0',
      configVersion: 1,
      migrationNotes: [],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeUnits(value: unknown): DeploymentUnit[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): DeploymentUnit | null => {
      if (!isRecord(item)) return null;
      const type = item['type'];
      if (type !== 'ground' && type !== 'tender' && type !== 'helicopter') return null;
      const cellRaw = isRecord(item['cell']) ? item['cell'] : item;
      return {
        id: typeof item['id'] === 'string' ? item['id'] : `migrated-${index}-${String(type)}`,
        type,
        cell: {
          x: Math.round(asNumber(cellRaw['x'], 0)),
          y: Math.round(asNumber(cellRaw['y'], 0)),
        },
        name: typeof item['name'] === 'string' ? item['name'] : undefined,
      };
    })
    .filter((unit): unit is DeploymentUnit => unit !== null);
}

function migrateV1ToV2(raw: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  notes.push('v1 → v2：迁移旧版解锁列表、通关记录与部署方案。');
  const unlocked = asStringArray(raw['unlockedMissions'] ?? raw['unlocked']);
  const completedRaw = isRecord(raw['completedMissions']) ? raw['completedMissions'] : {};
  const completed: Record<string, unknown> = {};
  for (const [missionId, value] of Object.entries(completedRaw)) {
    if (!isRecord(value)) continue;
    completed[missionId] = {
      stars: asNumber(value['stars'], 0),
      bestBurnedHa: asNumber(value['bestBurnedHa'] ?? value['burnedHa'], 9999),
      bestStars: asNumber(value['bestStars'] ?? value['stars'], 0),
      runs: asNumber(value['runs'], 1),
      lastPlayedAt: nowIso(value['lastPlayedAt']),
      lastOutcome: value['outcome'] === 'contained' ? 'contained' : 'timeout',
    };
  }
  const oldDeployments = raw['deployments'];
  const presets = Array.isArray(oldDeployments)
    ? oldDeployments
        .filter(isRecord)
        .map((item, index) => ({
          id: `preset-migrated-v1-${index}`,
          name: typeof item['name'] === 'string' ? item['name'] : `旧方案 ${index + 1}`,
          missionId: typeof item['missionId'] === 'string' ? item['missionId'] : 'qingsongling',
          units: normalizeUnits(item['units']),
          createdAt: nowIso(item['createdAt']),
        }))
        .filter((preset) => preset.units.length > 0)
    : [];

  return {
    schemaVersion: 2,
    savedAt: nowIso(raw['savedAt']),
    campaign: { unlockedMissions: unlocked, completed },
    presets,
    records: [],
    meta: { appVersion: '0.9', configVersion: 1, migrationNotes: notes },
  };
}

function migrateV2ToV3(raw: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  notes.push('v2 → v3：部署方案字段更名为 deploymentPresets，补齐批次报告扩展位。');
  const campaignRaw = isRecord(raw['campaign']) ? raw['campaign'] : {};
  const completedRaw = isRecord(campaignRaw['completed']) ? campaignRaw['completed'] : {};
  const completed: Record<string, CompletedMission> = {};
  for (const [missionId, value] of Object.entries(completedRaw)) {
    if (!isRecord(value)) continue;
    completed[missionId] = {
      stars: asNumber(value['stars'], 0),
      bestBurnedHa: asNumber(value['bestBurnedHa'], 9999),
      bestStars: asNumber(value['bestStars'] ?? value['stars'], 0),
      runs: asNumber(value['runs'], 1),
      lastPlayedAt: nowIso(value['lastPlayedAt']),
      lastOutcome: value['lastOutcome'] === 'contained' ? 'contained' : 'timeout',
    };
  }
  const oldPresets = Array.isArray(raw['presets']) ? raw['presets'] : [];
  const deploymentPresets = oldPresets
    .filter(isRecord)
    .map((item, index) => ({
      id: typeof item['id'] === 'string' ? item['id'] : `preset-migrated-v2-${index}`,
      name: typeof item['name'] === 'string' ? item['name'] : `迁移方案 ${index + 1}`,
      missionId: typeof item['missionId'] === 'string' ? item['missionId'] : 'qingsongling',
      units: normalizeUnits(item['units']),
      createdAt: nowIso(item['createdAt']),
      templateId: typeof item['templateId'] === 'string' ? item['templateId'] : undefined,
    }))
    .filter((preset) => preset.units.length > 0);

  return {
    schemaVersion: 3,
    savedAt: nowIso(raw['savedAt']),
    campaign: {
      unlockedMissions: asStringArray(campaignRaw['unlockedMissions']),
      completed,
    },
    deploymentPresets,
    records: Array.isArray(raw['records']) ? raw['records'] : [],
    meta: {
      appVersion: '1.0.0',
      configVersion: asNumber(isRecord(raw['meta']) ? raw['meta']['configVersion'] : 1, 1),
      migrationNotes: notes,
    },
  };
}

function nowIso(value: unknown): string {
  if (typeof value === 'string') {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  return new Date().toISOString();
}

function normalizeV3(raw: Record<string, unknown>, defaultSave: SaveDocument): SaveDocument {
  const campaignRaw = isRecord(raw['campaign']) ? raw['campaign'] : {};
  const completedRaw = isRecord(campaignRaw['completed']) ? campaignRaw['completed'] : {};
  const completed: Record<string, CompletedMission> = {};
  for (const [missionId, value] of Object.entries(completedRaw)) {
    if (!isRecord(value)) continue;
    completed[missionId] = {
      stars: asNumber(value['stars'], 0),
      bestBurnedHa: asNumber(value['bestBurnedHa'], 9999),
      bestStars: asNumber(value['bestStars'], 0),
      runs: asNumber(value['runs'], 1),
      lastPlayedAt: nowIso(value['lastPlayedAt']),
      lastOutcome: value['lastOutcome'] === 'contained' ? 'contained' : 'timeout',
    };
  }
  const deploymentPresets = Array.isArray(raw['deploymentPresets'])
    ? raw['deploymentPresets']
        .filter(isRecord)
        .map((item, index) => ({
          id: typeof item['id'] === 'string' ? item['id'] : `preset-${index}`,
          name: typeof item['name'] === 'string' ? item['name'] : `方案 ${index + 1}`,
          missionId: typeof item['missionId'] === 'string' ? item['missionId'] : 'qingsongling',
          units: normalizeUnits(item['units']),
          createdAt: nowIso(item['createdAt']),
          templateId: typeof item['templateId'] === 'string' ? item['templateId'] : undefined,
        }))
        .filter((preset) => preset.units.length > 0)
    : [];
  const records = Array.isArray(raw['records'])
    ? (raw['records'] as MissionResult[]).filter((record) => isRecord(record) && typeof record['missionId'] === 'string').slice(0, 30)
    : [];
  const metaRaw = isRecord(raw['meta']) ? raw['meta'] : {};
  return {
    schemaVersion: SAVE_VERSION,
    savedAt: nowIso(raw['savedAt']),
    campaign: {
      unlockedMissions: asStringArray(campaignRaw['unlockedMissions']).length > 0
        ? asStringArray(campaignRaw['unlockedMissions'])
        : defaultSave.campaign.unlockedMissions,
      completed,
    },
    deploymentPresets: deploymentPresets.slice(0, 40),
    records,
    meta: {
      appVersion: '1.0.0',
      configVersion: asNumber(metaRaw['configVersion'], 1),
      migrationNotes: asStringArray(metaRaw['migrationNotes']),
    },
  };
}

export function parseSave(input: unknown | string): LoadedSave {
  let raw: unknown = input;
  if (typeof input === 'string') raw = JSON.parse(input);
  if (!isRecord(raw)) throw new Error('存档内容不是有效对象');
  const version = asNumber(raw['schemaVersion'] ?? raw['version'], 0);
  if (version === 0) throw new Error('无法识别存档版本');
  if (version > SAVE_VERSION) {
    throw new Error(`存档版本 v${version} 高于当前支持的 v${SAVE_VERSION}，请升级游戏后再读档`);
  }
  const notes: string[] = [];
  let current: Record<string, unknown> = { ...raw };
  if (version === 1) {
    current = migrateV1ToV2(current, notes);
    current = migrateV2ToV3(current, notes);
  } else if (version === 2) {
    current = migrateV2ToV3(current, notes);
  }
  const save = normalizeV3(current, createDefaultSave());
  save.meta.migrationNotes = notes.length > 0
    ? notes
    : asStringArray(current['meta'] && isRecord(current['meta']) ? current['meta']['migrationNotes'] : []);
  return { save, migratedFrom: version < SAVE_VERSION ? version : null, notes };
}

export function saveToStorage(save: SaveDocument): void {
  try {
    const next: SaveDocument = {
      ...save,
      schemaVersion: SAVE_VERSION,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(next));
  } catch {
    // Autosave is best-effort in restricted browsers.
  }
}

export function loadFromStorage(): LoadedSave {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return parseSave(raw);
    for (const key of LEGACY_KEYS) {
      const legacy = localStorage.getItem(key);
      if (!legacy) continue;
      const loaded = parseSave(legacy);
      saveToStorage(loaded.save);
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
      return loaded;
    }
    return { save: createDefaultSave(), migratedFrom: null, notes: [] };
  } catch {
    return { save: createDefaultSave(), migratedFrom: null, notes: ['本地存档损坏，已创建新的战役存档。'] };
  }
}

export function clearStorage(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore
  }
}

export const LEGACY_SAVE_V1 = {
  version: 1,
  unlocked: ['qingsongling', 'yingzuiai'],
  completedMissions: {
    qingsongling: { stars: 2, burnedHa: 88.4, runs: 3, lastPlayedAt: '2026-08-01T10:20:00.000Z' },
  },
  deployments: [
    {
      name: '西南风标准预案',
      missionId: 'qingsongling',
      units: [
        { type: 'ground', x: 13, y: 24 },
        { type: 'tender', x: 12, y: 26 },
        { type: 'helicopter', x: 15, y: 22 },
      ],
    },
  ],
  savedAt: '2026-08-01T10:20:00.000Z',
};
