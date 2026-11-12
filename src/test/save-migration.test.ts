import { describe, expect, it } from 'vitest';
import { LEGACY_SAVE_V1, SAVE_VERSION, createDefaultSave, parseSave } from '../save/saveTypes';

describe('versioned save migrations', () => {
  it('reads the bundled v1 fixture and migrates it to the current schema', () => {
    const loaded = parseSave(LEGACY_SAVE_V1);
    expect(loaded.migratedFrom).toBe(1);
    expect(loaded.save.schemaVersion).toBe(SAVE_VERSION);
    expect(loaded.save.campaign.unlockedMissions).toEqual(['qingsongling', 'yingzuiai']);
    expect(loaded.save.campaign.completed['qingsongling'].bestBurnedHa).toBeCloseTo(88.4);
    expect(loaded.save.deploymentPresets).toHaveLength(1);
    expect(loaded.save.deploymentPresets[0].units).toHaveLength(3);
    expect(loaded.save.deploymentPresets[0].units[0].cell).toEqual({ x: 13, y: 24 });
    expect(loaded.notes.length).toBeGreaterThan(1);
  });

  it('migrates a v2 save through the chained migration', () => {
    const v2 = {
      schemaVersion: 2,
      savedAt: '2026-09-01T00:00:00.000Z',
      campaign: {
        unlockedMissions: ['qingsongling'],
        completed: {
          qingsongling: {
            stars: 2,
            bestBurnedHa: 41,
            bestStars: 2,
            runs: 4,
            lastPlayedAt: '2026-09-01T00:00:00.000Z',
            lastOutcome: 'contained',
          },
        },
      },
      presets: [
        {
          id: 'old-preset',
          name: '旧版预案',
          missionId: 'qingsongling',
          units: [{ type: 'ground', x: 12, y: 23 }],
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      records: [],
    };
    const loaded = parseSave(v2);
    expect(loaded.migratedFrom).toBe(2);
    expect(loaded.save.schemaVersion).toBe(SAVE_VERSION);
    expect(loaded.save.deploymentPresets[0].id).toBe('old-preset');
    expect(loaded.save.campaign.completed['qingsongling'].runs).toBe(4);
  });

  it('refuses saves from a newer schema instead of silently corrupting them', () => {
    expect(() => parseSave({ schemaVersion: 99 })).toThrow(/高于当前支持/);
    expect(() => parseSave({})).toThrow(/无法识别/);
  });

  it('creates defaults that already conform to the current schema', () => {
    const defaults = createDefaultSave();
    expect(defaults.schemaVersion).toBe(SAVE_VERSION);
    expect(defaults.campaign.unlockedMissions.length).toBeGreaterThan(0);
    expect(defaults.campaign.completed).toEqual({});
  });
});
