import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import type { GameConfig } from '../config/types';
import type { Cell, DeploymentUnit, GameMap, ToolMode, Unit, UnitTypeId } from '../sim/types';
import type { Simulation } from '../sim/engine';

const CELL = 18;
type Mode = 'deployment' | 'command' | 'review';

export interface MapRendererCallbacks {
  onCellAction?: (cell: { x: number; y: number }, tool: ToolMode) => void;
  onBreakLine?: (cells: { x: number; y: number }[]) => void;
  onUnitSelect?: (unitId: string) => void;
  onHoverCell?: (cell: { x: number; y: number } | null) => void;
}

interface DisplayUnit {
  id: string;
  type: UnitTypeId;
  name: string;
  x: number;
  y: number;
  state?: string;
  waterRatio?: number;
  trapped?: boolean;
  lost?: boolean;
}

interface UnitVisual {
  container: Container;
  body: Graphics;
  ring: Graphics;
  label: Text;
  bar: Graphics;
  lastSignature: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): number {
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (clampByte(r) << 16) + (clampByte(g) << 8) + clampByte(b);
}

function shade(hex: string, amount: number): number {
  const [r, g, b] = hexToRgb(hex);
  if (amount >= 0) {
    return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
  }
  return rgbToHex(r * (1 + amount), g * (1 + amount), b * (1 + amount));
}

function cellHash(x: number, y: number): number {
  let h = x * 73856093 ^ y * 19349663 ^ 0x5bd1e995;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class MapRenderer {
  private readonly host: HTMLElement;
  private readonly mode: Mode;
  private readonly callbacks: MapRendererCallbacks;
  private app: Application | null = null;
  private map: GameMap | null = null;
  private config: GameConfig | null = null;
  private simulation: Simulation | null = null;
  private previewUnits: DeploymentUnit[] = [];
  private tool: ToolMode = 'inspect';
  private selectedUnitId: string | null = null;

  private world: Container | null = null;
  private staticLayer: Graphics | null = null;
  private assetLayer: Container | null = null;
  private dynamicLayer: Graphics | null = null;
  private unitLayer: Container | null = null;
  private overlayLayer: Graphics | null = null;
  private hover: { x: number; y: number } | null = null;
  private breakPreview: { x: number; y: number }[] = [];
  private draggingBreak = false;
  private pointerWasDown = false;
  private unitVisuals = new Map<string, UnitVisual>();
  private tooltip: HTMLElement | null = null;
  private destroyed = false;
  private lastDynamicAt = -1000;
  private reviewBurned: Set<number> | null = null;
  private reviewLostAssets: Set<string> | null = null;

  constructor(host: HTMLElement, mode: Mode, config: GameConfig, callbacks: MapRendererCallbacks = {}) {
    this.host = host;
    this.mode = mode;
    this.config = config;
    this.callbacks = callbacks;
  }

  async initialize(map: GameMap): Promise<void> {
    this.map = map;
    const app = new Application();
    await app.init({
      resizeTo: this.host,
      background: '#0b110e',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
    });
    if (this.destroyed) {
      app.destroy(true);
      return;
    }
    this.app = app;
    this.host.appendChild(app.canvas);
    app.stage.eventMode = 'static';
    app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
    app.canvas.style.touchAction = 'none';
    app.canvas.style.cursor = this.mode === 'review' ? 'default' : 'crosshair';

    this.world = new Container();
    app.stage.addChild(this.world);
    const bg = new Graphics();
    bg.rect(0, 0, map.cols * CELL, map.rows * CELL).fill('#1b241a');
    this.world.addChild(bg);

    this.staticLayer = new Graphics();
    this.world.addChild(this.staticLayer);
    this.assetLayer = new Container();
    this.world.addChild(this.assetLayer);
    this.dynamicLayer = new Graphics();
    this.world.addChild(this.dynamicLayer);
    this.unitLayer = new Container();
    this.world.addChild(this.unitLayer);
    this.overlayLayer = new Graphics();
    this.world.addChild(this.overlayLayer);

    this.buildTerrain();
    this.buildAssets();
    this.buildTooltip();
    this.installInput();
    this.resizeWorld();
    app.ticker.add(this.tick);
    this.renderDynamic(true);
  }

  setSimulation(simulation: Simulation): void {
    this.simulation = simulation;
    this.refreshUnitVisuals();
  }

  setPreviewUnits(units: DeploymentUnit[]): void {
    this.previewUnits = units;
    this.refreshUnitVisuals();
    this.renderDynamic(true);
  }

  setReviewSnapshot(burnedIndices: number[] | Set<number>, lostAssetIds: string[] = []): void {
    this.reviewBurned = burnedIndices instanceof Set ? burnedIndices : new Set(burnedIndices);
    this.reviewLostAssets = new Set(lostAssetIds);
    this.renderDynamic(true);
  }

  setTool(tool: ToolMode): void {
    this.tool = tool;
    this.draggingBreak = false;
    this.breakPreview = [];
    this.drawOverlay();
    if (this.app) {
      this.app.canvas.style.cursor = this.mode === 'review' ? 'default' : tool === 'inspect' ? 'crosshair' : 'cell';
    }
  }

  setSelectedUnit(unitId: string | null): void {
    this.selectedUnitId = unitId;
    this.refreshUnitVisuals();
  }

  /** Returns the CSS pixel position of a grid cell within the host, used for DOM overlays. */
  gridToHostPoint(x: number, y: number): { x: number; y: number } {
    if (!this.world || !this.app) return { x: 0, y: 0 };
    const worldPoint = this.world.toGlobal({ x: (x + 0.5) * CELL, y: (y + 0.5) * CELL });
    return { x: worldPoint.x, y: worldPoint.y };
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('pointerup', this.onWindowUp);
    if (this.app) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true, texture: true });
      this.app = null;
      this.app = null;
    }
    this.host.replaceChildren();
    this.unitVisuals.clear();
  }

  private tick = (): void => {
    if (!this.app || !this.world) return;
    this.resizeWorld();
    const now = performance.now();
    if (now - this.lastDynamicAt > 100) {
      this.renderDynamic();
      this.lastDynamicAt = now;
    }
    this.renderUnits(now);
  };

  private resizeWorld(): void {
    if (!this.app || !this.world || !this.map) return;
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    this.app.stage.hitArea = new Rectangle(0, 0, width, height);
    const pad = Math.min(24, width * 0.02);
    const scale = Math.min((width - pad * 2) / (this.map.cols * CELL), (height - pad * 2) / (this.map.rows * CELL));
    this.world.scale.set(scale);
    this.world.position.set(
      (width - this.map.cols * CELL * scale) / 2,
      (height - this.map.rows * CELL * scale) / 2,
    );
  }

  private buildTerrain(): void {
    if (!this.staticLayer || !this.map || !this.config) return;
    const g = this.staticLayer;
    g.clear();
    const map = this.map;
    const maxElevation = 220;
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) {
        const cell = map.cells[y][x];
        const px = x * CELL;
        const py = y * CELL;
        const terrain = this.config.terrain[cell.terrain] ?? this.config.terrain['plain'];
        const veg = this.config.vegetation[cell.vegetation] ?? this.config.vegetation['grass'];
        let base: string | number = cell.terrain === 'water' || cell.terrain === 'cliff' || cell.terrain === 'road' || cell.terrain === 'base'
          ? terrain.color
          : veg.color;
        const elevationTint = clamp01(cell.elevation / maxElevation) * terrain.heightTint * 0.7 - 0.12;
        const variation = (cellHash(x, y) - 0.5) * 0.055;
        base = shadeHex(base, elevationTint + variation);
        g.rect(px, py, CELL, CELL).fill({ color: base, alpha: 1 });

        if (cell.terrain === 'water') {
          g.moveTo(px + 3, py + 7).lineTo(px + CELL - 3, py + 7).stroke({ width: 1, color: 0x8bb2b4, alpha: 0.35 });
          g.moveTo(px + 5, py + 12).lineTo(px + CELL - 4, py + 12).stroke({ width: 1, color: 0x8bb2b4, alpha: 0.2 });
        } else if (cell.terrain === 'cliff') {
          g.moveTo(px + 2, py + CELL - 2).lineTo(px + CELL - 2, py + 2).stroke({ width: 1, color: 0xd7d1b8, alpha: 0.2 });
          g.moveTo(px + 7, py + CELL - 2).lineTo(px + CELL - 2, py + 7).stroke({ width: 1, color: 0x2d312e, alpha: 0.5 });
        } else if (cell.terrain === 'road') {
          g.moveTo(px + 1, py + CELL / 2).lineTo(px + CELL - 1, py + CELL / 2).stroke({ width: 2, color: 0xab9f78, alpha: 0.28 });
          g.circle(px + CELL / 2, py + CELL / 2, 1.2).fill({ color: 0xd8cda9, alpha: 0.35 });
        } else if (cell.terrain === 'base') {
          // Base apron is rendered as an installation below.
        } else if (cell.vegetation === 'pine' || cell.vegetation === 'mixed' || cell.vegetation === 'shrub') {
          this.drawTree(g, px, py, x, y, cell.vegetation);
        }
      }
    }

    // Coarse grid, resembling a tactical plotting map.
    for (let x = 0; x <= map.cols; x += 5) {
      g.moveTo(x * CELL, 0).lineTo(x * CELL, map.rows * CELL).stroke({ width: 1, color: 0xdde4c5, alpha: 0.055 });
    }
    for (let y = 0; y <= map.rows; y += 5) {
      g.moveTo(0, y * CELL).lineTo(map.cols * CELL, y * CELL).stroke({ width: 1, color: 0xdde4c5, alpha: 0.055 });
    }
    g.rect(0, 0, map.cols * CELL, map.rows * CELL).stroke({ width: 2, color: 0x99a789, alpha: 0.3 });
  }

  private drawTree(g: Graphics, px: number, py: number, x: number, y: number, veg: string): void {
    const h1 = cellHash(x, y);
    const h2 = cellHash(x + 3, y + 11);
    const count = veg === 'grass' ? 1 : veg === 'shrub' ? 2 : 3;
    for (let i = 0; i < count; i++) {
      const ox = px + 3 + ((h1 + i * 0.37) % 1) * (CELL - 6);
      const oy = py + 4 + ((h2 + i * 0.51) % 1) * (CELL - 8);
      const radius = veg === 'pine' ? 2.4 : veg === 'mixed' ? 2.1 : 1.6;
      const color = veg === 'pine' ? 0x2d4a34 : veg === 'mixed' ? 0x38543c : 0x4a5537;
      g.circle(ox + 1.5, oy + 2, radius).fill({ color: 0x1a2019, alpha: 0.2 });
      g.circle(ox, oy, radius).fill({ color, alpha: 0.72 });
      if (i === 0) g.circle(ox - 0.7, oy - 0.9, radius * 0.4).fill({ color: 0x8ca469, alpha: 0.22 });
    }
  }

  private buildAssets(): void {
    if (!this.assetLayer || !this.map) return;
    this.assetLayer.removeChildren().forEach((child) => child.destroy());
    const map = this.map;
    const base = map.scenario.base;
    const g = new Graphics();

    // Base installation.
    const bx = base.x * CELL;
    const by = base.y * CELL;
    g.circle(bx + CELL / 2, by + CELL / 2, CELL * 2.2).fill({ color: 0xc9ba8a, alpha: 0.07 });
    g.circle(bx + CELL / 2, by + CELL / 2, CELL * 1.3).stroke({ width: 1, color: 0xd7c592, alpha: 0.25 });
    g.roundRect(bx + 3, by + 5, 12, 9, 2).fill({ color: 0x2d332b, alpha: 0.92 }).stroke({ width: 1, color: 0xd0be8e, alpha: 0.8 });
    g.moveTo(bx + 9, by + 2).lineTo(bx + 9, by + 5).stroke({ width: 1, color: 0xd0be8e, alpha: 0.8 });
    g.moveTo(bx + 9, by + 2).lineTo(bx + 13, by + 3).stroke({ width: 1, color: 0xe1cc95, alpha: 0.8 });
    this.assetLayer.addChild(g);

    const baseText = new Text({
      text: '前进基地',
      style: { fontFamily: 'sans-serif', fontSize: 8, fill: '#eadbb4', fontWeight: '500' },
    });
    baseText.anchor.set(0.5, 0);
    baseText.position.set(bx + CELL / 2, by + CELL + 3);
    this.assetLayer.addChild(baseText);

    for (const asset of map.assets) {
      const cell = map.cells[asset.y][asset.x];
      const px = asset.x * CELL;
      const py = asset.y * CELL;
      const marker = new Graphics();
      marker.circle(px + CELL / 2, py + CELL / 2, CELL * 1.5).fill({ color: 0xe3d3a0, alpha: 0.06 });
      marker.circle(px + CELL / 2, py + CELL / 2, CELL * 1.5).stroke({ width: 1, color: 0xe3d3a0, alpha: 0.32 });
      marker.rect(px + 2, py + 2, CELL - 4, CELL - 4).fill({ color: 0x25332a, alpha: 0.84 }).stroke({ width: 1, color: 0xd8c486, alpha: 0.7 });
      if (asset.kind === 'tower') {
        marker.moveTo(px + 9, py + 4).lineTo(px + 13, py + 13).stroke({ width: 1, color: 0xeee0b5, alpha: 0.9 });
        marker.moveTo(px + 9, py + 4).lineTo(px + 5, py + 13).stroke({ width: 1, color: 0xeee0b5, alpha: 0.9 });
        marker.circle(px + 9, py + 4, 1.5).fill({ color: 0xf4df9e, alpha: 0.95 });
      } else if (asset.kind === 'village') {
        marker.rect(px + 4, py + 8, 4, 5).fill({ color: 0xd7bb7e, alpha: 0.78 });
        marker.rect(px + 10, py + 6, 5, 7).fill({ color: 0xc9a66f, alpha: 0.8 });
        marker.moveTo(px + 8, py + 8).lineTo(px + 10, py + 5).lineTo(px + 12, py + 8).fill({ color: 0x9e7748, alpha: 0.8 });
      } else if (asset.kind === 'bridge') {
        marker.arc(px + 9, py + 11, 6, Math.PI, 0).stroke({ width: 1.5, color: 0xccc092, alpha: 0.8 });
        marker.moveTo(px + 3, py + 12).lineTo(px + 15, py + 12).stroke({ width: 1, color: 0xccc092, alpha: 0.7 });
      } else {
        marker.rect(px + 4, py + 7, 10, 7).fill({ color: 0xc7af78, alpha: 0.78 });
        marker.moveTo(px + 3, py + 8).lineTo(px + 9, py + 3).lineTo(px + 15, py + 8).fill({ color: 0x9e814d, alpha: 0.8 });
      }
      this.assetLayer.addChild(marker);
      const label = new Text({
        text: asset.name,
        style: {
          fontFamily: 'sans-serif',
          fontSize: 8,
          fill: '#e8e2c9',
          stroke: { color: '#0b110e', width: 2 },
        },
      });
      label.anchor.set(0.5, 0);
      label.position.set(px + CELL / 2, py + CELL + 3);
      this.assetLayer.addChild(label);
      void cell;
    }
  }

  private renderDynamic(force = false): void {
    if (!this.dynamicLayer || !this.map) return;
    if (!force && !this.simulation && this.mode !== 'review') {
      // Deployment maps only need the initial ignition rendered; refresh still cheap.
    }
    const now = this.simulation?.time ?? performance.now() / 1000;
    const g = this.dynamicLayer;
    g.clear();
    const map = this.map;
    const burned = new Set<number>();
    if (this.reviewBurned) {
      for (const index of this.reviewBurned) burned.add(index);
    }
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) {
        const cell = map.cells[y][x];
        const index = y * map.cols + x;
        const px = x * CELL;
        const py = y * CELL;
        const isBurned = cell.fire === 2 || burned.has(index);
        if (isBurned) {
          g.rect(px, py, CELL, CELL).fill({ color: 0x171c18, alpha: 0.86 });
          g.rect(px + 1, py + 1, CELL - 2, CELL - 2).fill({ color: 0x211d18, alpha: 0.5 });
          if (cellHash(x, y) > 0.62) {
            g.circle(px + 4 + cellHash(x + 1, y) * 9, py + 5 + cellHash(x, y + 2) * 8, 0.9).fill({ color: 0x8b4e27, alpha: 0.25 });
          }
        }
        if (cell.wetness > 0.01 && cell.fire !== 2) {
          g.rect(px, py, CELL, CELL).fill({ color: 0x5aa8b8, alpha: 0.09 + cell.wetness * 0.12 });
        }
        if (cell.firebreak) {
          g.rect(px, py, CELL, CELL).fill({ color: 0x332a1d, alpha: 0.88 });
          g.moveTo(px + 2, py + 3).lineTo(px + CELL - 2, py + CELL - 3).stroke({ width: 1, color: 0xb39a64, alpha: 0.75 });
          g.moveTo(px + CELL - 2, py + 3).lineTo(px + 2, py + CELL - 3).stroke({ width: 1, color: 0xb39a64, alpha: 0.45 });
        } else if (cell.plannedBreak) {
          const dash = cell.breakProgress > 0 ? cell.breakProgress : 1;
          g.rect(px + 1, py + 1, CELL - 2, CELL - 2).stroke({ width: 1, color: 0x78d3c5, alpha: 0.42 });
          if (cell.breakProgress > 0) {
            g.rect(px + 1, py + 1, (CELL - 2) * dash, 2).fill({ color: 0x9ce2cd, alpha: 0.7 });
          }
        }
        if (cell.fire === 1 && this.mode !== 'review') {
          const flicker = Math.sin(now * 8 + x * 2.3 + y * 1.7) * 0.5 + 0.5;
          const radius = CELL * (0.32 + cell.intensity * 0.16 + flicker * 0.07);
          g.circle(px + CELL / 2, py + CELL / 2, radius * 1.5).fill({ color: 0xf06f24, alpha: 0.12 });
          g.circle(px + CELL / 2 - 1, py + CELL / 2, radius).fill({ color: cell.backfire ? 0xd7a552 : 0xed7f2d, alpha: 0.65 });
          g.circle(px + CELL / 2 + 1, py + CELL / 2 - 1, radius * 0.5).fill({ color: 0xffdf8c, alpha: 0.72 });
          if (cell.asset) {
            g.moveTo(px + 3, py + 3).lineTo(px + CELL - 3, py + CELL - 3).stroke({ width: 2, color: 0xd8422f, alpha: 0.9 });
            g.moveTo(px + CELL - 3, py + 3).lineTo(px + 3, py + CELL - 3).stroke({ width: 2, color: 0xd8422f, alpha: 0.9 });
          }
        }
        if (this.reviewLostAssets?.has(cell.asset?.id ?? '') || (this.config?.terrain[cell.terrain] && cell.asset && cell.fire === 2)) {
          g.moveTo(px + 3, py + 3).lineTo(px + CELL - 3, py + CELL - 3).stroke({ width: 2, color: 0xd95a40, alpha: 0.8 });
          g.moveTo(px + CELL - 3, py + 3).lineTo(px + 3, py + CELL - 3).stroke({ width: 2, color: 0xd95a40, alpha: 0.8 });
        }
      }
    }
  }

  private refreshUnitVisuals(): void {
    if (!this.unitLayer || !this.config) return;
    const list = this.currentDisplayUnits();
    const alive = new Set(list.map((unit) => unit.id));
    for (const [id, visual] of this.unitVisuals) {
      if (!alive.has(id)) {
        visual.container.destroy({ children: true });
        this.unitVisuals.delete(id);
      }
    }
    for (const unit of list) {
      if (!this.unitVisuals.has(unit.id)) {
        this.unitVisuals.set(unit.id, this.createUnitVisual(unit));
      }
    }
  }

  private currentDisplayUnits(): DisplayUnit[] {
    if (this.mode === 'review') return [];
    if (this.simulation) {
      return this.simulation.units.map((unit) => ({
        id: unit.id,
        type: unit.type,
        name: unit.name,
        x: unit.pos.x,
        y: unit.pos.y,
        state: unit.state,
        waterRatio: unit.water / Math.max(1, unit.waterCapacity),
        trapped: unit.state === '被困求救',
        lost: unit.lost,
      }));
    }
    return this.previewUnits.map((unit) => {
      const cfg = this.config!.units[unit.type];
      return {
        id: unit.id,
        type: unit.type,
        name: unit.name ?? cfg.shortName,
        x: unit.cell.x + 0.5,
        y: unit.cell.y + 0.5,
        state: '待命',
        waterRatio: 1,
      };
    });
  }

  private createUnitVisual(unit: DisplayUnit): UnitVisual {
    const container = new Container();
    const ring = new Graphics();
    const body = new Graphics();
    const bar = new Graphics();
    const label = new Text({
      text: unit.name,
      style: {
        fontFamily: 'sans-serif',
        fontSize: 8,
        fill: '#f1eee0',
        stroke: { color: '#0a0d0a', width: 2 },
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -9);
    container.addChild(ring, body, bar, label);
    this.unitLayer!.addChild(container);
    return { container, ring, body, label, bar, lastSignature: '' };
  }

  private renderUnits(now: number): void {
    if (!this.unitLayer) return;
    const units = this.currentDisplayUnits();
    const alive = new Set(units.map((unit) => unit.id));
    for (const [id, visual] of this.unitVisuals) {
      if (!alive.has(id)) {
        visual.container.destroy({ children: true });
        this.unitVisuals.delete(id);
      }
    }
    for (const unit of units) {
      let visual = this.unitVisuals.get(unit.id);
      if (!visual) {
        visual = this.createUnitVisual(unit);
        this.unitVisuals.set(unit.id, visual);
      }
      visual.container.position.set(unit.x * CELL, unit.y * CELL);
      const signature = `${unit.state}|${Math.round((unit.waterRatio ?? 1) * 10)}|${this.selectedUnitId === unit.id}|${unit.trapped}|${unit.lost}`;
      if (signature !== visual.lastSignature) {
        visual.lastSignature = signature;
        this.drawUnitVisual(visual, unit, now);
      }
      if (unit.trapped) {
        const pulse = 1 + Math.sin(now / 220) * 0.09;
        visual.ring.scale.set(pulse);
      } else {
        visual.ring.scale.set(1);
      }
    }
  }

  private drawUnitVisual(visual: UnitVisual, unit: DisplayUnit, now: number): void {
    if (!this.config) return;
    const cfg = this.config.units[unit.type];
    const color = cfg.color;
    const selected = this.selectedUnitId === unit.id;
    visual.body.clear();
    visual.bar.clear();
    visual.ring.clear();

    const stateColor = unit.lost
      ? 0x6a6a62
      : unit.trapped
        ? 0xe64835
        : unit.state === '补水'
          ? 0x57a9c8
          : unit.state === '扑救' || unit.state === '吊桶作业'
            ? 0xe98a39
            : 0x8fae78;

    if (selected) {
      visual.ring.circle(0, 0, 12).stroke({ width: 1.5, color: 0x9ee8dc, alpha: 0.9 });
      visual.ring.circle(0, 0, 14).stroke({ width: 1, color: 0x9ee8dc, alpha: 0.25 });
    } else if (unit.trapped || unit.lost) {
      visual.ring.circle(0, 0, 11).stroke({ width: 1.5, color: stateColor, alpha: 0.8 });
    }

    if (unit.type === 'ground') {
      visual.body.circle(0, 1, 6.5).fill({ color: 0x1a211b, alpha: 0.82 });
      visual.body.circle(0, 1, 5.4).fill({ color, alpha: 0.9 });
      visual.body.moveTo(-2.8, 3.5).lineTo(0, -4.5).lineTo(2.8, 3.5).fill({ color: 0x302d23, alpha: 0.9 });
      visual.body.circle(0, 0.5, 1.5).fill({ color: 0xffe8a4, alpha: 0.9 });
    } else if (unit.type === 'tender') {
      visual.body.roundRect(-8, -3, 16, 7, 2).fill({ color: 0x1b2729, alpha: 0.88 });
      visual.body.roundRect(-6.5, -2.2, 8, 5.2, 1.5).fill({ color, alpha: 0.9 });
      visual.body.rect(3.6, -2.4, 3, 5.6).fill({ color: 0xd5b16e, alpha: 0.9 });
      visual.body.circle(-4.5, 4.2, 2.1).fill({ color: 0x161a17, alpha: 0.9 });
      visual.body.circle(4.2, 4.2, 2.1).fill({ color: 0x161a17, alpha: 0.9 });
    } else {
      visual.body.ellipse(0, 1, 7.2, 4).fill({ color: 0x1b2729, alpha: 0.85 });
      visual.body.ellipse(0, 0, 5.2, 3).fill({ color, alpha: 0.9 });
      visual.body.moveTo(-10, -5).lineTo(10, -5).stroke({ width: 1.3, color: 0xb8c9b7, alpha: 0.35 });
      visual.body.moveTo(0, -5).lineTo(0, 4).stroke({ width: 1, color: 0x9da992, alpha: 0.25 });
      visual.body.circle(-5, 1, 1.2).fill({ color: 0x162020, alpha: 0.9 });
    }

    if (!unit.lost && (unit.waterRatio ?? 1) < 1) {
      const width = 12;
      visual.bar.roundRect(-width / 2, 9, width, 2.4, 1).fill({ color: 0x0b0f0c, alpha: 0.8 });
      visual.bar.rect(-width / 2 + 0.5, 9.5, width * clamp01(unit.waterRatio ?? 0) - 1, 1.4).fill({ color: 0x71bed1, alpha: 0.9 });
    }

    visual.label.text = unit.name;
    visual.label.style.fill = unit.lost ? '#77796f' : '#f1eee0';
    visual.label.visible = this.mode !== 'review' && (this.mode !== 'command' || this.selectedUnitId === unit.id || unit.trapped === true || unit.lost === true);
    void now;
  }

  private drawOverlay(): void {
    if (!this.overlayLayer) return;
    const g = this.overlayLayer;
    g.clear();
    if (this.hover) {
      g.rect(this.hover.x * CELL, this.hover.y * CELL, CELL, CELL).stroke({ width: 1.5, color: 0xdceac8, alpha: 0.6 });
    }
    for (let i = 0; i < this.breakPreview.length; i++) {
      const cell = this.breakPreview[i];
      g.rect(cell.x * CELL + 1, cell.y * CELL + 1, CELL - 2, CELL - 2).stroke({ width: 1, color: 0x8ce4d0, alpha: 0.85 });
      if (i > 0) {
        const previous = this.breakPreview[i - 1];
        g.moveTo(previous.x * CELL + CELL / 2, previous.y * CELL + CELL / 2)
          .lineTo(cell.x * CELL + CELL / 2, cell.y * CELL + CELL / 2)
          .stroke({ width: 1, color: 0x8ce4d0, alpha: 0.5 });
      }
    }
  }

  private buildTooltip(): void {
    if (this.mode === 'review') return;
    const tooltip = document.createElement('div');
    tooltip.className = 'map-tooltip';
    tooltip.hidden = true;
    this.host.appendChild(tooltip);
    this.tooltip = tooltip;
  }

  private installInput(): void {
    if (!this.app || this.mode === 'review') return;
    this.app.stage.on('pointerdown', this.onPointerDown);
    this.app.stage.on('pointermove', this.onPointerMove);
    this.app.stage.on('pointerup', this.onPointerUp);
    window.addEventListener('pointerup', this.onWindowUp);
    this.app.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.app.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  private eventCell(event: { global: { x: number; y: number } }): { x: number; y: number } | null {
    if (!this.world || !this.map) return null;
    const local = this.world.toLocal(event.global);
    const x = Math.floor(local.x / CELL);
    const y = Math.floor(local.y / CELL);
    if (x < 0 || y < 0 || x >= this.map.cols || y >= this.map.rows) return null;
    return { x, y };
  }

  private onPointerDown = (event: { global: { x: number; y: number } }): void => {
    if (this.mode === 'review') return;
    const cell = this.eventCell(event);
    if (!cell) return;
    this.pointerWasDown = true;
    this.hover = cell;
    if (this.tool === 'break') {
      this.draggingBreak = true;
      this.breakPreview = [cell];
      this.drawOverlay();
      return;
    }
    const displayUnits = this.currentDisplayUnits();
    const hit = displayUnits.find((unit) => Math.hypot(unit.x - (cell.x + 0.5), unit.y - (cell.y + 0.5)) <= 0.62);
    if (hit) {
      this.callbacks.onUnitSelect?.(hit.id);
    } else {
      this.callbacks.onCellAction?.(cell, this.tool);
    }
  };

  private onPointerMove = (event: { global: { x: number; y: number } }): void => {
    const cell = this.eventCell(event);
    if (!cell) {
      this.hover = null;
      this.drawOverlay();
      if (this.tooltip) this.tooltip.hidden = true;
      return;
    }
    if (!this.hover || this.hover.x !== cell.x || this.hover.y !== cell.y) {
      this.hover = cell;
      this.updateTooltip(cell, event);
      this.drawOverlay();
    } else {
      this.positionTooltip(event);
    }
    if (this.draggingBreak) {
      const last = this.breakPreview[this.breakPreview.length - 1];
      if (!last || last.x !== cell.x || last.y !== cell.y) {
        this.appendBreakLine(last, cell);
      }
    }
  };

  private onPointerUp = (): void => {
    if (!this.pointerWasDown) return;
    this.pointerWasDown = false;
    if (this.draggingBreak) {
      this.draggingBreak = false;
      if (this.breakPreview.length > 0) this.callbacks.onBreakLine?.(this.breakPreview);
      this.breakPreview = [];
      this.drawOverlay();
    }
  };

  private onWindowUp = (): void => {
    if (this.draggingBreak) this.onPointerUp();
  };

  private onPointerLeave = (): void => {
    this.hover = null;
    this.drawOverlay();
    if (this.tooltip) this.tooltip.hidden = true;
  };

  private appendBreakLine(from: { x: number; y: number } | undefined, to: { x: number; y: number }): void {
    if (!from) {
      this.breakPreview.push(to);
      this.drawOverlay();
      return;
    }
    let x0 = from.x;
    let y0 = from.y;
    const dx = Math.abs(to.x - x0);
    const dy = Math.abs(to.y - y0);
    const sx = x0 < to.x ? 1 : -1;
    const sy = y0 < to.y ? 1 : -1;
    let error = dx - dy;
    let guard = 0;
    while ((x0 !== to.x || y0 !== to.y) && guard++ < 100) {
      const e2 = 2 * error;
      if (e2 > -dy) {
        error -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        error += dx;
        y0 += sy;
      }
      if (!this.breakPreview.some((cell) => cell.x === x0 && cell.y === y0)) {
        this.breakPreview.push({ x: x0, y: y0 });
      }
    }
    this.drawOverlay();
  }

  private updateTooltip(cell: { x: number; y: number }, event: { global: { x: number; y: number } }): void {
    if (!this.tooltip || !this.map || !this.config) return;
    const data = this.map.cells[cell.y][cell.x];
    const terrain = escapeTooltip(this.config.terrain[data.terrain]?.name ?? data.terrain);
    const vegetation = escapeTooltip(this.config.vegetation[data.vegetation]?.name ?? data.vegetation);
    const state = data.fire === 1 ? '燃烧中' : data.fire === 2 ? '已过火' : data.firebreak ? '隔离带' : '未燃';
    const asset = data.asset ? `<br><span class="tt-accent">设施：${escapeTooltip(data.asset.name)}</span>` : '';
    this.tooltip.innerHTML = `
      <div class="tt-title">${cell.x}, ${cell.y} · ${terrain}</div>
      <div class="tt-row">植被 ${vegetation} · 燃料 ${data.fuel.toFixed(2)}</div>
      <div class="tt-row">海拔 ${Math.round(data.elevation)}m · 含水 ${(data.moisture * 100).toFixed(0)}%</div>
      <div class="tt-row">状态 <span class="${data.fire === 1 ? 'tt-danger' : ''}">${state}</span>${asset}</div>
    `;
    this.tooltip.hidden = false;
    this.positionTooltip(event);
  }

  private positionTooltip(event: { global: { x: number; y: number } }): void {
    if (!this.tooltip) return;
    const rect = this.host.getBoundingClientRect();
    const x = Math.round(event.global.x + 14);
    const y = Math.round(event.global.y + 14);
    const flipX = x + 190 > rect.width;
    const flipY = y + 120 > rect.height;
    this.tooltip.style.left = `${flipX ? Math.max(8, x - 210) : x}px`;
    this.tooltip.style.top = `${flipY ? Math.max(8, y - 120) : y}px`;
  }
}

function escapeTooltip(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function shadeHex(hex: string, amount: number): number {
  return shade(hex, amount);
}
