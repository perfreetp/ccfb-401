import type { GameConfig, ScenarioConfig } from '../config/types';
import { configStore } from '../config/configStore';
import { saveStore } from '../save/store';
import { LEGACY_SAVE_V1 } from '../save/saveTypes';
import type { DeploymentPlan, MissionResult } from '../sim/types';
import { Simulation } from '../sim/engine';
import type { AppApi, AppPage, Screen, ToastLevel } from './types';
import { CampaignScreen } from './screens/CampaignScreen';
import { DeploymentScreen } from './screens/DeploymentScreen';
import { CommandScreen } from './screens/CommandScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { ConfigScreen } from './screens/ConfigScreen';
import {
  dateTimeLabel,
  downloadText,
  escapeHtml,
  icon,
  starMarkup,
  starsText,
} from './ui';

const PAGE_META: Record<AppPage, { title: string; sub: string }> = {
  campaign: { title: '战役地图', sub: 'CAMPAIGN / 火场战役' },
  deployment: { title: '部署编组', sub: 'DEPLOYMENT / 出兵编组' },
  command: { title: '实时指挥', sub: 'COMMAND / 火场指挥台' },
  review: { title: '行动复盘', sub: 'AFTER ACTION / 数据复盘' },
  config: { title: '数值配置', sub: 'BALANCE TABLES / 配置中心' },
};

interface SessionState {
  activeMissionId: string | null;
  deployment: DeploymentPlan | null;
  simulation: Simulation | null;
  lastResult: MissionResult | null;
  recordedResultId: string | null;
}

export class App implements AppApi {
  readonly saveStore = saveStore;
  readonly configStore = configStore;

  private readonly root: HTMLElement;
  private currentScreen: Screen | null = null;
  private currentPage: AppPage = 'campaign';
  private toastHost: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private session: SessionState = {
    activeMissionId: null,
    deployment: null,
    simulation: null,
    lastResult: null,
    recordedResultId: null,
  };

  constructor(root: HTMLElement) {
    this.root = root;
  }

  boot(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar" id="sidebar">
          <div class="brand">
            <span class="brand-mark">${icon('flame', 22)}<i></i></span>
            <span class="brand-copy"><strong>林火前线</strong><small>FOREST FIRE COMMAND</small></span>
          </div>
          <div class="sidebar-label">OPERATIONS</div>
          <nav class="main-nav" aria-label="主导航">
            ${this.navButton('campaign', 'map', '战役地图', 'CAMPAIGN', '01')}
            ${this.navButton('deployment', 'layers', '部署编组', 'DEPLOYMENT', '02')}
            ${this.navButton('command', 'compass', '实时指挥', 'COMMAND', '03')}
            ${this.navButton('review', 'report', '复盘分析', 'AFTER ACTION', '04')}
            ${this.navButton('config', 'sliders', '数值配置', 'CONFIG', '05')}
          </nav>
          <div class="side-mission" id="side-mission"></div>
          <div class="sidebar-foot">
            <button class="save-chip" id="open-save">
              <span class="save-icon">${icon('save', 15)}</span>
              <span class="save-copy"><small>LOCAL SAVE</small><b id="save-version">SCHEMA v3</b></span>
              <span class="save-dot"></span>
            </button>
            <div class="sidebar-note">数据仅保存在当前浏览器</div>
          </div>
        </aside>
        <div class="workspace">
          <header class="topbar">
            <div class="crumb">
              <span class="crumb-parent">OPS CENTER</span>
              <span class="crumb-sep">/</span>
              <span id="topbar-title">战役地图</span>
              <small id="topbar-sub">CAMPAIGN</small>
            </div>
            <div class="topbar-right">
              <span class="cfg-pill" id="cfg-pill">CONFIG v1</span>
              <span class="clock-pill" id="clock-pill">${icon('clock', 13)} ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
              <button class="topbar-btn" id="open-save-top">${icon('save', 14)} 存档管理</button>
            </div>
          </header>
          <main class="screen-host" id="screen-host"></main>
        </div>
        <div class="toast-host" id="toast-host"></div>
      </div>
    `;
    this.toastHost = this.root.querySelector('#toast-host');
    this.root.querySelectorAll<HTMLElement>('[data-page]').forEach((button) => {
      button.addEventListener('click', () => this.navigate(button.dataset['page'] as AppPage));
    });
    this.root.querySelector('#open-save')?.addEventListener('click', () => this.openSaveManager());
    this.root.querySelector('#open-save-top')?.addEventListener('click', () => this.openSaveManager());
    this.saveStore.subscribe(() => {
      this.updateChrome();
    });
    this.configStore.subscribe(() => {
      this.updateChrome();
    });
    window.addEventListener('hashchange', () => {
      const page = this.pageFromHash();
      this.currentPage = page;
      this.renderPage();
    });
    const initial = location.hash ? this.pageFromHash() : 'campaign';
    if (!location.hash) location.hash = '#/campaign';
    else {
      this.currentPage = initial;
      this.renderPage();
    }
    this.updateChrome();
    setInterval(() => {
      const clock = this.root.querySelector('#clock-pill');
      if (clock) clock.innerHTML = `${icon('clock', 13)} ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    }, 30_000);
  }

  getConfig(): GameConfig {
    return this.configStore.get();
  }

  getActiveMission(): ScenarioConfig | null {
    if (this.session.activeMissionId) {
      const match = this.getConfig().scenarios.find((scenario) => scenario.id === this.session.activeMissionId);
      if (match) return match;
    }
    if (this.session.simulation) return this.session.simulation.scenario;
    return null;
  }

  getActiveSimulation(): Simulation | null {
    return this.session.simulation;
  }

  getLastResult(): MissionResult | null {
    return this.session.lastResult ?? this.session.simulation?.result ?? null;
  }

  getDeployment(): DeploymentPlan | null {
    return this.session.deployment;
  }

  setActiveMission(missionId: string): void {
    if (this.session.activeMissionId === missionId) return;
    const exists = this.getConfig().scenarios.some((scenario) => scenario.id === missionId);
    if (!exists) return;
    this.session.activeMissionId = missionId;
    this.session.deployment = null;
    this.session.simulation = null;
    this.session.lastResult = null;
    this.session.recordedResultId = null;
    this.updateChrome();
  }

  launchSimulation(plan: DeploymentPlan): void {
    const config = this.getConfig();
    const scenario = config.scenarios.find((item) => item.id === plan.missionId);
    if (!scenario) throw new Error('战役不存在');
    this.session.activeMissionId = plan.missionId;
    this.session.deployment = plan;
    this.session.simulation = new Simulation(scenario, config, plan);
    this.session.lastResult = null;
    this.session.recordedResultId = null;
    this.updateChrome();
  }

  recordSimulation(simulation: Simulation): void {
    const result = simulation.result;
    if (!result) return;
    if (this.session.recordedResultId === result.id) {
      this.session.lastResult = result;
      return;
    }
    this.session.recordedResultId = result.id;
    this.session.lastResult = result;
    const wasCompleted = this.saveStore.get().campaign.completed[result.missionId]?.bestStars ?? 0;
    this.saveStore.recordMission(result, true);
    const newStars = result.stars;
    this.toast(
      newStars >= 2 ? `推演记录已写入存档 · ${starsText(newStars)}` : `推演结束 · ${result.outcome === 'contained' ? '明火扑灭' : '仍有明火'}，记录已存档`,
      { level: newStars >= 2 ? 'success' : 'warning' },
    );
    if (newStars > wasCompleted) {
      const next = this.getConfig().scenarios[this.getConfig().scenarios.findIndex((s) => s.id === result.missionId) + 1];
      if (next && this.saveStore.get().campaign.unlockedMissions.includes(next.id)) {
        this.toast(`新战区解锁：${next.code} · ${next.name}`, { level: 'success' });
      }
    }
    this.updateChrome();
  }

  clearSession(): void {
    this.session = {
      activeMissionId: null,
      deployment: null,
      simulation: null,
      lastResult: null,
      recordedResultId: null,
    };
    this.updateChrome();
  }

  navigate(page: AppPage): void {
    const target = `#/${page}`;
    if (location.hash === target) {
      this.currentPage = page;
      this.renderPage();
      return;
    }
    location.hash = target;
  }

  toast(message: string, options: ToastLevel = {}): void {
    if (!this.toastHost) return;
    const toast = document.createElement('div');
    toast.className = `toast ${options.level ?? 'info'}`;
    toast.innerHTML = `<span class="toast-icon">${icon(options.level === 'success' ? 'check' : options.level === 'danger' || options.level === 'warning' ? 'alert' : 'info', 15)}</span><span>${escapeHtml(message)}</span>`;
    this.toastHost.appendChild(toast);
    window.setTimeout(() => toast.classList.add('leaving'), 3600);
    window.setTimeout(() => toast.remove(), 4100);
    while (this.toastHost.children.length > 4) this.toastHost.firstElementChild?.remove();
  }

  openSaveManager(): void {
    if (this.modal) return;
    const save = this.saveStore.get();
    const modal = document.createElement('div');
    modal.className = 'modal-layer';
    modal.innerHTML = `<div class="modal-scrim"></div>
      <div class="save-modal">
        <div class="modal-head">
          <div><span class="eyebrow">LOCAL ARCHIVE / 存档管理</span><h2>本地战役存档</h2></div>
          <button class="icon-btn" id="modal-close" aria-label="关闭">${icon('close', 16)}</button>
        </div>
        <div class="save-hero">
          <div class="save-hero-mark">${icon('save', 28)}</div>
          <div class="save-hero-main">
            <span class="save-version-big">${this.saveStore.getVersionLabel()}</span>
            <p>版本化存档 · 自动迁移旧格式 · 兼容历史战役记录</p>
            <span class="save-time">上次保存 ${dateTimeLabel(save.savedAt)}</span>
          </div>
          <div class="save-hero-stats">
            <div><b>${Object.keys(save.campaign.completed).length}</b><span>完成战区</span></div>
            <div><b>${save.deploymentPresets.length}</b><span>部署方案</span></div>
            <div><b>${save.records.length}</b><span>复盘记录</span></div>
          </div>
        </div>
        <div class="save-grid">
          <div class="save-info">
            <div class="save-info-row"><span>存档版本</span><b>schemaVersion = ${save.schemaVersion}</b></div>
            <div class="save-info-row"><span>存储位置</span><b>浏览器 localStorage</b></div>
            <div class="save-info-row"><span>迁移状态</span><b class="ok">${icon('check', 12)} v1 → v2 → v3 迁移链可用</b></div>
            <div class="save-info-row"><span>记录上限</span><b>最近 20 次动作复盘</b></div>
          </div>
          <div class="save-actions">
            <button class="btn btn-ghost" id="export-save">${icon('download', 14)} 导出存档 JSON</button>
            <button class="btn btn-ghost" id="import-save">${icon('upload', 14)} 导入存档</button>
            <button class="btn btn-ghost" id="legacy-save">${icon('refresh', 14)} 载入 v1 旧档示例</button>
            <button class="btn btn-ghost danger-ghost" id="reset-save">${icon('trash', 14)} 清空本地存档</button>
            <input type="file" id="save-file" accept="application/json,.json" hidden />
          </div>
        </div>
        <div class="save-migration">
          <div class="save-migration-head">${icon('info', 14)} 版本迁移记录</div>
          <div>${save.meta.migrationNotes.length > 0 ? save.meta.migrationNotes.map((note) => `<span>${escapeHtml(note)}</span>`).join('') : '<span>当前存档为最新 v3 格式，无需迁移。</span>'}</div>
          <small>未来格式变更时，只需追加迁移函数；旧档读取会依次执行 v(n) → v(n+1)，未知字段会被安全丢弃。</small>
        </div>
        <div class="modal-foot">
          <span>存档只保存在此浏览器，清理站点数据会删除存档。建议定期导出。</span>
          <button class="btn btn-primary btn-sm" id="modal-done">完成</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    this.modal = modal;
    const close = () => {
      modal.remove();
      this.modal = null;
    };
    modal.querySelector('#modal-close')?.addEventListener('click', close);
    modal.querySelector('#modal-done')?.addEventListener('click', close);
    modal.querySelector('.modal-scrim')?.addEventListener('click', close);
    modal.querySelector('#export-save')?.addEventListener('click', () => {
      downloadText(`forest-fire-save-v${save.schemaVersion}.json`, this.saveStore.exportSave());
      this.toast('存档 JSON 已导出', { level: 'success' });
    });
    modal.querySelector('#import-save')?.addEventListener('click', () => modal.querySelector<HTMLInputElement>('#save-file')?.click());
    modal.querySelector<HTMLInputElement>('#save-file')?.addEventListener('change', (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          const loaded = this.saveStore.importSave(text);
          this.clearSession();
          close();
          this.renderPage();
          this.toast(
            loaded.migratedFrom
              ? `存档已从 v${loaded.migratedFrom} 迁移至 v${loaded.save.schemaVersion}`
              : '存档导入成功',
            { level: 'success' },
          );
        } catch (error) {
          this.toast(error instanceof Error ? error.message : '存档导入失败', { level: 'danger' });
        }
      });
    });
    modal.querySelector('#legacy-save')?.addEventListener('click', () => {
      if (!window.confirm('载入内置 v1 旧档示例会覆盖当前本地存档，用于验证版本迁移。继续？')) return;
      const loaded = this.saveStore.importSave(JSON.stringify(LEGACY_SAVE_V1));
      this.clearSession();
      close();
      this.renderPage();
      this.toast(`已载入 v1 旧档，并迁移到 v${loaded.save.schemaVersion}`, { level: 'success' });
    });
    modal.querySelector('#reset-save')?.addEventListener('click', () => {
      if (!window.confirm('清空当前本地存档？此操作不可撤销，建议先导出备份。')) return;
      this.saveStore.reset();
      this.clearSession();
      close();
      this.renderPage();
      this.toast('本地存档已重置为初始战役状态', { level: 'warning' });
    });
  }

  private updateChrome(): void {
    if (!this.root.firstElementChild) return;
    this.root.querySelectorAll<HTMLElement>('[data-page]').forEach((button) => {
      button.classList.toggle('active', button.dataset['page'] === this.currentPage);
    });
    const meta = PAGE_META[this.currentPage];
    const barTitle = this.root.querySelector('#topbar-title');
    const barSub = this.root.querySelector('#topbar-sub');
    if (barTitle) barTitle.textContent = meta.title;
    if (barSub) barSub.textContent = meta.sub;
    const saveVersion = this.root.querySelector('#save-version');
    if (saveVersion) saveVersion.textContent = this.saveStore.getVersionLabel();
    const cfgPill = this.root.querySelector('#cfg-pill');
    if (cfgPill) cfgPill.textContent = `CONFIG v${this.getConfig().meta.configVersion}`;
    this.updateSideMission();
  }

  private updateSideMission(): void {
    const host = this.root.querySelector('#side-mission');
    if (!host) return;
    const config = this.getConfig();
    const save = this.saveStore.get();
    const active = this.getActiveMission()
      ?? config.scenarios.find((scenario) => save.campaign.unlockedMissions.includes(scenario.id))
      ?? config.scenarios[0];
    if (!active) {
      host.innerHTML = '';
      return;
    }
    const completed = save.campaign.completed[active.id];
    const simulation = this.session.simulation;
    const running = simulation && !simulation.finished;
    const progress = Math.round((save.campaign.unlockedMissions.length / config.scenarios.length) * 100);
    host.innerHTML = `<button class="side-mission-card" data-go-campaign>
      <span class="sm-top"><span class="sm-code">${escapeHtml(active.code)}</span><span class="sm-status ${running ? 'live' : ''}">${running ? '<i></i>推演中' : completed ? '已推演' : '待部署'}</span></span>
      <span class="sm-name">${escapeHtml(active.name)}</span>
      <span class="sm-sub">${escapeHtml(active.subtitle)}</span>
      <span class="sm-progress"><i style="width:${progress}%"></i></span>
      <span class="sm-foot"><span>${completed ? starMarkup(completed.bestStars, 10) : '尚未完成'}</span><span>${formatDifficulty(active.difficulty)}</span></span>
    </button>`;
    host.querySelector('[data-go-campaign]')?.addEventListener('click', () => this.navigate('campaign'));
  }

  private renderPage(): void {
    const host = this.root.querySelector<HTMLElement>('#screen-host');
    if (!host) return;
    const page = this.pageFromHash();
    this.currentPage = page;
    this.updateChrome();
    this.currentScreen?.unmount();
    this.currentScreen = null;
    host.replaceChildren();
    host.scrollTop = 0;
    window.scrollTo(0, 0);
    let screen: Screen;
    switch (page) {
      case 'deployment':
        screen = new DeploymentScreen(this);
        break;
      case 'command':
        screen = new CommandScreen(this);
        break;
      case 'review':
        screen = new ReviewScreen(this);
        break;
      case 'config':
        screen = new ConfigScreen(this);
        break;
      case 'campaign':
      default:
        screen = new CampaignScreen(this);
        break;
    }
    this.currentScreen = screen;
    const result = screen.mount();
    window.requestAnimationFrame(() => {
      host.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        this.toast(error instanceof Error ? error.message : '页面加载失败', { level: 'danger' });
      });
    }
  }

  private pageFromHash(): AppPage {
    const page = location.hash.replace(/^#\//, '').split('?')[0];
    if (page === 'deployment' || page === 'command' || page === 'review' || page === 'config') return page;
    return 'campaign';
  }

  private navButton(page: AppPage, iconName: 'map' | 'layers' | 'compass' | 'report' | 'sliders', label: string, english: string, index: string): string {
    return `<button class="nav-item" data-page="${page}">
      <span class="nav-index">${index}</span>
      <span class="nav-icon">${icon(iconName, 17)}</span>
      <span class="nav-copy"><b>${label}</b><small>${english}</small></span>
      <span class="nav-arrow">${icon('chevron', 12)}</span>
    </button>`;
  }
}

function formatDifficulty(value: number): string {
  return `${'●'.repeat(value)}${'○'.repeat(Math.max(0, 5 - value))}`;
}
