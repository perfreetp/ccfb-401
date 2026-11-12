import type { AppApi, Screen } from '../types';
import type { ScenarioConfig } from '../../config/types';
import {
  escapeHtml,
  formatClock,
  formatHa,
  formatNumber,
  icon,
  starMarkup,
  starsText,
  windFromLabel,
} from '../ui';

const NODE_POSITIONS = [
  { x: 16, y: 70 },
  { x: 37, y: 42 },
  { x: 52, y: 75 },
  { x: 68, y: 48 },
  { x: 82, y: 68 },
];

export class CampaignScreen implements Screen {
  private selectedId: string | null;
  private readonly app: AppApi;

  constructor(app: AppApi) {
    this.app = app;
    this.selectedId = app.getActiveMission()?.id ?? null;
  }

  mount(): void {
    const config = this.app.getConfig();
    const save = this.app.saveStore.get();
    const scenarios = config.scenarios;
    if (!this.selectedId) this.selectedId = scenarios.find((scenario) => save.campaign.unlockedMissions.includes(scenario.id))?.id ?? scenarios[0]?.id ?? null;
    const selected = scenarios.find((scenario) => scenario.id === this.selectedId) ?? scenarios[0];
    const completedCount = Object.keys(save.campaign.completed).length;
    const totalRuns = Object.values(save.campaign.completed).reduce((sum, record) => sum + record.runs, 0);
    const totalStars = Object.values(save.campaign.completed).reduce((sum, record) => sum + record.bestStars, 0);

    const pathLines = NODE_POSITIONS.map((position, index) => {
      if (index === NODE_POSITIONS.length - 1) return '';
      const next = NODE_POSITIONS[index + 1];
      const unlocked = scenarios[index + 1] && save.campaign.unlockedMissions.includes(scenarios[index + 1].id);
      return `<line x1="${position.x}%" y1="${position.y}%" x2="${next.x}%" y2="${next.y}%" class="route ${unlocked ? 'route-open' : ''}"/>`;
    }).join('');

    const nodes = scenarios.map((scenario, index) => {
      const position = NODE_POSITIONS[index] ?? { x: 10 + index * 15, y: 50 };
      const unlocked = save.campaign.unlockedMissions.includes(scenario.id);
      const complete = save.campaign.completed[scenario.id];
      const selected = scenario.id === this.selectedId;
      const status = !unlocked ? 'locked' : complete ? 'completed' : 'available';
      return `<button class="mission-node ${status} ${selected ? 'selected' : ''}" data-mission="${escapeHtml(scenario.id)}" style="left:${position.x}%;top:${position.y}%">
        <span class="node-halo"></span>
        <span class="node-ring">
          <span class="node-index">${escapeHtml(scenario.code.replace('OP-', ''))}</span>
          <span class="node-icon">${unlocked ? icon('flame', 18) : icon('shield', 16)}</span>
        </span>
        <span class="node-caption">
          <span class="node-name">${escapeHtml(scenario.name)}</span>
          <span class="node-meta">${unlocked ? (complete ? starMarkup(complete.bestStars, 10) : '可部署') : '未解锁'}</span>
        </span>
      </button>`;
    }).join('');

    const completed = save.campaign.completed[selected.id];
    const remaining = selected.durationSec;
    const assets = selected.assets.map((asset) => `<span class="dossier-asset">${escapeHtml(asset.name)}</span>`).join('');
    const weatherEvents = selected.windEvents.map((event) => {
      const from = windFromLabel(selected.weather.fromDeg);
      const to = windFromLabel(event.fromDeg);
      return `<div class="forecast-row">
        <span class="forecast-time">T+${formatClock(event.atSec)}</span>
        <span class="forecast-wind">${escapeHtml(from)} → ${escapeHtml(to)}</span>
        <span class="forecast-speed">${event.speed.toFixed(1)} m/s</span>
        <span class="forecast-label">${escapeHtml(event.label)}</span>
      </div>`;
    }).join('');

    const root = document.createElement('div');
    root.className = 'screen-inner campaign-screen';
    root.innerHTML = `
      <header class="page-heading">
        <div>
          <div class="eyebrow"><span class="eyebrow-line"></span> CAMPAIGN / 火场战役</div>
          <h1>把每一次风向变化，变成可控的转折</h1>
          <p class="page-lead">从青松岭的初起火灾到黑风口的极端风变。选择战区，编排队伍，实时指挥，然后用数据复盘。</p>
        </div>
        <div class="heading-stats">
          <div class="stat-block"><span class="stat-value">${completedCount}<small>/${scenarios.length}</small></span><span class="stat-label">已推演战区</span></div>
          <div class="stat-block"><span class="stat-value">${totalStars}<small>/ ${scenarios.length * 3}</small></span><span class="stat-label">累计星级</span></div>
          <div class="stat-block"><span class="stat-value">${formatNumber(totalRuns)}</span><span class="stat-label">历史出动次数</span></div>
        </div>
      </header>

      <div class="campaign-layout">
        <section class="campaign-board panel">
          <div class="board-grid"></div>
          <svg class="campaign-topo" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="ridgeFill" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#293528" stop-opacity="0"/>
                <stop offset="100%" stop-color="#7b8b60" stop-opacity=".12"/>
              </linearGradient>
            </defs>
            <path class="topo-fill" d="M0,470 C120,420 180,470 290,420 C390,370 470,430 580,360 C700,285 790,370 1000,250 L1000,620 L0,620Z" fill="url(#ridgeFill)"/>
            <path class="topo-line l1" d="M-20,510 C120,450 210,500 320,440 C430,380 530,450 650,380 C760,315 890,400 1020,320"/>
            <path class="topo-line l2" d="M-20,552 C140,490 230,535 340,475 C460,410 570,480 690,410 C800,345 910,430 1020,360"/>
            <path class="topo-line l3" d="M-30,596 C110,530 250,575 365,510 C480,445 610,515 735,445 C845,380 930,455 1030,400"/>
            <path class="topo-line l4" d="M80,260 C200,170 330,250 450,190 C580,120 690,210 820,155 C900,120 970,150 1020,120"/>
            <path class="topo-line l5" d="M40,305 C180,215 300,300 440,225 C570,155 700,255 840,195 C910,165 970,180 1020,160"/>
            <path class="river" d="M-20,430 C180,450 180,360 340,390 C480,420 470,330 610,335 C760,340 760,430 1010,395"/>
            <path class="river river-2" d="M700,620 C690,540 760,500 745,440 C735,390 800,380 870,360"/>
            <circle cx="760" cy="185" r="70" fill="#7d5c37" opacity=".08"/>
            <circle cx="250" cy="330" r="45" fill="#8a6a42" opacity=".07"/>
          </svg>

          <div class="board-header">
            <div class="board-label"><span class="live-dot"></span> 战区态势 / SECTOR OVERVIEW</div>
            <div class="board-legend">
              <span><i class="legend-dot available"></i>可部署</span>
              <span><i class="legend-dot completed"></i>已完成</span>
              <span><i class="legend-dot locked"></i>未解锁</span>
            </div>
          </div>
          <div class="campaign-node-layer">
            <svg class="route-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${pathLines}</svg>
            ${nodes}
          </div>
          <div class="map-coordinates">N 27°48′ · E 119°32′ <span>规划图 · SCALE 1:50000</span></div>
          <div class="north-arrow"><span>N</span><i></i></div>
          <div class="board-scan"></div>
        </section>

        <aside class="mission-dossier panel">
          <div class="dossier-top">
            <div>
              <div class="mission-code">${escapeHtml(selected.code)} · ${escapeHtml(selected.subtitle)}</div>
              <h2>${escapeHtml(selected.name)}</h2>
            </div>
            <div class="difficulty"><span>威胁</span>${Array.from({ length: 5 }, (_, index) => `<i class="${index < selected.difficulty ? 'on' : ''}"></i>`).join('')}</div>
          </div>
          ${completed ? `<div class="dossier-completed">${starMarkup(completed.bestStars)} <span>已推演 ${completed.runs} 次 · 最低过火 ${formatHa(completed.bestBurnedHa)}</span></div>` : ''}
          <p class="dossier-brief">${escapeHtml(selected.briefing)}</p>
          <div class="objective-box">
            <div class="objective-label">${icon('target', 14)} 任务目标</div>
            <p>${escapeHtml(selected.objective)}</p>
          </div>
          <div class="dossier-metrics">
            <div><span>预案预算</span><b>${selected.budget}<small> 点</small></b></div>
            <div><span>推演时限</span><b>${Math.round(remaining / 60)}<small> 分钟</small></b></div>
            <div><span>初始风场</span><b>${escapeHtml(windFromLabel(selected.weather.fromDeg))}<small> ${selected.weather.speed.toFixed(1)}m/s</small></b></div>
            <div><span>相对湿度</span><b>${selected.weather.humidity}<small> %</small></b></div>
            <div><span>过火上限</span><b>${formatHa(selected.maxBurnedHa)}</b></div>
            <div><span>保护设施</span><b>${selected.assets.length}<small> 处</small></b></div>
          </div>
          <div class="dossier-assets">${assets}</div>
          <div class="forecast-panel">
            <div class="forecast-head"><span>${icon('wind', 14)} 风场预报</span><span class="muted">阵风窗口</span></div>
            ${weatherEvents || '<div class="forecast-empty">本战区无额外阵风过程</div>'}
          </div>
          <div class="dossier-actions">
            <button class="btn btn-primary btn-lg" id="begin-deployment" ${!save.campaign.unlockedMissions.includes(selected.id) ? 'disabled' : ''}>
              ${save.campaign.unlockedMissions.includes(selected.id) ? `${icon('layers', 16)} 进入部署` : `${icon('shield', 16)} 战区未解锁`}
            </button>
            <button class="btn btn-ghost" id="view-records">${icon('report', 16)} 作战档案</button>
          </div>
          <div class="save-fingerprint">本地存档 ${this.app.saveStore.getVersionLabel()} · ${new Date(save.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
        </aside>
      </div>

      <section class="campaign-footer panel">
        <div class="footer-summary">
          <span class="eyebrow small">SQUAD READINESS</span>
          <p><b>部署不是摆队形，而是预判火会往哪里跑。</b> 风变前 15 秒，把水罐车和隔离带放到火头将要偏转的方向。</p>
        </div>
        <div class="footer-actions">
          <button class="text-link" id="open-batch">${icon('report', 14)} 批量推演对比</button>
          <button class="text-link" id="open-config">${icon('sliders', 14)} 数值配置</button>
          <span class="footer-hint">提示：每张图可在复盘页跑 ${this.app.getConfig().batch.defaultRuns} 局以上对比。</span>
        </div>
      </section>
    `;
    this.appRoot().appendChild(root);

    root.querySelectorAll<HTMLElement>('[data-mission]').forEach((node) => {
      node.addEventListener('click', () => {
        this.selectedId = node.dataset['mission'] ?? null;
        this.rerender();
      });
    });
    root.querySelector<HTMLButtonElement>('#begin-deployment')?.addEventListener('click', () => {
      if (!selected) return;
      this.app.setActiveMission(selected.id);
      this.app.navigate('deployment');
    });
    root.querySelector<HTMLButtonElement>('#view-records')?.addEventListener('click', () => this.app.navigate('review'));
    root.querySelector<HTMLButtonElement>('#open-batch')?.addEventListener('click', () => this.app.navigate('review'));
    root.querySelector<HTMLButtonElement>('#open-config')?.addEventListener('click', () => this.app.navigate('config'));
  }

  unmount(): void {
    // No persistent resources.
  }

  private rerender(): void {
    const host = this.appRoot();
    host.replaceChildren();
    this.mount();
  }

  private appRoot(): HTMLElement {
    const host = document.querySelector<HTMLElement>('#screen-host');
    if (!host) throw new Error('Screen host missing');
    return host;
  }
}
