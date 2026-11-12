import type { AppApi, Screen } from '../types';
import type {
  BatchResult,
  BatchStrategySummary,
  DeploymentPlan,
  MissionResult,
} from '../../sim/types';
import type { BatchProgress, BatchRequest } from '../../sim/batch';
import type { BatchWorkerMessage } from '../../workers/batch.worker';
import type { Simulation } from '../../sim/engine';
import type { UnitTypeId } from '../../sim/types';
import { generateMap } from '../../sim/mapgen';
import { MapRenderer } from '../../render/MapRenderer';
import {
  BUILTIN_STRATEGIES,
  buildAllStrategyPlans,
  buildStrategyPlan,
  colorForStrategy,
} from '../../strategies/strategy';
import {
  dateTimeLabel,
  escapeHtml,
  formatClock,
  formatHa,
  formatNumber,
  icon,
  lineChartSvg,
  relativeTime,
  starMarkup,
  starsText,
  uid,
} from '../ui';

type ReviewTab = 'current' | 'archive' | 'batch';

interface BatchSelectedStrategy {
  id: string;
  name: string;
  color: string;
  plan: DeploymentPlan;
}

const UNIT_LABELS: Record<UnitTypeId, string> = {
  ground: '地面队',
  tender: '水罐车',
  helicopter: '直升机',
};

export class ReviewScreen implements Screen {
  private readonly app: AppApi;
  private root: HTMLElement | null = null;
  private tab: ReviewTab = 'current';
  private selectedRecordId: string | null = null;
  private reviewRenderer: MapRenderer | null = null;
  private renderToken = 0;

  private batchMissionId: string | null = null;
  private batchRuns = 60;
  private batchSelected = new Set<string>();
  private batchWorker: Worker | null = null;
  private batchRunning = false;
  private batchResult: BatchResult | null = null;
  private batchProgress = new Map<string, BatchProgress>();
  private batchError: string | null = null;
  private batchPlans = new Map<string, BatchSelectedStrategy>();

  constructor(app: AppApi) {
    this.app = app;
    this.batchRuns = app.getConfig().batch.defaultRuns;
  }

  mount(): void {
    const last = this.app.getLastResult();
    const records = this.app.saveStore.get().records;
    if (this.tab === 'current' && !last && records.length > 0) this.tab = 'archive';
    this.renderPage();
  }

  unmount(): void {
    this.reviewRenderer?.destroy();
    this.reviewRenderer = null;
    this.batchWorker?.terminate();
    this.batchWorker = null;
    this.batchRunning = false;
    this.root = null;
  }

  private renderPage(): void {
    const host = document.querySelector<HTMLElement>('#screen-host');
    if (!host) return;
    this.reviewRenderer?.destroy();
    this.reviewRenderer = null;
    const token = ++this.renderToken;
    const config = this.app.getConfig();
    const save = this.app.saveStore.get();
    const last = this.app.getLastResult();
    const records = save.records;
    if (!this.selectedRecordId && records.length > 0) this.selectedRecordId = records[0].id;
    if (!this.batchMissionId) this.batchMissionId = this.app.getActiveMission()?.id ?? config.scenarios[0]?.id ?? null;
    if (this.batchSelected.size === 0) {
      this.batchSelected = new Set(BUILTIN_STRATEGIES.map((strategy) => strategy.id));
    }
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.className = 'screen-inner review-screen';
    }
    const completedCount = Object.values(save.campaign.completed).reduce((sum, item) => sum + item.bestStars, 0);
    const completedMissions = Object.keys(save.campaign.completed).length;
    this.root.innerHTML = `
      <header class="review-head">
        <div class="review-title">
          <div class="eyebrow"><span class="eyebrow-line"></span> AFTER ACTION / 复盘室</div>
          <h1>让每一公顷过火面积，都有可解释的原因</h1>
          <p>对照过火曲线、风变窗口和单位行为树，找出下一次可以更早做出的决定。</p>
        </div>
        <div class="review-head-summary">
          <div class="review-score"><span>累计星级</span><b>${completedCount}<small>/${config.scenarios.length * 3}</small></b></div>
          <div class="review-score"><span>完成战区</span><b>${completedMissions}<small>/${config.scenarios.length}</small></b></div>
          <div class="review-score"><span>演练存档</span><b>${records.length}<small>条</small></b></div>
        </div>
        <div class="tab-switcher" role="tablist">
          <button class="tab-button ${this.tab === 'current' ? 'active' : ''}" data-tab="current">${icon('report', 14)} 本次复盘</button>
          <button class="tab-button ${this.tab === 'archive' ? 'active' : ''}" data-tab="archive">${icon('save', 14)} 历史档案 <em>${records.length}</em></button>
          <button class="tab-button ${this.tab === 'batch' ? 'active' : ''}" data-tab="batch">${icon('compass', 14)} 批量推演</button>
        </div>
      </header>
      <div id="review-content"></div>
    `;
    host.replaceChildren(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tab = button.dataset['tab'] as ReviewTab;
        this.renderPage();
      });
    });
    const content = this.root.querySelector('#review-content') as HTMLElement;
    if (this.tab === 'batch') {
      this.renderBatch(content);
      return;
    }
    const result = this.tab === 'archive'
      ? records.find((record) => record.id === this.selectedRecordId) ?? records[0] ?? null
      : last;
    if (!result) {
      content.innerHTML = this.emptyReportMarkup();
      content.querySelector('#empty-batch')?.addEventListener('click', () => {
        this.tab = 'batch';
        this.renderPage();
      });
      content.querySelector('#empty-campaign')?.addEventListener('click', () => this.app.navigate('campaign'));
      return;
    }
    if (this.tab === 'archive') {
      const record = records.find((item) => item.id === result.id);
      if (record) this.selectedRecordId = record.id;
    }
    this.renderReport(content, result, token);
  }

  private emptyReportMarkup(): string {
    return `<div class="review-empty panel">
      <div class="empty-mark">${icon('report', 34)}</div>
      <div class="eyebrow">NO DEBRIEF YET</div>
      <h2>还没有可以复盘的推演</h2>
      <p>完成一场实时指挥，或在批量推演里比较不同部署。系统会自动记录每次行动的火场结果。</p>
      <div class="empty-actions">
        <button class="btn btn-primary" id="empty-batch">${icon('compass', 15)} 去批量推演</button>
        <button class="btn btn-ghost" id="empty-campaign">${icon('map', 15)} 选择战区</button>
      </div>
    </div>`;
  }

  private async renderReport(content: HTMLElement, result: MissionResult, token: number): Promise<void> {
    const config = this.app.getConfig();
    const scenarios = config.scenarios;
    const mission = result.scenarioSnapshot ?? scenarios.find((scenario) => scenario.id === result.missionId);
    const records = this.app.saveStore.get().records;
    const missionRecords = records.filter((record) => record.missionId === result.missionId);
    const unitCounts = countDeployment(result.deployment.units);
    const outcomeLabel = result.outcome === 'contained' ? '明火扑灭' : '未完全控制';
    const burnedRatio = result.burnedHa / Math.max(1, result.maxBurnedHa);
    const windEvents = mission?.windEvents ?? [];
    const notes = result.notes.length > 0 ? result.notes : ['本次推演无额外备注。'];
    const extraTips: string[] = [];
    if (result.distressCount > 0) extraTips.push('检查扑火队接近火线时的撤离阈值：当前行为树在火线贴近时频繁进入被困分支，可提前安排水罐车压制撤退路线。');
    if (result.windShiftCount >= 2) extraTips.push('本场经历多次风向突变。隔离带应沿两个风场方向分别预留余量，不要只追求单侧长度。');
    if (result.firebreakCells === 0 && result.assetsTotal > 0) extraTips.push('没有完成人工隔离带。面对断崖与风道时，仅靠单位扑救会被火线牵制。');
    if (result.waterUsed / Math.max(1, result.unitsDeployed) < 1000) extraTips.push('单位平均用水偏低，可能有队伍提前撤回或在缺水状态下待命，可检查补水路线。');
    if (extraTips.length === 0) extraTips.push('整体执行平稳。下一步可尝试在风变前 20 秒主动改变部署，比较过火曲线拐点。');

    const timelinePoints = result.timeline.map((point) => ({ x: point.time, y: point.burnedHa }));
    const chartMaxY = Math.max(10, result.maxBurnedHa * 1.08, result.burnedHa * 1.2);
    const chart = lineChartSvg(timelinePoints, {
      width: 720,
      height: 240,
      maxY: chartMaxY,
      goal: result.maxBurnedHa,
      markers: windEvents.map((event) => ({
        x: event.atSec,
        label: `风变 ${formatClock(event.atSec)}`,
      })),
      color: result.outcome === 'contained' ? '#dba64f' : '#d57555',
    });
    const recordRows = records.slice(0, 18).map((record) => `<button class="archive-record ${record.id === result.id ? 'active' : ''}" data-record="${escapeHtml(record.id)}">
      <span class="ar-stars">${starMarkup(record.stars, 10)}</span>
      <span class="ar-main"><b>${escapeHtml(record.scenarioCode)} · ${escapeHtml(record.missionName)}</b><small>${relativeTime(record.finishedAt)} · ${Math.round(record.durationSec)}s</small></span>
      <span class="ar-burn">${record.burnedHa.toFixed(1)}<small>ha</small></span>
    </button>`).join('');
    const deploymentCounts = (Object.keys(unitCounts) as UnitTypeId[]).map((type) => {
      const count = unitCounts[type];
      if (!count) return '';
      return `<span class="deployment-chip">${icon(type === 'ground' ? 'crew' : type === 'tender' ? 'truck' : 'heli', 12)} ${UNIT_LABELS[type]} × ${count}</span>`;
    }).join('');

    content.innerHTML = `<div class="review-report-layout">
      <aside class="archive-panel panel">
        <div class="panel-heading compact">
          <div><span class="eyebrow small">DEBRIEF ARCHIVE</span><h2>行动档案</h2></div>
          <span class="panel-count">${records.length}</span>
        </div>
        <div class="archive-current">
          <span class="archive-current-label">正在查看</span>
          <b>${escapeHtml(result.scenarioCode)} · ${escapeHtml(result.missionName)}</b>
          <span>${dateTimeLabel(result.finishedAt)}</span>
        </div>
        <div class="archive-records">${recordRows || '<div class="archive-empty">还没有历史记录</div>'}</div>
        <div class="archive-legend">${icon('info', 12)} 记录最多保留 20 条，包含火场快照与事件日志。</div>
      </aside>

      <section class="report-main">
        <div class="report-banner panel ${result.outcome}">
          <div class="banner-rating">
            <span class="rating-kicker">${escapeHtml(result.scenarioCode)} · AAR</span>
            <div class="rating-stars">${starMarkup(result.stars, 26)}</div>
            <span class="rating-text">${result.stars >= 3 ? '教科书式控火' : result.stars === 2 ? '达成任务目标' : result.stars === 1 ? '勉强守住底线' : '需要重新部署'}</span>
          </div>
          <div class="banner-main">
            <span class="status-outcome ${result.outcome}"><i></i>${outcomeLabel}</span>
            <h2>${escapeHtml(result.missionName)} · ${formatClock(result.durationSec)}</h2>
            <p>${escapeHtml(mission?.subtitle ?? '')} · ${dateTimeLabel(result.finishedAt)} · 用时 ${formatClock(result.durationSec)}</p>
            <div class="deployment-chips">${deploymentCounts}</div>
          </div>
          <div class="banner-actions">
            <button class="btn btn-ghost btn-sm" id="save-as-plan">${icon('save', 13)} 保存部署</button>
            <button class="btn btn-primary btn-sm" id="retry-mission">${icon('refresh', 13)} 重演此图</button>
          </div>
        </div>

        <div class="report-stat-grid">
          <div class="report-stat"><span>过火面积</span><b>${formatNumber(result.burnedHa, result.burnedHa < 10 ? 1 : 0)}<small>ha</small></b><em>预案 ${result.maxBurnedHa} ha · ${Math.round(burnedRatio * 100)}% 占用</em></div>
          <div class="report-stat"><span>设施保护</span><b>${result.assetsProtected}<small>/${result.assetsTotal}</small></b><em>${result.assetsTotal - result.assetsProtected === 0 ? '全部完好' : `损失 ${result.assetsTotal - result.assetsProtected} 处`}</em></div>
          <div class="report-stat"><span>扑灭火点</span><b>${result.suppressedCells}<small>格</small></b><em>隔离带 ${result.firebreakCells} 格 · 逆火 ${result.backfireCells} 处</em></div>
          <div class="report-stat"><span>总用水量</span><b>${(result.waterUsed / 1000).toFixed(1)}<small>t</small></b><em>${formatNumber(result.waterUsed)} L · ${result.unitsDeployed} 支单位</em></div>
          <div class="report-stat"><span>单位损失</span><b>${result.unitsLost}<small>支</small></b><em>${result.distressCount} 次被困求救</em></div>
          <div class="report-stat"><span>风变次数</span><b>${result.windShiftCount}<small>次</small></b><em>峰值明火 ${result.peakBurningCells} 格</em></div>
        </div>

        <div class="report-visual-grid">
          <section class="panel report-map-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">FIRE SCAR</span><h2>火场过火图</h2></div>
              <span class="map-meta">${result.burnedCells} 格 · ${formatHa(result.burnedHa)}</span>
            </div>
            <div class="review-map-host" id="review-map"></div>
            <div class="report-map-caption"><span><i class="legend-fire"></i>初始火点</span><span><i class="legend-ash"></i>过火区</span><span><i class="legend-break"></i>隔离带</span><span>${mission ? mission.assets.length : 0} 处设施</span></div>
          </section>
          <section class="panel chart-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">BURN CURVE</span><h2>过火面积曲线</h2></div>
              <span class="map-meta">峰值 ${formatHa(result.burnedHa)}</span>
            </div>
            <div class="chart-wrap">${chart}</div>
            <div class="chart-caption"><span class="chart-legend-line"></span>过火面积 <span class="chart-legend-goal"></span>预案上限 <span class="chart-legend-wind"></span>风变事件</div>
          </section>
        </div>

        <div class="report-lower-grid">
          <section class="panel insight-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">INSIGHTS</span><h2>复盘判断</h2></div>
              <span class="panel-count">${notes.length}</span>
            </div>
            <ul class="insight-list">
              ${notes.map((note) => `<li>${icon('check', 13)}<span>${escapeHtml(note)}</span></li>`).join('')}
              ${extraTips.map((tip) => `<li class="tip">${icon('target', 13)}<span>${escapeHtml(tip)}</span></li>`).join('')}
            </ul>
          </section>
          <section class="panel report-log-panel">
            <div class="panel-heading compact">
              <div><span class="eyebrow small">RADIO LOG</span><h2>关键事件</h2></div>
              <span class="panel-count">${result.events.length}</span>
            </div>
            <div class="report-event-log">
              ${[...result.events].slice(-18).reverse().map((event) => `<div class="event-item ${event.level}"><span class="event-time">${formatClock(event.time)}</span><span class="event-message">${escapeHtml(event.message)}</span></div>`).join('')}
            </div>
          </section>
        </div>
        <div class="report-footer">
          <span>本次推演存档 ID ${escapeHtml(result.id)}</span>
          <span>${icon('check', 12)} 已写入本地存档 · ${this.app.saveStore.getVersionLabel()}</span>
          <button class="text-link" id="report-batch">${icon('compass', 13)} 用这次预算跑批量推演</button>
        </div>
      </section>
    </div>`;

    content.querySelectorAll<HTMLElement>('[data-record]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedRecordId = button.dataset['record'] ?? null;
        this.tab = 'archive';
        this.renderPage();
      });
    });
    content.querySelector('#retry-mission')?.addEventListener('click', () => {
      this.app.setActiveMission(result.missionId);
      this.app.navigate('deployment');
    });
    content.querySelector('#save-as-plan')?.addEventListener('click', () => {
      const name = window.prompt('保存本次部署为方案：', `${result.missionName} · 复盘方案`);
      if (!name) return;
      this.app.saveStore.addPreset({
        id: uid('preset'),
        name: name.trim().slice(0, 30),
        missionId: result.missionId,
        units: result.deployment.units.map((unit) => ({ ...unit, cell: { ...unit.cell } })),
        createdAt: new Date().toISOString(),
        templateId: result.deployment.templateId,
      });
      this.app.toast('本次部署已保存，可在部署页与批量推演中载入', { level: 'success' });
    });
    content.querySelector('#report-batch')?.addEventListener('click', () => {
      this.batchMissionId = result.missionId;
      this.tab = 'batch';
      this.renderPage();
    });
    void missionRecords;

    if (!mission) return;
    const mapHost = content.querySelector<HTMLElement>('#review-map');
    if (!mapHost) return;
    const map = generateMap(mission, config);
    const burned = new Set(result.burnedCellIndices);
    const lostAssets = mission.assets.filter((asset) => burned.has(asset.y * map.cols + asset.x)).map((asset) => asset.id);
    const renderer = new MapRenderer(mapHost, 'review', config);
    this.reviewRenderer = renderer;
    await renderer.initialize(map);
    if (token !== this.renderToken) {
      renderer.destroy();
      return;
    }
    renderer.setReviewSnapshot(burned, lostAssets);
  }

  private renderBatch(content: HTMLElement): void {
    const config = this.app.getConfig();
    const scenario = config.scenarios.find((item) => item.id === this.batchMissionId)
      ?? this.app.getActiveMission()
      ?? config.scenarios[0];
    if (!scenario) {
      content.innerHTML = '<div class="review-empty panel"><h2>没有可用战区</h2></div>';
      return;
    }
    this.batchMissionId = scenario.id;
    const built = buildAllStrategyPlans(scenario, config);
    const savedPresets = this.app.saveStore.get().deploymentPresets.filter((preset) => preset.missionId === scenario.id);
    this.batchPlans = new Map();
    const strategyCards = [
      ...built.map(({ strategy, plan }) => {
        this.batchPlans.set(strategy.id, { id: strategy.id, name: strategy.name, color: strategy.color, plan });
        return { id: strategy.id, name: strategy.name, color: strategy.color, description: strategy.description, units: plan.units.length, custom: false };
      }),
      ...savedPresets.map((preset) => {
        const plan: DeploymentPlan = {
          missionId: preset.missionId,
          name: preset.name,
          templateId: preset.templateId,
          units: preset.units.map((unit) => ({ ...unit, cell: { ...unit.cell } })),
        };
        const id = `preset-${preset.id}`;
        this.batchPlans.set(id, { id, name: preset.name, color: colorForStrategy(id), plan });
        return { id, name: preset.name, color: colorForStrategy(id), description: `本地保存方案 · ${preset.units.length} 支单位`, units: preset.units.length, custom: true };
      }),
    ];
    const selectedCount = [...this.batchSelected].filter((id) => this.batchPlans.has(id)).length;
    const runOptions = unique([config.batch.defaultRuns, 200, config.batch.maxRuns]).filter((value) => value <= config.batch.maxRuns);
    const progressRows = strategyCards
      .filter((strategy) => this.batchSelected.has(strategy.id))
      .map((strategy) => {
        const progress = this.batchProgress.get(strategy.id);
        const percent = progress ? progress.completed / Math.max(1, progress.total) * 100 : 0;
        return `<div class="batch-progress-row" data-progress-strategy="${escapeHtml(strategy.id)}">
          <span class="dot" style="background:${strategy.color}"></span>
          <span class="bp-name">${escapeHtml(strategy.name)}</span>
          <div class="bp-track"><i style="width:${percent}%;background:${strategy.color}"></i></div>
          <span class="bp-count">${progress ? `${progress.completed}/${progress.total}` : '等待'}</span>
        </div>`;
      }).join('');

    content.innerHTML = `<div class="batch-layout">
      <section class="batch-config panel">
        <div class="panel-heading">
          <div><span class="eyebrow small">BATCH SIMULATION</span><h2>批量推演</h2></div>
          <span class="batch-chip">SEEDED RUNS</span>
        </div>
        <p class="batch-lead">同一张地图、同一组随机种子，连续跑数百局。对比不同部署的过火面积分布，而不是只看一次推演。</p>
        <div class="batch-fields">
          <label class="field-label">战场
            <select id="batch-mission" ${this.batchRunning ? 'disabled' : ''}>
              ${config.scenarios.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === scenario.id ? 'selected' : ''}>${escapeHtml(item.code)} · ${escapeHtml(item.name)} · 预算 ${item.budget}</option>`).join('')}
            </select>
          </label>
          <div class="field-label">每套部署局数
            <div class="runs-switch" id="runs-switch">
              ${runOptions.map((runs) => `<button class="${runs === this.batchRuns ? 'active' : ''}" data-runs="${runs}" ${this.batchRunning ? 'disabled' : ''}>${runs}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="batch-strategy-head">
          <span class="field-label">对比部署</span>
          <span class="muted">已选 ${selectedCount} / ${strategyCards.length}</span>
        </div>
        <div class="batch-strategy-list">
          ${strategyCards.map((strategy) => `<label class="batch-strategy ${this.batchSelected.has(strategy.id) ? 'selected' : ''}" data-strategy="${escapeHtml(strategy.id)}" style="--strategy-color:${strategy.color}">
            <input type="checkbox" data-batch-check="${escapeHtml(strategy.id)}" ${this.batchSelected.has(strategy.id) ? 'checked' : ''} ${this.batchRunning ? 'disabled' : ''}/>
            <span class="bs-check">${icon('check', 11)}</span>
            <span class="bs-main"><b>${escapeHtml(strategy.name)}</b><small>${escapeHtml(strategy.description)}</small></span>
            <span class="bs-units">${strategy.units}<small>支</small>${strategy.custom ? '<em>自定</em>' : ''}</span>
          </label>`).join('')}
        </div>
        <div class="batch-actions">
          <button class="btn btn-primary btn-lg" id="start-batch" ${this.batchRunning || selectedCount < 2 ? 'disabled' : ''}>
            ${this.batchRunning ? `${icon('refresh', 15)} 正在推演…` : `${icon('play', 15)} 启动 ${this.batchRuns} 局 × ${selectedCount} 套方案`}
          </button>
          <span class="batch-warning">${selectedCount < 2 ? '至少选择 2 套部署方案' : '随机种子配对 · 结果写入本页对比'}</span>
        </div>
        ${this.batchRunning ? `<div class="batch-progress" id="batch-progress">
          <div class="batch-progress-head"><span>无头推演中</span><span id="batch-progress-overall">0%</span></div>
          <div class="batch-overall-track"><i id="batch-overall-fill"></i></div>
          <div class="batch-progress-rows">${progressRows}</div>
          <div class="batch-progress-note">${icon('info', 12)} 使用 Web Worker 后台计算，不会卡住指挥台。可以切换标签页，结果会保留在当前复盘会话。</div>
        </div>` : ''}
        <div class="batch-error">${this.batchError ? escapeHtml(this.batchError) : ''}</div>
      </section>
      <section class="batch-arena panel" id="batch-arena">
        ${this.batchResult ? this.batchResultMarkup(this.batchResult) : this.batchPlaceholderMarkup()}
      </section>
    </div>`;
    this.bindBatchControls(content, scenario);
    if (this.batchRunning) this.updateBatchProgressDom();
  }

  private bindBatchControls(content: HTMLElement, scenario: NonNullable<ReturnType<AppApi['getActiveMission']>>): void {
    content.querySelector<HTMLSelectElement>('#batch-mission')?.addEventListener('change', (event) => {
      const select = event.target as HTMLSelectElement;
      this.batchMissionId = select.value;
      this.batchSelected = new Set(BUILTIN_STRATEGIES.map((strategy) => strategy.id));
      this.batchResult = null;
      this.renderPage();
    });
    content.querySelectorAll<HTMLElement>('[data-runs]').forEach((button) => {
      button.addEventListener('click', () => {
        this.batchRuns = Number(button.dataset['runs'] ?? this.batchRuns);
        content.querySelectorAll<HTMLElement>('[data-runs]').forEach((item) => item.classList.toggle('active', item === button));
        const start = content.querySelector<HTMLButtonElement>('#start-batch');
        const selectedCount = [...this.batchSelected].filter((id) => this.batchPlans.has(id)).length;
        if (start) start.innerHTML = `${icon('play', 15)} 启动 ${this.batchRuns} 局 × ${selectedCount} 套方案`;
      });
    });
    content.querySelector('#batch-again')?.addEventListener('click', () => {
      this.batchResult = null;
      this.batchError = null;
      this.renderPage();
    });
    content.querySelectorAll<HTMLElement>('[data-batch-check]').forEach((check) => {
      check.addEventListener('change', () => {
        const id = check.dataset['batchCheck'];
        if (!id) return;
        const input = check as HTMLInputElement;
        if (input.checked) this.batchSelected.add(id);
        else this.batchSelected.delete(id);
        const card = check.closest('.batch-strategy');
        card?.classList.toggle('selected', input.checked);
        const selectedCount = [...this.batchSelected].filter((item) => this.batchPlans.has(item)).length;
        const start = content.querySelector<HTMLButtonElement>('#start-batch');
        const warning = content.querySelector('.batch-warning');
        const count = content.querySelector('.batch-strategy-head .muted');
        if (count) count.textContent = `已选 ${selectedCount} / ${this.batchPlans.size}`;
        if (start) {
          start.disabled = selectedCount < 2 || this.batchRunning;
          start.innerHTML = `${icon('play', 15)} 启动 ${this.batchRuns} 局 × ${selectedCount} 套方案`;
        }
        if (warning) warning.textContent = selectedCount < 2 ? '至少选择 2 套部署方案' : '随机种子配对 · 结果写入本页对比';
      });
    });
    content.querySelector('#start-batch')?.addEventListener('click', () => this.startBatch(scenario));
  }

  private startBatch(scenario: NonNullable<ReturnType<AppApi['getActiveMission']>>): void {
    if (this.batchRunning) return;
    const selected = [...this.batchSelected]
      .map((id) => this.batchPlans.get(id))
      .filter((strategy): strategy is BatchSelectedStrategy => Boolean(strategy));
    if (selected.length < 2) {
      this.app.toast('至少选择两套部署方案才能对比', { level: 'warning' });
      return;
    }
    const config = this.app.getConfig();
    this.batchRunning = true;
    this.batchResult = null;
    this.batchError = null;
    this.batchProgress.clear();
    this.renderPage();
    const request: BatchRequest = {
      scenario,
      config,
      strategies: selected.map((strategy) => ({
        id: strategy.id,
        name: strategy.name,
        color: strategy.color,
        plan: strategy.plan,
      })),
      runsPerStrategy: this.batchRuns,
    };
    const worker = new Worker(new URL('../../workers/batch.worker.ts', import.meta.url), { type: 'module' });
    this.batchWorker = worker;
    worker.onmessage = (event: MessageEvent<BatchWorkerMessage>) => {
      if (event.data.type === 'progress') {
        this.batchProgress.set(event.data.progress.strategyId, event.data.progress);
        this.updateBatchProgressDom();
      } else if (event.data.type === 'done') {
        this.batchResult = event.data.result;
        this.batchRunning = false;
        this.batchWorker?.terminate();
        this.batchWorker = null;
        this.batchProgress.clear();
        this.renderPage();
        this.app.toast(`批量推演完成：${this.batchResult.strategies.length} 套部署 · ${this.batchResult.runsPerStrategy} 局/套`, { level: 'success' });
      } else if (event.data.type === 'error') {
        this.batchError = event.data.message;
        this.batchRunning = false;
        this.batchWorker?.terminate();
        this.batchWorker = null;
        this.batchProgress.clear();
        this.renderPage();
        this.app.toast(`批量推演失败：${this.batchError}`, { level: 'danger' });
      }
    };
    worker.onerror = (event) => {
      this.batchError = event.message || 'Worker 运行异常';
      this.batchRunning = false;
      this.batchWorker?.terminate();
      this.batchWorker = null;
      this.batchProgress.clear();
      this.renderPage();
      this.app.toast(`批量推演失败：${this.batchError}`, { level: 'danger' });
    };
    worker.postMessage(request);
  }

  private updateBatchProgressDom(): void {
    if (!this.root || this.tab !== 'batch') return;
    const total = this.batchRuns * [...this.batchSelected].filter((id) => this.batchPlans.has(id)).length;
    let completed = 0;
    for (const progress of this.batchProgress.values()) completed += progress.completed;
    const percent = total > 0 ? Math.min(100, completed / total * 100) : 0;
    const overall = this.root.querySelector('#batch-progress-overall');
    const fill = this.root.querySelector<HTMLElement>('#batch-overall-fill');
    if (overall) overall.textContent = `${Math.round(percent)}%`;
    if (fill) fill.style.width = `${percent}%`;
    for (const [stratId, progress] of this.batchProgress) {
      const row = this.root.querySelector<HTMLElement>(`[data-progress-strategy="${cssEscape(stratId)}"]`);
      if (!row) continue;
      const bar = row.querySelector<HTMLElement>('.bp-track i');
      const count = row.querySelector('.bp-count');
      if (bar) bar.style.width = `${progress.completed / Math.max(1, progress.total) * 100}%`;
      if (count) count.textContent = `${progress.completed}/${progress.total}`;
    }
  }

  private batchPlaceholderMarkup(): string {
    return `<div class="batch-arena-empty">
      <div class="arena-graphic">
        <div class="radar-ring r1"></div><div class="radar-ring r2"></div><div class="radar-ring r3"></div>
        <span class="radar-sweep"></span>
        <span class="radar-point p1"></span><span class="radar-point p2"></span><span class="radar-point p3"></span>
      </div>
      <span class="eyebrow">COMPARATIVE ANALYSIS</span>
      <h2>一次部署只是样本</h2>
      <p>启动批量推演后，这里会出现<b>均值、中位数、P10–P90 区间与达成率</b>。相同种子配对比较，可排除随机性干扰。</p>
      <div class="batch-placeholder-stats">
        <span><b>${this.batchRuns}</b> 局 / 套</span>
        <span><b>${[...this.batchSelected].filter((id) => this.batchPlans.has(id)).length}</b> 套部署</span>
        <span><b>${this.app.getConfig().batch.tickSeconds}s</b> 步长</span>
      </div>
    </div>`;
  }

  private batchResultMarkup(result: BatchResult): string {
    if (result.strategies.length === 0) return this.batchPlaceholderMarkup();
    const best = [...result.strategies].sort((a, b) => a.meanBurnedHa - b.meanBurnedHa)[0];
    const maxScale = Math.max(...result.strategies.map((strategy) => Math.max(strategy.meanBurnedHa, strategy.p90BurnedHa)), 1);
    const rows = result.strategies.map((strategy) => this.batchStrategyRow(strategy, best)).join('');
    return `<div class="batch-result-head">
      <div>
        <span class="eyebrow small">COMPARISON RESULT · ${escapeHtml(result.missionName)}</span>
        <h2>${result.runsPerStrategy} 局 × ${result.strategies.length} 套部署</h2>
        <p>无头推演耗时 ${(result.elapsedMs / 1000).toFixed(1)}s · 完成于 ${dateTimeLabel(result.completedAt)}</p>
      </div>
      <div class="best-plan">
        <span>最优方案</span>
        <b style="color:${best.color}">${escapeHtml(best.strategyName)}</b>
        <small>平均过火 ${best.meanBurnedHa.toFixed(1)} ha</small>
      </div>
    </div>
    <div class="batch-table-head">
      <span>部署方案</span><span>平均过火</span><span>P10–P90</span><span>达成率</span><span>平均用水</span>
    </div>
    <div class="batch-table">${rows}</div>
    <div class="batch-distribution">
      <div class="batch-dist-title"><span>过火面积分布</span><span>区间 P10–P90 · 竖线为中位数</span></div>
      ${result.strategies.map((strategy) => `<div class="dist-row">
        <span class="dist-label" style="color:${strategy.color}">${escapeHtml(strategy.strategyName)}</span>
        <div class="dist-track">
          <span class="dist-range" style="left:${Math.min(99, strategy.p10BurnedHa / maxScale * 100)}%;width:${Math.max(2, Math.min(99, (strategy.p90BurnedHa - strategy.p10BurnedHa) / maxScale * 100))}%;background:${strategy.color}"></span>
          <span class="dist-median" style="left:${Math.min(99, strategy.medianBurnedHa / maxScale * 100)}%;background:${strategy.color}"></span>
        </div>
        <span class="dist-value">${strategy.medianBurnedHa.toFixed(1)}<small> 中位</small></span>
      </div>`).join('')}
      <div class="batch-dist-axis"><span>0</span><span>${Math.round(maxScale)} ha</span></div>
    </div>
    <div class="batch-result-notes">${result.notes.map((note) => `<span>${icon('info', 12)} ${escapeHtml(note)}</span>`).join('')}</div>
    <div class="batch-result-actions">
      <button class="btn btn-primary btn-sm" id="batch-again">${icon('refresh', 13)} 换一组参数</button>
      <span>想比较自己的部署？先到部署页保存方案，再回来勾选。</span>
    </div>`;
  }

  private batchStrategyRow(strategy: BatchStrategySummary, best: BatchStrategySummary): string {
    const isBest = strategy.strategyId === best.strategyId && strategy.strategyName === best.strategyName;
    return `<div class="batch-table-row ${isBest ? 'best' : ''}">
      <span class="btr-name"><i class="dot" style="background:${strategy.color}"></i><b>${escapeHtml(strategy.strategyName)}</b>${isBest ? '<em>最优</em>' : ''}</span>
      <span class="btr-mean">${strategy.meanBurnedHa.toFixed(1)}<small>ha</small></span>
      <span class="btr-range">${strategy.p10BurnedHa.toFixed(1)}–${strategy.p90BurnedHa.toFixed(1)}</span>
      <span class="btr-success"><i style="width:${Math.round(strategy.successRate * 100)}%;background:${strategy.color}"></i><b>${Math.round(strategy.successRate * 100)}%</b></span>
      <span class="btr-water">${(strategy.meanWaterUsed / 1000).toFixed(1)}<small>t</small></span>
    </div>`;
  }
}

function countDeployment(units: DeploymentPlan['units']): Record<UnitTypeId, number> {
  const counts: Record<UnitTypeId, number> = { ground: 0, tender: 0, helicopter: 0 };
  for (const unit of units) counts[unit.type]++;
  return counts;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}
