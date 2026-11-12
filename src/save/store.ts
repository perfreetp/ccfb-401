import { configStore } from '../config/configStore';
import type { MissionResult } from '../sim/types';
import {
  SAVE_VERSION,
  clearStorage,
  createDefaultSave,
  loadFromStorage,
  parseSave,
  saveToStorage,
  type DeploymentPreset,
  type LoadedSave,
  type SaveDocument,
} from './saveTypes';

export class SaveStore {
  private doc: SaveDocument;
  private readonly listeners = new Set<(save: SaveDocument) => void>();
  lastMigration: LoadedSave['migratedFrom'] = null;
  lastNotes: string[] = [];

  constructor() {
    const loaded = loadFromStorage();
    this.doc = loaded.save;
    this.lastMigration = loaded.migratedFrom;
    this.lastNotes = loaded.notes;
    this.ensureFirstMission();
    this.persist();
  }

  get(): SaveDocument {
    return this.doc;
  }

  subscribe(listener: (save: SaveDocument) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(updater: (save: SaveDocument) => void): void {
    updater(this.doc);
    this.doc.savedAt = new Date().toISOString();
    this.persist();
    for (const listener of this.listeners) listener(this.doc);
  }

  recordMission(result: MissionResult, unlockNext: boolean): void {
    this.update((save) => {
      const missionId = result.missionId;
      const existing = save.campaign.completed[missionId];
      const bestStars = Math.max(existing?.bestStars ?? 0, result.stars);
      const bestBurned = existing ? Math.min(existing.bestBurnedHa, result.burnedHa) : result.burnedHa;
      save.campaign.completed[missionId] = {
        stars: result.stars,
        bestStars,
        bestBurnedHa: bestBurned,
        runs: (existing?.runs ?? 0) + 1,
        lastPlayedAt: result.finishedAt,
        lastOutcome: result.outcome,
      };
      save.records.unshift(result);
      save.records = save.records.slice(0, 20);
      if (unlockNext && result.stars >= 2) {
        const scenarios = configStore.get().scenarios;
        const index = scenarios.findIndex((scenario) => scenario.id === missionId);
        const next = scenarios[index + 1];
        if (next && !save.campaign.unlockedMissions.includes(next.id)) {
          save.campaign.unlockedMissions.push(next.id);
        }
      }
    });
  }

  addPreset(preset: DeploymentPreset): void {
    this.update((save) => {
      const withoutSameName = save.deploymentPresets.filter(
        (item) => !(item.missionId === preset.missionId && item.name === preset.name),
      );
      save.deploymentPresets = [preset, ...withoutSameName].slice(0, 30);
    });
  }

  removePreset(presetId: string): void {
    this.update((save) => {
      save.deploymentPresets = save.deploymentPresets.filter((preset) => preset.id !== presetId);
    });
  }

  ensureMissionUnlocked(missionId: string): void {
    if (this.doc.campaign.unlockedMissions.includes(missionId)) return;
    this.update((save) => {
      save.campaign.unlockedMissions.push(missionId);
    });
  }

  importSave(json: string): LoadedSave {
    const loaded = parseSave(json);
    this.doc = loaded.save;
    this.lastMigration = loaded.migratedFrom;
    this.lastNotes = loaded.notes;
    this.ensureFirstMission();
    this.persist();
    for (const listener of this.listeners) listener(this.doc);
    return loaded;
  }

  exportSave(): string {
    return JSON.stringify(this.doc, null, 2);
  }

  reset(): void {
    clearStorage();
    this.doc = createDefaultSave();
    this.lastMigration = null;
    this.lastNotes = [];
    this.persist();
    for (const listener of this.listeners) listener(this.doc);
  }

  getVersionLabel(): string {
    return `SCHEMA v${SAVE_VERSION}`;
  }

  private ensureFirstMission(): void {
    if (this.doc.campaign.unlockedMissions.length > 0) return;
    const first = configStore.get().scenarios[0];
    if (first) this.doc.campaign.unlockedMissions = [first.id];
    for (const preset of this.doc.deploymentPresets) {
      if (!preset.missionId) preset.missionId = first?.id ?? 'qingsongling';
    }
  }

  private persist(): void {
    saveToStorage(this.doc);
  }
}

export const saveStore = new SaveStore();
