import type { AppApi, Screen } from '../types';
import type { MissionResult, SimEvent, Unit, UnitTypeId, ToolMode } from '../../sim/types';
import type { Simulation } from '../../sim/engine';
import { MapRenderer } from '../../render/MapRenderer';
import { BEHAVIOR_LABELS } from '../../sim/behavior';
import { compassLabel } from '../../sim/engine';
import {
  dateTimeLabel,
  escapeHtml,
  formatClock,
  formatHa,
  formatNumber,
  icon,
  starMarkup,
  starsText,
  windClassName,
  windFromLabel,
} from '../ui';

const TYPE_ICONS: Record<UnitTypeId, 'crew' | 'truck' | 'heli'> = {
  ground: 'crew',
  tender: 'truck',
  helicopter: 'heli',
};

const BT_BRANCHES = [
  { id: 'sos-act', label: '被困求救' },
  { id: 'safety-act', label: '危险避险' },
  { id: 'resupply-act', label: '低水位补水' },
  { id: 'command-act', label: '执行玩家指令' },
  { id: 'break-act', label: '开挖隔离带' },
  { id: 'fight-act', label: '发现火情 / 扑救' },
  { id: 'idle-act', label: '原地警戒' },
];

const TOOL_INFO: Record<ToolMode, { label: string; hint: string; icon: 'target' | 'break' | 'drop' | 'backfire'; key: string }> = {
  inspect: { label: '态势', hint: '点击单位查看行为树；悬停格子查看燃料与含水率。', icon: 'target', key: 'I' },
  break: { label: '隔离带', hint: '在地图上按住拖出一条线，扑火队会就近前往开挖。', icon: 'break', key: 'B' },
  drop: { label: '洒水', hint: '点选目标格，最近的直升机或水罐车将自动响应。', icon: 'drop', key: 'D' },
  backfire: { label: '逆火', hint: '点选未燃格点燃逆火；需 7 格内有地面扑火队。', icon: 'backfire', key: 'F' },
  place: { label: '部署', hint: '部署阶段使用。', icon: 'target', key: '' },
};

export class CommandScreen implements Screen {
  private readonly app: AppApi;
  private simulation: Simulation | null = null;
  private root: HTMLElement | null = null;
  private mapRenderer: MapRenderer | null = null;
  private raf = 0;
  private lastFrame = 0;
  private lastPanelRefresh = 0;
  private playing = false;
  private speed = 1;
  private selectedUnitId: string | null = null;
  private tool: ToolMode = 'inspect';
  private selectedSignature = '';
  private lastEventId = -1;
  private lastAlertKey = '';
  private recorded = false;
  private finishedShown = false;
  private briefingDismissed = false;

  constructor(app: AppApi) {
    this.app = app;
  }

  async mount(): Promise<void> {
    const host = document.querySelector<HTMLElement>('#screen-host');
    if (!host) return;
    const simulation = this.app.getActiveSimulation();
    this.simulation = simulation;
    if (!simulation) {
      host.innerHTML = `<div class="screen-inner empty-state">
        <div class="empty-mark">${icon('compass', 34)}</div>
        <div class="eyebrow">COMMAND / 指挥</div>
        <h1>没有正在进行的推演</h1>
        <p>先在战役地图选择战区并完成编组，指挥台会在火情出现后接入。</p>
        <div class="empty-actions"><button class="btn btn-primary" id="go-deploy">${icon('layers', 16)} 前往部署</button><button class="btn btn-ghost" id="go-campaign">${icon('map', 16)} 战役地图</button></div>
      </div>`;
      host.querySelector('#go-deploy')?.addEventListener('click', () => {
        if (this.app.getActiveMission()) this.app.navigate('deployment');
        else this.app.navigate('campaign');
      });
      host.querySelector('#go-campaign')?.addEventListener('click', () => this.app.navigate('campaign'));
      return;
    }

    this.root = document.createElement('div');
    this.root.className = 'screen-inner command-screen';
    this.root.innerHTML = `
      <header class="command-topbar">
        <div class="command-title">
          <button class="back-link" id="command-back">${icon('arrow', 14)} 战役</button>
          <div class="ops-id"><span class="ops-code">${escapeHtml(simulation.scenario.code)}</span><strong>${escapeHtml(simulation.scenario.name)}</strong><span class="ops-sub">火场指挥台</span></div>
        </div>
        <div class="command-status">
          <span class="status-chip" id="status-chip"><i></i><span>待命</span></span>
          <span class="ops-clock"><b id="sim-clock">00:00</b><small>/ ${formatClock(simulation.duration)}</small></span>
          <div class="time-progress"><div id="time-progress-fill"></div></div>
        </div>
        <div class="command-controls">
          <button class="control-btn" id="btn-pause" title="暂停 / 继续">${icon('pause', 16)}</button>
          <div class="speed-group" role="group" aria-label="推演速度">
            ${[1, 2, 4].map((value) => `<button class="speed-btn ${value === 1 ? 'active' : ''}" data-speed="${value}">${value}×</button>`).join('')}
          </div>
          <span class="control-divider"></span>
          <button class="btn btn-ghost btn-sm" id="btn-end">结束推演</button>
        </div>
      </header>

      <div class="command-grid">
        <aside class="command-units panel">
          <div class="panel-heading">
            <div><span class="eyebrow small">FIELD UNITS</span><h2>现场单位</h2></div>
            <span class="panel-count" id="unit-count">${simulation.units.length} 支</span>
          </div>
          <div class="unit-roster" id="unit-roster"></div>
          <div class="selected-unit" id="selected-unit"></div>
          <div class="command-unit-actions">
            <button class="btn btn-ghost btn-sm" id="clear-break">${icon('refresh', 13)} 取消隔离带计划</button>
            <button class="btn btn-ghost btn-sm danger-ghost" id="retreat-all">${icon('alert', 13)} 全员撤离</button>
          </div>
        </aside>

        <section class="command-map-panel panel">
          <div id="command-map" class="map-surface command-map-surface"></div>
          <div class="command-map-top">
            <div class="map-live-title">
              <span class="live-dot"></span>
              <div><span class="hud-label">LIVE OPERATION</span><b>${escapeHtml(simulation.scenario.name)} · ${escapeHtml(simulation.scenario.subtitle)}</b></div>
            </div>
            <div class="wind-hud" id="wind-hud">
              <div class="wind-arrow-wrap"><span id="wind-arrow">${icon('arrow', 22)}</span></div>
              <div><span class="hud-label">风场 / WIND</span><b><span id="wind-direction">${escapeHtml(windFromLabel(simulation.windState.fromDeg))}</span>风 <span id="wind-speed">${simulation.windState.speed.toFixed(1)}</span><small>m/s</small></b></div>
            </div>
          </div>
          <div class="alert-stack" id="alert-stack"></div>
          <div class="map-tool-panel" id="tool-panel">
            ${(Object.keys(TOOL_INFO) as ToolMode[]).filter((tool) => tool !== 'place').map((tool) => `<button class="tool-btn ${tool === 'inspect' ? 'active' : ''}" data-tool="${tool}" title="${escapeHtml(TOOL_INFO[tool].hint)}">
              ${icon(TOOL_INFO[tool].icon, 18)}
              <span>${TOOL_INFO[tool].label}</span>
              <kbd>${TOOL_INFO[tool].key}</kbd>
            </button>`).join('')}
          </div>
          <div class="tool-hint" id="tool-hint">${escapeHtml(TOOL_INFO.inspect.hint)}</div>
          <div class="command-map-bottom">
            <div class="map-legend-inline"><span class="legend-fire"></span>明火 <span class="legend-ash"></span>过火 <span class="legend-break"></span>隔离带 <span class="legend-wet"></span>洒水</div>
            <span class="map-coordinates-bottom">GRID ${simulation.map.cols} × ${simulation.map.rows} · 1 格 = ${simulation.config.meta.cellSizeMeters}m</span>
          </div>
          ${this.startOverlayMarkup()}
        </section>

        <aside class="command-side">
          <section class="panel fire-stats-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">FIRE SITUATION</span><h2>火情快照</h2></div>
              <span class="live-tag"><i></i>实时</span>
            </div>
            <div class="fire-stat-hero">
              <div><span class="stat-label">过火面积</span><b id="stat-burned">0.0<small>ha</small></b></div>
              <div class="fire-hero-right"><span>预案余量</span><b id="stat-remaining">100<small>%</small></b></div>
            </div>
            <div class="stat-progress"><div id="burned-progress"></div></div>
            <div class="stats-grid">
              <div><span>明火格</span><b id="stat-burning">0</b></div>
              <div><span>已扑灭火点</span><b id="stat-suppressed">0</b></div>
              <div><span>隔离带</span><b id="stat-breaks">0<small>格</small></b></div>
              <div><span>设施完好</span><b id="stat-assets">${simulation.assetsProtected}<small>/${simulation.scenario.assets.length}</small></b></div>
              <div><span>用水</span><b id="stat-water">0<small>t</small></b></div>
              <div><span>失联单位</span><b id="stat-units-lost">0</b></div>
            </div>
            <div class="objective-mini">
              <span>${icon('shield', 13)} 守住 ${escapeHtml(simulation.scenario.assets.map((asset) => asset.name).join(' · '))}</span>
            </div>
          </section>

          <section class="panel forecast-command-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">WIND WINDOW</span><h2>风场预报</h2></div>
              <span class="wind-tag ${windClassName(simulation.windState.fromDeg)}">${icon('wind', 12)} <span id="forecast-current">${windFromLabel(simulation.windState.fromDeg)}</span></span>
            </div>
            <div class="wind-alert-slot" id="wind-alert-slot"></div>
            <div class="forecast-timeline" id="forecast-timeline"></div>
            <div class="wind-help">风向突变前会提前预警。突变发生后火头可能在数十秒内偏转，提前 5–15 秒调整部署。</div>
          </section>

          <section class="panel event-log-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">RADIO LOG</span><h2>作战日志</h2></div>
              <span class="panel-count" id="event-count">0</span>
            </div>
            <div class="event-log" id="event-log"></div>
          </section>
        </aside>
      </div>
    `;
    host.replaceChildren(this.root);

    this.bindStatic();
    this.buildRoster();
    this.refresh(true);
    this.updateControlState();

    const mapHost = this.root.querySelector<HTMLElement>('#command-map');
    if (mapHost) {
      this.mapRenderer = new MapRenderer(mapHost, 'command', simulation.config, {
        onCellAction: (cell, tool) => this.handleCellAction(cell, tool),
        onBreakLine: (cells) => this.handleBreakLine(cells),
        onUnitSelect: (unitId) => this.selectUnit(unitId),
      });
      await this.mapRenderer.initialize(simulation.map);
      this.mapRenderer.setSimulation(simulation);
      this.mapRenderer.setTool(this.tool);
    }

    window.addEventListener('keydown', this.onKeyDown);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    if (simulation.time > 0 && !simulation.finished) {
      this.playing = false;
      this.briefingDismissed = true;
      this.removeBriefing();
    }
    if (simulation.finished) {
      this.finishedShown = false;
      this.ensureFinished();
    }
  }

  unmount(): void {
    this.playing = false;
    this.simulation = null;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    this.mapRenderer?.destroy();
    this.mapRenderer = null;
    this.root = null;
  }

  private startOverlayMarkup(): string {
    const simulation = this.simulation!;
    const mission = simulation.scenario;
    return `<div class="briefing-overlay" id="briefing-overlay">
      <div class="briefing-card">
        <div class="briefing-stripe"></div>
        <div class="briefing-head">
          <div><span class="eyebrow">OPERATION BRIEF / 行动简报</span><h2>${escapeHtml(mission.name)} · 实时指挥</h2></div>
          <span class="briefing-code">${escapeHtml(mission.code)}</span>
        </div>
        <p class="briefing-text">${escapeHtml(mission.briefing)}</p>
        <div class="briefing-objective">${icon('target', 14)} ${escapeHtml(mission.objective)}</div>
        <div class="briefing-grid">
          <div><span>编组</span><b>${simulation.units.length} 支单位</b></div>
          <div><span>预算</span><b>${this.deploymentBudget()} 点</b></div>
          <div><span>时限</span><b>${Math.round(mission.durationSec / 60)} 分钟</b></div>
          <div><span>初始风</span><b>${windFromLabel(simulation.windState.fromDeg)} ${simulation.windState.speed.toFixed(1)}m/s</b></div>
        </div>
        <div class="briefing-note">${icon('info', 14)} 风变预警会在屏幕上方出现。你可以暂停、改变速度，或随时使用隔离带 / 洒水 / 逆火工具。</div>
        <button class="btn btn-primary btn-lg" id="start-simulation">${icon('play', 15)} 启动推演</button>
      </div>
    </div>`;
  }

  private deploymentBudget(): number {
    const simulation = this.simulation;
    if (!simulation) return 0;
    return simulation.deployment.units.reduce(
      (sum, unit) => sum + simulation.config.units[unit.type].cost,
      0,
    );
  }

  private bindStatic(): void {
    this.root?.querySelector('#command-back')?.addEventListener('click', () => this.app.navigate('campaign'));
    this.root?.querySelector('#btn-pause')?.addEventListener('click', () => this.togglePause());
    this.root?.querySelector('#btn-end')?.addEventListener('click', () => this.endEarly());
    this.root?.querySelector('#start-simulation')?.addEventListener('click', () => this.startSimulation());
    this.root?.querySelectorAll<HTMLElement>('[data-speed]').forEach((button) => {
      button.addEventListener('click', () => {
        this.speed = Number(button.dataset['speed'] ?? '1');
        this.root?.querySelectorAll<HTMLElement>('[data-speed]').forEach((item) => item.classList.toggle('active', item === button));
      });
    });
    this.root?.querySelectorAll<HTMLElement>('[data-tool]').forEach((button) => {
      button.addEventListener('click', () => this.setTool(button.dataset['tool'] as ToolMode));
    });
    this.root?.querySelector('#clear-break')?.addEventListener('click', () => {
      this.simulation?.clearBreakPlan();
      this.refresh(true);
    });
    this.root?.querySelector('#retreat-all')?.addEventListener('click', () => {
      if (!this.simulation || this.simulation.finished) return;
      if (window.confirm('确认下达全员撤离命令？所有单位将脱离火线，未完成的隔离带作业会中止。')) {
        this.simulation.orderRetreatAll();
        this.refresh(true);
      }
    });
    this.root?.querySelector('#tool-panel')?.addEventListener('click', () => {
      this.refreshToolHint();
    });
    this.root?.querySelector('#alert-stack')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLElement>('[data-locate]');
      if (button) {
        const unitId = button.dataset['locate'];
        if (unitId) this.selectUnit(unitId);
      }
    });
  }

  private startSimulation(): void {
    this.briefingDismissed = true;
    this.playing = true;
    this.removeBriefing();
    this.updateControlState();
    this.app.toast('推演已启动，注意风变预警', { level: 'success' });
  }

  private removeBriefing(): void {
    this.root?.querySelector('#briefing-overlay')?.remove();
  }

  private togglePause(): void {
    if (!this.simulation || this.simulation.finished) return;
    this.briefingDismissed = true;
    this.removeBriefing();
    this.playing = !this.playing;
    this.updateControlState();
  }

  private setTool(tool: ToolMode): void {
    this.tool = tool;
    this.mapRenderer?.setTool(tool);
    this.root?.querySelectorAll<HTMLElement>('[data-tool]').forEach((item) => {
      item.classList.toggle('active', item.dataset['tool'] === tool);
    });
    this.refreshToolHint();
  }

  private refreshToolHint(): void {
    const hint = this.root?.querySelector('#tool-hint');
    if (hint) hint.textContent = TOOL_INFO[this.tool].hint;
  }

  private updateControlState(): void {
    if (!this.root) return;
    const pause = this.root.querySelector<HTMLButtonElement>('#btn-pause');
    if (pause) {
      pause.innerHTML = this.playing ? icon('pause', 16) : icon('play', 16);
      pause.classList.toggle('playing', this.playing);
    }
    const chip = this.root.querySelector('#status-chip');
    if (chip) {
      const simulation = this.simulation;
      const text = !simulation ? '待命' : simulation.finished ? '已结束' : this.playing ? '推演中' : '已暂停';
      chip.innerHTML = `<i class="${this.playing ? 'on' : ''}"></i><span>${text}</span>`;
      chip.classList.toggle('active', this.playing);
      chip.classList.toggle('finished', Boolean(simulation?.finished));
    }
    const disabled = !this.simulation || this.simulation.finished;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool], #retreat-all, #clear-break, #btn-end, #btn-pause').forEach((button) => {
      button.disabled = disabled;
    });
  }

  private loop = (now: number): void => {
    if (!this.simulation) return;
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.playing && this.briefingDismissed && !this.simulation.finished) {
      this.simulation.update(dt * this.speed);
    }
    if (now - this.lastPanelRefresh > 180) {
      this.lastPanelRefresh = now;
      this.refresh();
    }
    if (this.simulation.finished && !this.recorded) {
      this.ensureFinished();
    }
    if (this.simulation.finished) {
      this.playing = false;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private ensureFinished(): void {
    const simulation = this.simulation;
    if (!simulation?.result) return;
    if (!this.recorded) {
      this.recorded = true;
      this.app.recordSimulation(simulation);
    }
    this.updateControlState();
    if (!this.finishedShown) {
      this.finishedShown = true;
      this.showResultOverlay(simulation.result);
    }
  }

  private refresh(force = false): void {
    if (!this.simulation || !this.root) return;
    const simulation = this.simulation;
    const snapshot = simulation.getSnapshot();
    const clock = this.root.querySelector('#sim-clock');
    if (clock) clock.textContent = formatClock(simulation.time);
    const fill = this.root.querySelector<HTMLElement>('#time-progress-fill');
    if (fill) fill.style.width = `${Math.min(100, simulation.time / simulation.duration * 100)}%`;
    const statusChip = this.root.querySelector('#status-chip');
    if (statusChip) {
      const text = simulation.finished ? '已结束' : this.playing ? '推演中' : '已暂停';
      if (!statusChip.textContent?.includes(text)) {
        statusChip.innerHTML = `<i class="${this.playing ? 'on' : ''}"></i><span>${text}</span>`;
      }
      statusChip.classList.toggle('active', this.playing);
      statusChip.classList.toggle('finished', simulation.finished);
    }
    const wind = snapshot.wind;
    const dir = this.root.querySelector('#wind-direction');
    const speed = this.root.querySelector('#wind-speed');
    const arrow = this.root.querySelector<HTMLElement>('#wind-arrow');
    if (dir) dir.textContent = windFromLabel(wind.fromDeg);
    if (speed) speed.textContent = wind.speed.toFixed(1);
    if (arrow) arrow.style.transform = `rotate(${wind.fromDeg + 90}deg)`;
    const currentTag = this.root.querySelector('#forecast-current');
    if (currentTag) currentTag.textContent = `${compassLabel(wind.fromDeg)} ${wind.speed.toFixed(1)}m/s`;

    this.updateStats(snapshot);
    this.updateRoster();
    this.updateSelectedUnit();
    this.updateForecastPanel();
    this.updateEvents();
    this.updateAlertStack();
    this.updateWindAlertSlot();
    if (force) {
      this.updateControlState();
    }
  }

  private updateStats(snapshot: ReturnType<Simulation['getSnapshot']>): void {
    if (!this.root) return;
    const mission = this.simulation!.scenario;
    const burnedEl = this.root.querySelector('#stat-burned');
    if (burnedEl) burnedEl.innerHTML = `${formatNumber(snapshot.burnedHa, snapshot.burnedHa < 10 ? 1 : 0)}<small>ha</small>`;
    const remainEl = this.root.querySelector('#stat-remaining');
    if (remainEl) remainEl.innerHTML = `${Math.max(0, Math.round(100 - snapshot.burnedHa / Math.max(1, mission.maxBurnedHa) * 100))}<small>%</small>`;
    const progress = this.root.querySelector<HTMLElement>('#burned-progress');
    if (progress) progress.style.width = `${Math.min(100, snapshot.burnedHa / Math.max(1, mission.maxBurnedHa) * 100)}%`;
    const set = (selector: string, value: string) => {
      const element = this.root!.querySelector(selector);
      if (element) element.innerHTML = value;
    };
    set('#stat-burning', `${snapshot.burningCells}`);
    set('#stat-suppressed', `${snapshot.suppressedCells}`);
    set('#stat-breaks', `${snapshot.firebreakCells}<small>格</small>`);
    set('#stat-assets', `${snapshot.assetsTotal - snapshot.assetsLost}<small>/${snapshot.assetsTotal}</small>`);
    set('#stat-water', `${(snapshot.waterUsed / 1000).toFixed(1)}<small>t</small>`);
    set('#stat-units-lost', `${snapshot.unitsLost}`);
    const unitCount = this.root.querySelector('#unit-count');
    if (unitCount) unitCount.textContent = `${this.simulation!.units.filter((unit) => !unit.lost).length} 支`;
  }

  private buildRoster(): void {
    const roster = this.root?.querySelector('#unit-roster');
    if (!roster || !this.simulation) return;
    const config = this.simulation.config;
    roster.innerHTML = this.simulation.units.map((unit) => {
      const cfg = config.units[unit.type];
      return `<button class="unit-card" data-unit-id="${escapeHtml(unit.id)}" style="--unit-color:${cfg.color}">
        <span class="uc-icon">${icon(TYPE_ICONS[unit.type], 18)}</span>
        <span class="uc-main">
          <span class="uc-name">${escapeHtml(unit.name)}<small>${escapeHtml(cfg.shortName)}</small></span>
          <span class="uc-state">待命</span>
          <span class="uc-water"><i></i></span>
        </span>
        <span class="uc-status-dot"></span>
      </button>`;
    }).join('');
    roster.querySelectorAll<HTMLElement>('[data-unit-id]').forEach((button) => {
      button.addEventListener('click', () => this.selectUnit(button.dataset['unitId'] ?? null));
    });
  }

  private updateRoster(): void {
    if (!this.simulation || !this.root) return;
    for (const unit of this.simulation.units) {
      const card = this.root.querySelector<HTMLElement>(`[data-unit-id="${cssEscape(unit.id)}"]`);
      if (!card) continue;
      const state = card.querySelector('.uc-state');
      const water = card.querySelector<HTMLElement>('.uc-water i');
      if (state) state.textContent = unit.state;
      if (water) water.style.width = `${Math.max(0, Math.min(100, unit.water / Math.max(1, unit.waterCapacity) * 100))}%`;
      card.classList.toggle('selected', unit.id === this.selectedUnitId);
      card.classList.toggle('trapped', unit.state === '被困求救');
      card.classList.toggle('lost', unit.lost);
      card.classList.toggle('working', unit.state === '扑救' || unit.state === '吊桶作业' || unit.state === '开挖隔离带');
      card.classList.toggle('resupplying', unit.state === '补水');
    }
  }

  private updateSelectedUnit(): void {
    if (!this.root || !this.simulation) return;
    const panel = this.root.querySelector('#selected-unit');
    if (!panel) return;
    const unit = this.selectedUnitId ? this.simulation.getUnit(this.selectedUnitId) : null;
    if (!unit) {
      panel.innerHTML = `<div class="selected-empty">${icon('target', 15)}<span>点击地图单位或左侧卡片查看行为树与任务。</span></div>`;
      this.selectedSignature = '';
      return;
    }
    const signature = `${unit.id}|${unit.state}|${Math.round(unit.water)}|${unit.btNode}|${unit.action}|${Math.round(unit.pos.x * 4)}|${Math.round(unit.pos.y * 4)}`;
    if (signature === this.selectedSignature) return;
    this.selectedSignature = signature;
    const cfg = this.simulation.config.units[unit.type];
    const waterPct = Math.round(unit.water / Math.max(1, unit.waterCapacity) * 100);
    const activeNode = unit.btNode.replace('-act', '-act');
    const branches = BT_BRANCHES.map((branch) => `<div class="bt-branch ${unit.btNode === branch.id ? 'active' : ''}">
      <span class="bt-dot"></span><span>${escapeHtml(branch.label)}</span>
      ${unit.btNode === branch.id ? '<em>执行中</em>' : ''}
    </div>`).join('');
    panel.innerHTML = `<div class="su-head">
      <div><span class="eyebrow small">SELECTED UNIT</span><h3>${escapeHtml(unit.name)}</h3></div>
      <span class="su-state ${unit.state === '被困求救' ? 'danger' : ''}">${escapeHtml(unit.state)}</span>
    </div>
    <div class="su-water-line"><span>水量 ${Math.round(unit.water)} / ${unit.waterCapacity} L</span><b>${waterPct}%</b></div>
    <div class="su-water"><i style="width:${waterPct}%"></i></div>
    <div class="su-action"><span>当前行动</span>${escapeHtml(unit.action)}</div>
    <div class="su-bt">
      <div class="su-bt-title">${icon('layers', 12)} 行为树优先级 <em>${escapeHtml(BEHAVIOR_LABELS[unit.btNode] ?? unit.btNode)}</em></div>
      ${branches}
    </div>
    <div class="su-buttons">
      <button class="btn btn-ghost btn-xs" data-unit-action="retreat">${icon('alert', 12)} 命令撤离</button>
      <button class="btn btn-ghost btn-xs" data-unit-action="clear">${icon('refresh', 12)} 取消指令</button>
      <span class="su-coord">${Math.round(unit.pos.x)}, ${Math.round(unit.pos.y)}</span>
    </div>`;
    panel.querySelectorAll<HTMLElement>('[data-unit-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!this.simulation || this.simulation.finished) return;
        if (button.dataset['unitAction'] === 'retreat') {
          this.simulation.orderUnitRetreat(unit.id);
        } else {
          this.simulation.cancelOrder(unit.id);
        }
        this.refresh(true);
      });
    });
    void activeNode;
  }

  private updateForecastPanel(): void {
    if (!this.simulation || !this.root) return;
    const timeline = this.root.querySelector('#forecast-timeline');
    if (!timeline) return;
    const sim = this.simulation;
    const current = sim.windState;
    const upcoming = sim.scenario.windEvents.filter((event) => event.atSec + event.transitionSec > sim.time).slice(0, 4);
    const rows = upcoming.map((event, index) => {
      const isNow = sim.time >= event.atSec - event.warnSec && sim.time <= event.atSec + event.transitionSec;
      const remaining = event.atSec - sim.time;
      const status = remaining > 0 ? `${Math.round(remaining)}s 后` : '转向中';
      return `<div class="fc-row ${isNow ? 'critical' : ''}">
        <span class="fc-index">0${index + 1}</span>
        <span class="fc-copy"><b>${escapeHtml(event.label)}</b><small>${windFromLabel(current.fromDeg)} → ${windFromLabel(event.fromDeg)} · ${event.speed.toFixed(1)} m/s</small></span>
        <span class="fc-time">${status}</span>
      </div>`;
    }).join('');
    timeline.innerHTML = rows || '<div class="forecast-empty compact">风场进入稳定窗口，后续无新增强风过程。</div>';

    const windAlertSlot = this.root.querySelector('#wind-alert-slot');
    if (windAlertSlot) {
      const alert = sim.getWindAlert();
      if (!alert) {
        windAlertSlot.innerHTML = `<div class="wind-alert-inline stable">${icon('wind', 14)} <span>当前风场稳定，继续保持观察。</span></div>`;
      } else {
        windAlertSlot.innerHTML = `<div class="wind-alert-inline ${alert.severity}">${icon('alert', 14)}<span>${escapeHtml(alert.title)} · <b>${alert.secondsUntil > 0 ? `${Math.round(alert.secondsUntil)}s` : 'TRANSITION'}</b></span></div>`;
      }
    }
  }

  private updateEvents(): void {
    if (!this.simulation || !this.root) return;
    const log = this.root.querySelector('#event-log');
    if (!log) return;
    const events = this.simulation.events;
    const latestId = events.length > 0 ? events[events.length - 1].id : 0;
    if (latestId === this.lastEventId) return;
    this.lastEventId = latestId;
    const visible = events.slice(-30).reverse();
    log.innerHTML = visible.map((event) => `<div class="event-item ${event.level}">
      <span class="event-time">${formatClock(event.time)}</span>
      <span class="event-message">${escapeHtml(event.message)}</span>
    </div>`).join('');
    const count = this.root.querySelector('#event-count');
    if (count) count.textContent = `${events.length}`;
    log.scrollTop = 0;
  }

  private updateAlertStack(): void {
    if (!this.simulation || !this.root) return;
    const stack = this.root.querySelector('#alert-stack');
    if (!stack) return;
    const sim = this.simulation;
    const windAlert = sim.getWindAlert();
    const trapped = sim.units.filter((unit) => unit.state === '被困求救' && !unit.lost);
    const lost = sim.units.filter((unit) => unit.lost);
    const key = `${windAlert?.kind ?? ''}|${windAlert ? Math.round(windAlert.secondsUntil) : ''}|${trapped.map((unit) => unit.id).join(',')}|${lost.length}|${sim.finished}`;
    if (key === this.lastAlertKey) return;
    this.lastAlertKey = key;
    let markup = '';
    if (windAlert) {
      markup += `<div class="map-alert wind-alert ${windAlert.severity}">
        <div class="alert-icon">${icon('wind', 19)}</div>
        <div class="alert-copy"><b>${escapeHtml(windAlert.title)}</b><span>${escapeHtml(windAlert.detail)}</span></div>
        ${windAlert.secondsUntil > 0 ? `<div class="alert-countdown">${Math.round(windAlert.secondsUntil)}<small>s</small></div>` : '<div class="alert-countdown danger-text">NOW</div>'}
      </div>`;
    }
    for (const unit of trapped.slice(0, 2)) {
      markup += `<div class="map-alert distress-alert">
        <div class="alert-icon">${icon('alert', 19)}</div>
        <div class="alert-copy"><b>SOS · ${escapeHtml(unit.name)} 被困</b><span>${escapeHtml(unit.action)} · 坐标 ${Math.round(unit.pos.x)},${Math.round(unit.pos.y)}</span></div>
        <button class="alert-action" data-locate="${escapeHtml(unit.id)}">定位</button>
      </div>`;
    }
    if (lost.length > 0) {
      markup += `<div class="map-alert lost-alert"><div class="alert-icon">${icon('shield', 16)}</div><div class="alert-copy"><b>${lost.length} 支单位失联</b><span>已从现场单位序列中移除行动能力。</span></div></div>`;
    }
    stack.innerHTML = markup;
  }

  private updateWindAlertSlot(): void {
    // Forecast panel is refreshed together with the full panel.
  }

  private selectUnit(unitId: string | null): void {
    this.selectedUnitId = unitId;
    this.selectedSignature = '';
    this.mapRenderer?.setSelectedUnit(unitId);
    this.updateRoster();
    this.updateSelectedUnit();
    const alerts = this.root?.querySelector('#alert-stack');
    if (alerts) this.lastAlertKey = '';
  }

  private handleCellAction(cell: { x: number; y: number }, tool: ToolMode): void {
    if (!this.simulation || this.simulation.finished) return;
    if (tool === 'drop') {
      const result = this.simulation.orderDrop(cell);
      this.app.toast(result.message, { level: result.ok ? 'success' : 'warning' });
    } else if (tool === 'backfire') {
      const result = this.simulation.orderBackfire(cell);
      this.app.toast(result.message, { level: result.ok ? 'warning' : 'danger' });
      if (result.ok) this.setTool('inspect');
    }
    this.refresh(true);
  }

  private handleBreakLine(cells: { x: number; y: number }[]): void {
    if (!this.simulation || this.simulation.finished) return;
    const result = this.simulation.orderBreakLine(cells);
    this.app.toast(result.message, { level: result.ok ? 'success' : 'warning' });
    this.refresh(true);
  }

  private endEarly(): void {
    if (!this.simulation || this.simulation.finished) return;
    if (!window.confirm('提前结束推演？火场将按当前态势结算，未扑灭的明火会计入未完成状态。')) return;
    this.playing = false;
    this.simulation.endMissionEarly();
    this.updateControlState();
    this.refresh(true);
    this.ensureFinished();
  }

  private showResultOverlay(result: MissionResult): void {
    if (!this.root || this.root.querySelector('#result-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'result-overlay';
    overlay.id = 'result-overlay';
    overlay.innerHTML = `<div class="result-scrim"></div>
      <div class="result-card">
        <button class="icon-btn result-close" id="result-close" aria-label="关闭">${icon('close', 16)}</button>
        <div class="result-kicker">${escapeHtml(result.scenarioCode)} · AFTER ACTION</div>
        <div class="result-stars">${starMarkup(result.stars, 22)}</div>
        <h2>${result.outcome === 'contained' ? '火场明火已扑灭' : '推演结束 · 火场未完全控制'}</h2>
        <p>${escapeHtml(result.missionName)} · 推演 ${formatClock(result.durationSec)} · ${result.stars >= 2 ? '达到预案要求，可以进入下一战区。' : '火场仍有残余风险，建议调整部署后重试。'}</p>
        <div class="result-metrics">
          <div><span>过火面积</span><b>${formatHa(result.burnedHa)}</b><small>预案上限 ${result.maxBurnedHa} ha</small></div>
          <div><span>设施保护</span><b>${result.assetsProtected}/${result.assetsTotal}</b><small>${result.assetsProtected === result.assetsTotal ? '全部完好' : `损失 ${result.assetsTotal - result.assetsProtected} 处`}</small></div>
          <div><span>用水总量</span><b>${(result.waterUsed / 1000).toFixed(1)}<small>t</small></b><small>${result.firebreakCells} 格隔离带</small></div>
          <div><span>单位损失</span><b>${result.unitsLost}</b><small>${result.distressCount} 次求救</small></div>
        </div>
        <div class="result-actions">
          <button class="btn btn-primary" id="go-review">${icon('report', 15)} 查看完整复盘</button>
          <button class="btn btn-ghost" id="redeploy">${icon('layers', 14)} 调整部署</button>
          <button class="btn btn-ghost" id="to-campaign">${icon('map', 14)} 返回战役</button>
        </div>
        <div class="result-foot">已自动写入本地存档 · ${starsText(result.stars)}</div>
      </div>`;
    this.root.appendChild(overlay);
    overlay.querySelector('#result-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.result-scrim')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#go-review')?.addEventListener('click', () => this.app.navigate('review'));
    overlay.querySelector('#redeploy')?.addEventListener('click', () => this.app.navigate('deployment'));
    overlay.querySelector('#to-campaign')?.addEventListener('click', () => this.app.navigate('campaign'));
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.simulation || this.simulation.finished) return;
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT') return;
    if (event.code === 'Space') {
      event.preventDefault();
      this.togglePause();
      return;
    }
    if (event.key === '1' || event.key === '2' || event.key === '4') {
      this.speed = Number(event.key);
      this.root?.querySelectorAll<HTMLElement>('[data-speed]').forEach((item) => {
        item.classList.toggle('active', Number(item.dataset['speed']) === this.speed);
      });
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'b') this.setTool('break');
    if (key === 'd') this.setTool('drop');
    if (key === 'f') this.setTool('backfire');
    if (key === 'i') this.setTool('inspect');
  };
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}
