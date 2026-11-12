import type { AppApi, Screen } from '../types';
import type { GameMap, DeploymentPlan, DeploymentUnit, UnitTypeId } from '../../sim/types';
import { generateMap, isDeployable } from '../../sim/mapgen';
import { MapRenderer } from '../../render/MapRenderer';
import { BUILTIN_STRATEGIES, buildAllStrategyPlans } from '../../strategies/strategy';
import {
  dateTimeLabel,
  escapeHtml,
  formatClock,
  formatNumber,
  icon,
  starMarkup,
  uid,
  windClassName,
  windFromLabel,
} from '../ui';

const TYPE_ICONS: Record<UnitTypeId, 'crew' | 'truck' | 'heli'> = {
  ground: 'crew',
  tender: 'truck',
  helicopter: 'heli',
};

export class DeploymentScreen implements Screen {
  private readonly app: AppApi;
  private root: HTMLElement | null = null;
  private mapRenderer: MapRenderer | null = null;
  private map: GameMap | null = null;
  private units: DeploymentUnit[] = [];
  private selectedType: UnitTypeId = 'ground';
  private selectedUnitId: string | null = null;
  private activeTemplate: string | null = null;

  constructor(app: AppApi) {
    this.app = app;
  }

  async mount(): Promise<void> {
    const mission = this.app.getActiveMission();
    const host = document.querySelector<HTMLElement>('#screen-host');
    if (!host) return;
    if (!mission) {
      host.innerHTML = `<div class="screen-inner empty-state">
        <div class="empty-mark">${icon('layers', 34)}</div>
        <div class="eyebrow">DEPLOYMENT / 部署</div>
        <h1>尚未选择战区</h1>
        <p>先在战役地图选择一处火场，再开始编组出动。</p>
        <button class="btn btn-primary" id="go-campaign">${icon('map', 16)} 返回战役地图</button>
      </div>`;
      host.querySelector('#go-campaign')?.addEventListener('click', () => this.app.navigate('campaign'));
      return;
    }

    const config = this.app.getConfig();
    const save = this.app.saveStore.get();
    this.map = generateMap(mission, config);
    const presets = save.deploymentPresets.filter((preset) => preset.missionId === mission.id);
    const templates = BUILTIN_STRATEGIES;

    this.root = document.createElement('div');
    this.root.className = 'screen-inner deployment-screen';
    this.root.innerHTML = `
      <div class="mission-strip">
        <div class="mission-strip-left">
          <button class="back-link" id="back-campaign">${icon('arrow', 14)} 战役地图</button>
          <div class="mission-title-block">
            <span class="eyebrow">${escapeHtml(mission.code)} / DEPLOYMENT · ${escapeHtml(mission.subtitle)}</span>
            <h1>${escapeHtml(mission.name)} <span>编组出动</span></h1>
          </div>
        </div>
        <div class="mission-strip-right">
          <div class="budget-widget">
            <div class="budget-meta"><span>可用预算</span><b id="budget-value">${mission.budget}</b><small>/${mission.budget} 点</small></div>
            <div class="budget-track"><div class="budget-fill" id="budget-fill"></div></div>
          </div>
          <button class="btn btn-ghost btn-sm" id="save-plan">${icon('save', 14)} 保存方案</button>
          <button class="btn btn-primary" id="start-command">${icon('play', 14)} 开始指挥</button>
        </div>
        <div class="mission-strip-meta">
          <span>${icon('clock', 13)} 时限 ${Math.round(mission.durationSec / 60)} 分钟</span>
          <span>${icon('flame', 13)} 过火上限 ${mission.maxBurnedHa} ha</span>
          <span>${icon('shield', 13)} 设施 ${mission.assets.length} 处</span>
          <span class="strip-wind ${windClassName(mission.weather.fromDeg)}">${icon('wind', 13)} ${windFromLabel(mission.weather.fromDeg)}风 ${mission.weather.speed.toFixed(1)} m/s</span>
        </div>
      </div>

      <div class="deployment-grid">
        <aside class="deployment-palette panel">
          <div class="panel-heading">
            <div><span class="eyebrow small">RESOURCES</span><h2>可用力量</h2></div>
            <span class="panel-count" id="palette-count">0 支</span>
          </div>
          <div class="unit-type-list" id="unit-type-list"></div>
          <div class="deploy-help">
            <div class="help-title">${icon('target', 14)} 布阵方法</div>
            <p>选择单位类型，然后点击地图上的可通行格。单位部署位置距初始火点至少 ${config.world.deploymentMinFireDistance} 格。</p>
            <p class="muted">水罐车沿道路速度更快；直升机无视断崖，但补给依赖水域。</p>
          </div>
          <div class="terrain-key">
            <div class="help-title">地形图例</div>
            <div class="key-grid">
              <span><i style="background:#284852"></i>水域 / 补水</span>
              <span><i style="background:#5a5d58"></i>断崖 / 不可通行</span>
              <span><i style="background:#8b846c"></i>林区道路</span>
              <span><i style="background:#4f714b"></i>针叶林 / 高燃料</span>
              <span><i style="background:#7e926a"></i>湿地 / 高含水</span>
              <span><i style="background:#a8ab68"></i>禾草 / 快蔓延</span>
            </div>
          </div>
          <div class="palette-hazard">
            <span class="mini-alert">${icon('alert', 13)} 初始火点</span>
            <p>火点已在地图以橙色标示。火势会立即开始蔓延，部署结束即进入实时推演。</p>
          </div>
        </aside>

        <section class="deployment-map-panel panel">
          <div class="map-topline">
            <div class="map-title">${icon('map', 15)} 火场态势 · ${escapeHtml(mission.name)}</div>
            <div class="map-tools-readout">${icon('target', 13)} 点击放置 · 单击已部署单位可选中</div>
          </div>
          <div class="deployment-map-wrap">
            <div id="deployment-map" class="map-surface"></div>
            <div class="map-hud map-hud-wind">
              <div class="wind-dial ${windClassName(mission.weather.fromDeg)}" data-from="${mission.weather.fromDeg}">${icon('wind', 19)}</div>
              <div><span class="hud-label">初始风场</span><b>${windFromLabel(mission.weather.fromDeg)}风 ${mission.weather.speed.toFixed(1)}<small>m/s</small></b></div>
            </div>
            <div class="map-hud map-hud-fire">
              <span class="pulse-dot"></span>
              <div><span class="hud-label">初始火点</span><b>${mission.ignition.x}, ${mission.ignition.y}</b></div>
            </div>
            <div class="map-coordinates map-coordinates-bottom">湿度 ${mission.weather.humidity}% · 气温 ${mission.weather.temperature}°C · 过火上限 ${mission.maxBurnedHa} ha</div>
            <div class="placement-hint" id="placement-hint">${icon('plus', 13)} 选择左侧单位后点击地图放置</div>
          </div>
          <div class="map-bottomline">
            <button class="btn btn-ghost btn-sm" id="clear-units">${icon('trash', 13)} 清空编组</button>
            <span class="map-scale">60 m / 格 · 网格战术图</span>
            <span class="map-legend-inline"><i class="legend-fire"></i>明火 <i class="legend-cliff"></i>断崖 <i class="legend-water"></i>水源</span>
          </div>
        </section>

        <aside class="deployment-right">
          <section class="panel dispatch-panel">
            <div class="panel-heading">
              <div><span class="eyebrow small">DISPATCH LIST</span><h2>出动清单</h2></div>
              <span class="panel-count" id="dispatch-count">0 支</span>
            </div>
            <div id="dispatch-list" class="dispatch-list"></div>
            <div class="dispatch-footer">
              <span>剩余预算</span><b id="remaining-budget">${mission.budget} 点</b>
            </div>
          </section>

          <section class="panel template-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">QUICK LOADOUT</span><h2>战术模板</h2></div>
            </div>
            <div class="template-list" id="template-list">
              ${templates.map((template) => `<button class="template-card" data-template="${template.id}">
                <span class="template-swatch" style="background:${template.color}"></span>
                <span class="template-copy"><b>${escapeHtml(template.name)}</b><small>${escapeHtml(template.description)}</small></span>
                ${icon('chevron', 13)}
              </button>`).join('')}
            </div>
            <div class="preset-block">
              <div class="preset-head"><span>方案库</span><span class="muted">${presets.length} 个</span></div>
              <div id="preset-list" class="preset-list"></div>
            </div>
          </section>

          <section class="panel objective-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">MISSION</span><h2>任务目标</h2></div>
              <span class="difficulty-inline">${'●'.repeat(mission.difficulty)}${'○'.repeat(Math.max(0, 5 - mission.difficulty))}</span>
            </div>
            <p class="objective-copy">${escapeHtml(mission.objective)}</p>
            <div class="asset-chips">${mission.assets.map((asset) => `<span class="asset-chip">${icon('shield', 12)} ${escapeHtml(asset.name)}</span>`).join('')}</div>
            <div class="forecast-mini">
              <div class="forecast-mini-title">${icon('wind', 13)} 阵风窗口</div>
              ${mission.windEvents.map((event) => `<div class="forecast-mini-row"><span>T+${formatClock(event.atSec)}</span><b>${windFromLabel(event.fromDeg)} ${event.speed.toFixed(0)}m/s</b></div>`).join('')}
            </div>
          </section>
        </aside>
      </div>
    `;
    host.replaceChildren(this.root);

    this.bindStatic();
    this.refreshUnitTypes();
    this.refreshLists();
    this.refreshBudget();

    const mapHost = this.root.querySelector<HTMLElement>('#deployment-map');
    if (mapHost) {
      this.mapRenderer = new MapRenderer(mapHost, 'deployment', config, {
        onCellAction: (cell) => this.placeAt(cell.x, cell.y),
        onUnitSelect: (unitId) => {
          this.selectedUnitId = unitId;
          this.refreshLists();
        },
      });
      await this.mapRenderer.initialize(this.map);
      this.mapRenderer.setPreviewUnits(this.units);
      this.mapRenderer.setTool('place');
    }
    this.refreshTargets();
  }

  unmount(): void {
    this.mapRenderer?.destroy();
    this.mapRenderer = null;
    this.root = null;
  }

  private bindStatic(): void {
    this.root?.querySelector('#back-campaign')?.addEventListener('click', () => this.app.navigate('campaign'));
    this.root?.querySelector('#start-command')?.addEventListener('click', () => this.startCommand());
    this.root?.querySelector('#save-plan')?.addEventListener('click', () => this.savePlan());
    this.root?.querySelector('#clear-units')?.addEventListener('click', () => {
      this.units = [];
      this.selectedUnitId = null;
      this.activeTemplate = null;
      this.mapRenderer?.setPreviewUnits(this.units);
      this.refreshLists();
      this.refreshBudget();
      this.app.toast('编组已清空');
    });
    this.root?.querySelectorAll<HTMLElement>('[data-template]').forEach((button) => {
      button.addEventListener('click', () => this.loadTemplate(button.dataset['template'] ?? ''));
    });
  }

  private refreshUnitTypes(): void {
    const config = this.app.getConfig();
    const list = this.root?.querySelector('#unit-type-list');
    if (!list) return;
    list.innerHTML = (Object.keys(config.units) as UnitTypeId[]).map((type) => {
      const cfg = config.units[type];
      const count = this.units.filter((unit) => unit.type === type).length;
      const disabled = count >= cfg.maxCount || this.remainingBudget() < cfg.cost;
      const active = this.selectedType === type;
      const stats = type === 'helicopter'
        ? `<span>载水 ${cfg.waterCapacity}L</span><span>吊桶 ${(cfg as typeof cfg & { bucketSize: number }).bucketSize}L</span><span>速度 ${cfg.speedCellsPerSec.toFixed(2)} 格/s</span>`
        : type === 'tender'
          ? `<span>载水 ${cfg.waterCapacity}L</span><span>射程 ${(cfg as typeof cfg & { sprayRange: number }).sprayRange.toFixed(1)} 格</span><span>速度 ${cfg.speedCellsPerSec.toFixed(2)} 格/s</span>`
          : `<span>载水 ${cfg.waterCapacity}L</span><span>射程 ${(cfg as typeof cfg & { sprayRange: number }).sprayRange.toFixed(1)} 格</span><span>可开挖隔离带</span>`;
      return `<button class="unit-type-card ${active ? 'active' : ''}" data-type="${type}" ${disabled ? 'disabled' : ''}>
        <span class="unit-type-icon" style="color:${cfg.color}">${icon(TYPE_ICONS[type], 24)}</span>
        <span class="unit-type-main">
          <span class="unit-type-name">${escapeHtml(cfg.name)} <em>${count}/${cfg.maxCount}</em></span>
          <span class="unit-type-stats">${stats}</span>
        </span>
        <span class="unit-type-cost">${cfg.cost}<small>点</small></span>
      </button>`;
    }).join('');
    list.querySelectorAll<HTMLElement>('[data-type]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedType = button.dataset['type'] as UnitTypeId;
        this.selectedUnitId = null;
        this.refreshUnitTypes();
        this.refreshLists();
        const hint = this.root?.querySelector('#placement-hint');
        if (hint) {
          const cfg = this.app.getConfig().units[this.selectedType];
          hint.innerHTML = `${icon('plus', 13)} 已选择 ${escapeHtml(cfg.name)} · 点击地图可部署`;
        }
      });
    });
    const enabledCount = (Object.keys(config.units) as UnitTypeId[]).filter((type) => this.units.some((unit) => unit.type === type)).length;
    const countEl = this.root?.querySelector('#palette-count');
    if (countEl) countEl.textContent = `${enabledCount} 类 / ${this.units.length} 支`;
  }

  private refreshLists(): void {
    const config = this.app.getConfig();
    const mission = this.app.getActiveMission();
    if (!mission) return;
    const listEl = this.root?.querySelector('#dispatch-list');
    if (listEl) {
      if (this.units.length === 0) {
        listEl.innerHTML = `<div class="dispatch-empty">${icon('layers', 20)}<p>尚未部署单位</p><span>从左侧力量面板选择，再点击地图放置。</span></div>`;
      } else {
        listEl.innerHTML = this.units.map((unit) => {
          const cfg = config.units[unit.type];
          return `<div class="dispatch-item ${this.selectedUnitId === unit.id ? 'selected' : ''}" data-unit="${escapeHtml(unit.id)}">
            <span class="dispatch-icon" style="color:${cfg.color}">${icon(TYPE_ICONS[unit.type], 17)}</span>
            <span class="dispatch-copy"><b>${escapeHtml(unit.name ?? cfg.shortName)}</b><small>${escapeHtml(cfg.shortName)} · ${unit.cell.x},${unit.cell.y}</small></span>
            <button class="icon-btn" data-remove="${escapeHtml(unit.id)}" aria-label="移除单位">${icon('trash', 14)}</button>
          </div>`;
        }).join('');
      }
      listEl.querySelectorAll<HTMLElement>('[data-remove]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const unitId = button.dataset['remove'];
          if (!unitId) return;
          this.units = this.units.filter((unit) => unit.id !== unitId);
          if (this.selectedUnitId === unitId) this.selectedUnitId = null;
          this.mapRenderer?.setPreviewUnits(this.units);
          this.refreshLists();
          this.refreshBudget();
          this.refreshUnitTypes();
        });
      });
      listEl.querySelectorAll<HTMLElement>('[data-unit]').forEach((item) => {
        item.addEventListener('click', () => {
          this.selectedUnitId = item.dataset['unit'] ?? null;
          this.refreshLists();
        });
      });
    }
    const dispatchCount = this.root?.querySelector('#dispatch-count');
    if (dispatchCount) dispatchCount.textContent = `${this.units.length} 支`;
    const remaining = this.root?.querySelector('#remaining-budget');
    if (remaining) remaining.textContent = `${this.remainingBudget()} 点`;

    const presetEl = this.root?.querySelector('#preset-list');
    if (presetEl) {
      const presets = this.app.saveStore.get().deploymentPresets.filter((preset) => preset.missionId === mission.id);
      presetEl.innerHTML = presets.length === 0
        ? '<div class="preset-empty">保存当前编组后会出现在这里。</div>'
        : presets.map((preset) => `<div class="preset-row">
          <div class="preset-copy"><b>${escapeHtml(preset.name)}</b><small>${preset.units.length} 支 · ${dateTimeLabel(preset.createdAt)}</small></div>
          <button class="btn btn-ghost btn-xs" data-load-preset="${escapeHtml(preset.id)}">载入</button>
          <button class="icon-btn" data-delete-preset="${escapeHtml(preset.id)}" aria-label="删除方案">${icon('trash', 13)}</button>
        </div>`).join('');
      presetEl.querySelectorAll<HTMLElement>('[data-load-preset]').forEach((button) => {
        button.addEventListener('click', () => {
          const preset = this.app.saveStore.get().deploymentPresets.find((item) => item.id === button.dataset['loadPreset']);
          if (!preset) return;
          this.units = preset.units.map((unit) => ({ ...unit, cell: { ...unit.cell } }));
          this.activeTemplate = preset.templateId ?? null;
          this.selectedUnitId = null;
          this.mapRenderer?.setPreviewUnits(this.units);
          this.refreshLists();
          this.refreshBudget();
          this.refreshUnitTypes();
          this.app.toast(`已载入方案「${preset.name}」`, { level: 'success' });
        });
      });
      presetEl.querySelectorAll<HTMLElement>('[data-delete-preset]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset['deletePreset'];
          if (!id) return;
          this.app.saveStore.removePreset(id);
          this.refreshLists();
          this.app.toast('方案已删除');
        });
      });
    }
    this.refreshTargets();
    this.refreshBudget();
    this.refreshUnitTypes();
  }

  private refreshBudget(): void {
    const mission = this.app.getActiveMission();
    if (!mission) return;
    const spent = this.units.reduce((sum, unit) => sum + this.app.getConfig().units[unit.type].cost, 0);
    const value = this.root?.querySelector('#budget-value');
    const fill = this.root?.querySelector<HTMLElement>('#budget-fill');
    if (value) value.textContent = String(Math.max(0, mission.budget - spent));
    if (fill) {
      fill.style.width = `${Math.min(100, spent / mission.budget * 100)}%`;
      fill.classList.toggle('over', spent > mission.budget);
    }
  }

  private refreshTargets(): void {
    const mission = this.app.getActiveMission();
    if (!mission) return;
    const count = this.root?.querySelector('#dispatch-count');
    if (count) count.textContent = `${this.units.length} 支`;
    const start = this.root?.querySelector<HTMLButtonElement>('#start-command');
    if (start) {
      const valid = this.units.length > 0 && this.remainingBudget() >= 0;
      start.disabled = !valid;
      start.classList.toggle('pulse-ready', valid);
      start.innerHTML = valid
        ? `${icon('play', 14)} 开始指挥 · ${this.units.length} 支`
        : `${icon('play', 14)} 至少部署 1 支单位`;
    }
  }

  private remainingBudget(): number {
    const mission = this.app.getActiveMission();
    if (!mission) return 0;
    return mission.budget - this.units.reduce((sum, unit) => sum + this.app.getConfig().units[unit.type].cost, 0);
  }

  private placeAt(x: number, y: number): void {
    const mission = this.app.getActiveMission();
    const config = this.app.getConfig();
    if (!mission || !this.map) return;
    const cfg = config.units[this.selectedType];
    if (this.units.filter((unit) => unit.type === this.selectedType).length >= cfg.maxCount) {
      this.app.toast(`${cfg.name} 已达到上限 ${cfg.maxCount} 支`, { level: 'warning' });
      return;
    }
    if (this.remainingBudget() < cfg.cost) {
      this.app.toast('预算不足，无法继续部署此单位', { level: 'warning' });
      return;
    }
    if (!isDeployable(this.map, x, y, config)) {
      this.app.toast('该格不可部署：水域、断崖、地图边缘或距火点太近', { level: 'warning' });
      return;
    }
    const cell = this.map.cells[y][x];
    if (cell.asset) {
      this.app.toast('设施格不能作为部署位置', { level: 'warning' });
      return;
    }
    if (this.units.some((unit) => unit.cell.x === x && unit.cell.y === y)) {
      this.app.toast('该格已有单位', { level: 'warning' });
      return;
    }
    const count = this.units.filter((unit) => unit.type === this.selectedType).length + 1;
    this.units.push({
      id: uid(this.selectedType),
      type: this.selectedType,
      cell: { x, y },
      name: `${cfg.shortName} ${String(count).padStart(2, '0')}`,
    });
    this.activeTemplate = null;
    this.selectedUnitId = this.units[this.units.length - 1].id;
    this.mapRenderer?.setPreviewUnits(this.units);
    this.refreshLists();
    this.refreshBudget();
    this.refreshUnitTypes();
    this.app.toast(`${cfg.shortName} 已在 ${x},${y} 就位`, { level: 'success' });
  }

  private loadTemplate(templateId: string): void {
    const mission = this.app.getActiveMission();
    const config = this.app.getConfig();
    if (!mission) return;
    const all = buildAllStrategyPlans(mission, config);
    const entry = all.find((item) => item.strategy.id === templateId);
    if (!entry) return;
    this.units = entry.plan.units.map((unit) => ({ ...unit, id: uid(unit.type), cell: { ...unit.cell } }));
    this.activeTemplate = entry.strategy.id;
    this.selectedUnitId = null;
    this.mapRenderer?.setPreviewUnits(this.units);
    this.refreshLists();
    this.refreshBudget();
    this.refreshUnitTypes();
    this.app.toast(`已载入模板「${entry.strategy.name}」，可继续微调部署`, { level: 'success' });
  }

  private savePlan(): void {
    const mission = this.app.getActiveMission();
    if (!mission || this.units.length === 0) {
      this.app.toast('至少部署 1 支单位后才能保存方案', { level: 'warning' });
      return;
    }
    const name = window.prompt('给这次部署方案起个名字：', `${mission.name} · 自定义方案`);
    if (!name) return;
    const preset = {
      id: uid('preset'),
      name: name.trim().slice(0, 30),
      missionId: mission.id,
      units: this.units.map((unit) => ({ ...unit, cell: { ...unit.cell } })),
      createdAt: new Date().toISOString(),
      templateId: this.activeTemplate ?? undefined,
    };
    this.app.saveStore.addPreset(preset);
    this.refreshLists();
    this.app.toast('方案已保存到本地存档，可用于批量推演对比', { level: 'success' });
  }

  private startCommand(): void {
    const mission = this.app.getActiveMission();
    if (!mission) return;
    if (this.units.length === 0) {
      this.app.toast('请先部署至少一支单位', { level: 'warning' });
      return;
    }
    if (this.remainingBudget() < 0) {
      this.app.toast('部署超出预算，请先移除部分单位', { level: 'warning' });
      return;
    }
    const plan: DeploymentPlan = {
      missionId: mission.id,
      name: this.activeTemplate
        ? BUILTIN_STRATEGIES.find((template) => template.id === this.activeTemplate)?.name ?? '自定义部署'
        : '自定义部署',
      templateId: this.activeTemplate ?? undefined,
      units: this.units.map((unit) => ({ ...unit, cell: { ...unit.cell } })),
    };
    this.app.launchSimulation(plan);
    this.app.navigate('command');
  }
}
