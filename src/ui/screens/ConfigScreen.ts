import type { AppApi, Screen } from '../types';
import type { GameConfig } from '../../config/types';
import {
  debounce,
  downloadText,
  escapeHtml,
  icon,
  formatNumber,
} from '../ui';

type ConfigTab = 'fire' | 'units' | 'land' | 'scenario' | 'rules' | 'json';

interface FieldDef {
  path: string;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  kind?: 'number' | 'checkbox' | 'text';
}

interface FieldGroup {
  title: string;
  description?: string;
  fields: FieldDef[];
}

const TABS: { id: ConfigTab; label: string; description: string; icon: 'flame' | 'crew' | 'layers' | 'map' | 'sliders' | 'save' }[] = [
  { id: 'fire', label: '火行为', description: '蔓延、天气、压制与隔离带', icon: 'flame' },
  { id: 'units', label: '单位', description: '速度、水量、射程与探测半径', icon: 'crew' },
  { id: 'land', label: '植被与地形', description: '燃料、含水率与通行性', icon: 'layers' },
  { id: 'scenario', label: '战役参数', description: '战区预算、风场和设施', icon: 'map' },
  { id: 'rules', label: '评分与批量', description: '评级门槛、无头推演步长', icon: 'sliders' },
  { id: 'json', label: 'JSON 源码', description: '完整配置表，可直接编辑', icon: 'save' },
];

function getAtPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) return current[Number(key)];
    if (typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setAtPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: unknown = obj;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index];
    if (Array.isArray(current)) {
      current = current[Number(key)];
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return;
    }
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(current)) current[Number(last)] = value;
  else if (typeof current === 'object' && current !== null) (current as Record<string, unknown>)[last] = value;
}

function fireGroups(): FieldGroup[] {
  return [
    {
      title: '基础蔓延',
      description: '每个时间步、每个相邻格发生点火的基准概率。最终概率还会乘以风、坡度、燃料和湿度系数。',
      fields: [
        { path: 'fire.baseSpreadChance', label: '基准点火概率', unit: '/邻格/步', min: 0.001, max: 0.4, step: 0.001, help: '0.075 表示每次蔓延判定约 7.5% 基础概率。' },
        { path: 'fire.spreadIntervalSec', label: '蔓延判定间隔', unit: '秒', min: 0.25, max: 5, step: 0.05 },
        { path: 'fire.maxSpreadChancePerNeighbor', label: '单格概率上限', unit: '', min: 0.1, max: 1, step: 0.01, help: '避免极端风况下一格同时必然点燃所有邻居。' },
        { path: 'fire.burnDurationSec', label: '基础燃烧时长', unit: '秒', min: 4, max: 120, step: 1 },
        { path: 'fire.intensityGrowthPerSec', label: '强度增长率', unit: '/秒', min: 0.01, max: 0.3, step: 0.005 },
      ],
    },
    {
      title: '风与地形',
      description: '风向决定火头方向；风速放大蔓延；上坡加速、下坡减速。',
      fields: [
        { path: 'fire.windAlignmentPower', label: '顺风对齐权重', unit: '', min: 0.5, max: 5, step: 0.05, help: '数值越大，侧风方向受到抑制越明显。' },
        { path: 'fire.windDownwindFloor', label: '逆风保底系数', unit: '', min: 0, max: 0.5, step: 0.01 },
        { path: 'fire.windSpeedFactorPerMs', label: '风速增益', unit: '/m·s', min: 0, max: 0.3, step: 0.005 },
        { path: 'fire.slopeFactorPerMeter', label: '坡度增益', unit: '/米', min: 0, max: 0.05, step: 0.001 },
        { path: 'fire.maxSlopeFactor', label: '坡度系数上限', unit: '', min: 1, max: 4, step: 0.1 },
        { path: 'fire.slopeFactorFloor', label: '坡度系数下限', unit: '', min: 0.05, max: 1, step: 0.01 },
      ],
    },
    {
      title: '湿度与燃料',
      description: '空气湿度和植被含水率共同决定火线维持能力。',
      fields: [
        { path: 'fire.humiditySensitivity', label: '相对湿度敏感度', unit: '/%', min: 0, max: 0.03, step: 0.0005 },
        { path: 'fire.humidityFactorFloor', label: '湿度系数下限', unit: '', min: 0, max: 1, step: 0.01 },
        { path: 'fire.temperatureFactorPerDegree', label: '气温增益', unit: '/°C', min: 0, max: 0.02, step: 0.0005 },
        { path: 'fire.moistureExponent', label: '含水率抑制指数', unit: '', min: 0.2, max: 2, step: 0.01 },
        { path: 'fire.fuelFactorFloor', label: '燃料保底系数', unit: '', min: 0, max: 1, step: 0.01 },
      ],
    },
    {
      title: '飞火与逆火',
      description: '强风下的飞火会跨过隔离带，但概率低。',
      fields: [
        { path: 'fire.spotting.minWindSpeed', label: '飞火触发风速', unit: 'm/s', min: 0, max: 30, step: 0.5 },
        { path: 'fire.spotting.chancePerBurningCellPerSec', label: '飞火概率', unit: '/燃烧格/秒', min: 0, max: 0.05, step: 0.0005 },
        { path: 'fire.spotting.maxDistanceCells', label: '最大飞火距离', unit: '格', min: 1, max: 12, step: 1 },
        { path: 'fire.spotting.intensityThreshold', label: '飞火强度门槛', unit: '', min: 0, max: 1, step: 0.05 },
        { path: 'fire.backfireSpreadMultiplier', label: '逆火蔓延系数', unit: '', min: 0.1, max: 2, step: 0.01 },
        { path: 'fire.initialIgnitionRadiusCells', label: '初始火点半径', unit: '格', min: 0, max: 3, step: 0.05 },
        { path: 'fire.initialIgnitionIntensity', label: '初始火强度', unit: '', min: 0.1, max: 1, step: 0.01 },
      ],
    },
    {
      title: '压制效果',
      description: '单位洒水、吊桶与人工隔离带的数值。',
      fields: [
        { path: 'suppression.helicopterDropRadius', label: '吊桶覆盖半径', unit: '格', min: 0.5, max: 6, step: 0.05 },
        { path: 'suppression.helicopterDropIntensityCut', label: '每桶强度削减', unit: '', min: 0.1, max: 2, step: 0.05 },
        { path: 'suppression.helicopterDropWetness', label: '吊桶增湿量', unit: '', min: 0, max: 1, step: 0.02 },
        { path: 'suppression.extinguishIntensity', label: '明火熄灭阈值', unit: '', min: 0, max: 0.2, step: 0.005 },
        { path: 'suppression.wettedMoisture', label: '洒水增湿量', unit: '', min: 0, max: 1, step: 0.01 },
        { path: 'suppression.wetnessDryRatePerSec', label: '增湿衰减速率', unit: '/秒', min: 0, max: 0.1, step: 0.001 },
        { path: 'suppression.truckWetRadius', label: '水罐车润湿半径', unit: '格', min: 0, max: 3, step: 0.1 },
        { path: 'suppression.firebreakProgressPerSec', label: '隔离带效率系数', unit: '', min: 0.1, max: 3, step: 0.01 },
      ],
    },
  ];
}

function unitGroups(config: GameConfig): FieldGroup[] {
  const groundFields = unitFields('ground', '地面扑火队', config);
  const tenderFields = unitFields('tender', '水罐消防车', config);
  const heliFields = unitFields('helicopter', '救援直升机', config);
  return [
    {
      title: '地面扑火队 / GROUND',
      description: '抵近扑救、开挖隔离带；受地形、火线和断崖限制。',
      fields: groundFields,
    },
    {
      title: '水罐消防车 / TENDER',
      description: '大载水量、更远射程，移动速度慢，沿道路更快。',
      fields: tenderFields,
    },
    {
      title: '救援直升机 / AIR',
      description: '无视地形和火线，吊桶投水后需返回水源补给。',
      fields: heliFields,
    },
    {
      title: '自动行为阈值',
      description: '行为树在何时补水、避险、求救与自动开挖。',
      fields: [
        { path: 'behavior.lowWaterThreshold', label: '补水触发水量比例', unit: '', min: 0.05, max: 0.9, step: 0.01 },
        { path: 'behavior.dangerRadiusCells', label: '火线危险半径', unit: '格', min: 0.5, max: 5, step: 0.1 },
        { path: 'behavior.unsafeFireRadius', label: '必须立即撤离距离', unit: '格', min: 0.2, max: 3, step: 0.05 },
        { path: 'behavior.trappedFireRadius', label: '围困检测半径', unit: '格', min: 1, max: 4, step: 0.1 },
        { path: 'behavior.distressCooldownSec', label: '求救重复间隔', unit: '秒', min: 3, max: 60, step: 1 },
        { path: 'behavior.lostAfterDistressSec', label: '失联判定时长', unit: '秒', min: 10, max: 180, step: 5 },
        { path: 'behavior.pathReplanSec', label: '路径重算间隔', unit: '秒', min: 0.5, max: 10, step: 0.1 },
        { path: 'behavior.resupplyDwellSec', label: '补水停驻时长', unit: '秒', min: 0.3, max: 8, step: 0.1 },
        { path: 'behavior.heliMinDropIntensity', label: '直升机投水强度门槛', unit: '', min: 0, max: 1, step: 0.05 },
        { path: 'behavior.backfireCrewRadiusCells', label: '逆火所需队伍距离', unit: '格', min: 1, max: 15, step: 0.5 },
      ],
    },
  ];
}

function unitFields(type: 'ground' | 'tender' | 'helicopter', label: string, config: GameConfig): FieldDef[] {
  const fields: FieldDef[] = [
    { path: `units.${type}.cost`, label: '部署成本', unit: '点', min: 1, max: 100, step: 1 },
    { path: `units.${type}.speedCellsPerSec`, label: '移动速度', unit: '格/秒', min: 0.05, max: 3, step: 0.01 },
    { path: `units.${type}.waterCapacity`, label: '载水量', unit: 'L', min: 10, max: 5000, step: 10 },
    { path: `units.${type}.detectionRadius`, label: '火情探测半径', unit: '格', min: 1, max: 25, step: 0.5 },
    { path: `units.${type}.maxCount`, label: '单场上限', unit: '支', min: 1, max: 20, step: 1 },
    { path: `units.${type}.digRate`, label: '隔离带开挖速度', unit: '/秒', min: 0, max: 1, step: 0.01 },
  ];
  if (type !== 'helicopter') {
    fields.push(
      { path: `units.${type}.sprayRate`, label: '洒水流量', unit: 'L/秒', min: 0.1, max: 60, step: 0.1 },
      { path: `units.${type}.suppressPower`, label: '强度压制功率', unit: '/秒', min: 0.01, max: 1, step: 0.01 },
      { path: `units.${type}.sprayRange`, label: '有效射程', unit: '格', min: 0.3, max: 5, step: 0.05 },
    );
  } else {
    fields.push(
      { path: `units.${type}.bucketSize`, label: '吊桶单次水量', unit: 'L', min: 50, max: 2000, step: 10 },
      { path: `units.${type}.dropCooldownSec`, label: '投水冷却', unit: '秒', min: 1, max: 30, step: 0.5 },
    );
  }
  void label;
  return fields;
}

function scenarioGroups(config: GameConfig, scenarioId: string): FieldGroup[] {
  const index = Math.max(0, config.scenarios.findIndex((scenario) => scenario.id === scenarioId));
  const scenario = config.scenarios[index];
  const events: FieldGroup = {
    title: '风场过程',
    description: '每个风变事件会在指定时刻开始过渡。预警窗口越长，玩家越有时间调整部署。',
    fields: [],
  };
  scenario.windEvents.forEach((event, eventIndex) => {
    for (const [field, label, unit, min, max, step] of [
      ['atSec', '触发时刻', '秒', 0, 900, 1],
      ['fromDeg', '来风方向', '°', 0, 359, 1],
      ['speed', '风速', 'm/s', 0, 35, 0.1],
      ['transitionSec', '过渡时长', '秒', 1, 90, 1],
      ['warnSec', '预警提前量', '秒', 0, 60, 1],
    ] as const) {
      events.fields.push({
        path: `scenarios.${index}.windEvents.${eventIndex}.${field}`,
        label: `${event.label} · ${label}`,
        unit,
        min,
        max,
        step,
      });
    }
  });
  return [
    {
      title: '战区概览',
      description: `${scenario.code} · ${scenario.name} · ${scenario.subtitle}`,
      fields: [
        { path: `scenarios.${index}.budget`, label: '部署预算', unit: '点', min: 10, max: 500, step: 1 },
        { path: `scenarios.${index}.durationSec`, label: '推演时限', unit: '秒', min: 60, max: 1800, step: 10 },
        { path: `scenarios.${index}.maxBurnedHa`, label: '过火面积上限', unit: 'ha', min: 1, max: 1000, step: 1 },
        { path: `scenarios.${index}.fuelMoistureOffset`, label: '燃料含水偏移', unit: '', min: -0.2, max: 0.2, step: 0.005 },
        { path: `scenarios.${index}.weather.fromDeg`, label: '初始来风方向', unit: '°', min: 0, max: 359, step: 1 },
        { path: `scenarios.${index}.weather.speed`, label: '初始风速', unit: 'm/s', min: 0, max: 30, step: 0.1 },
        { path: `scenarios.${index}.weather.humidity`, label: '相对湿度', unit: '%', min: 5, max: 100, step: 1 },
        { path: `scenarios.${index}.weather.temperature`, label: '气温', unit: '°C', min: -5, max: 50, step: 1 },
        { path: `scenarios.${index}.seed`, label: '地图随机种子', unit: '', min: 1, max: 999999, step: 1 },
      ],
    },
    events,
    {
      title: '地图与部署规则',
      description: '影响所有战区的地图生成与部署校验。',
      fields: [
        { path: 'meta.cellSizeMeters', label: '单格边长', unit: 'm', min: 10, max: 200, step: 1 },
        { path: 'world.mapNoiseScale', label: '地形噪声频率', unit: '', min: 0.01, max: 0.3, step: 0.005 },
        { path: 'world.detailNoiseScale', label: '细节噪声频率', unit: '', min: 0.05, max: 0.6, step: 0.005 },
        { path: 'world.deploymentMinFireDistance', label: '距火点最小部署距离', unit: '格', min: 1, max: 20, step: 1 },
        { path: 'world.deploymentMinEdgeDistance', label: '距地图边缘', unit: '格', min: 0, max: 5, step: 1 },
        { path: 'world.ridgeElevation', label: '山脊高程阈值', unit: 'm', min: 50, max: 300, step: 5 },
      ],
    },
  ];
}

function rulesGroups(): FieldGroup[] {
  return [
    {
      title: '评级与任务判定',
      description: '以过火面积与预案上限的比例评定。2 星以上可以解锁下一战区。',
      fields: [
        { path: 'rating.threeStarBurnRatio', label: '三星过火比例上限', unit: '', min: 0.1, max: 1.5, step: 0.01 },
        { path: 'rating.twoStarBurnRatio', label: '二星过火比例上限', unit: '', min: 0.1, max: 2, step: 0.01 },
        { path: 'rating.passBurnRatio', label: '及格过火比例上限', unit: '', min: 0.2, max: 3, step: 0.01 },
        { path: 'rating.containmentStabilitySec', label: '明火熄灭稳定判定', unit: '秒', min: 3, max: 60, step: 1 },
        { path: 'rating.threeStarRequiresAllAssets', label: '三星要求设施零损失', kind: 'checkbox' },
      ],
    },
    {
      title: '批量推演',
      description: '无头推演由 Web Worker 运行。步长越大越快，细节越少。',
      fields: [
        { path: 'batch.defaultRuns', label: '默认每套局数', unit: '局', min: 10, max: 1000, step: 10 },
        { path: 'batch.maxRuns', label: '每套局数上限', unit: '局', min: 50, max: 2000, step: 50 },
        { path: 'batch.tickSeconds', label: '无头推演步长', unit: '秒', min: 0.25, max: 5, step: 0.25 },
        { path: 'batch.timeoutGuardSec', label: '超时保护', unit: '秒', min: 60, max: 1800, step: 30 },
      ],
    },
    {
      title: '存档与配置版本',
      description: '配置版本不会影响存档格式；存档迁移由独立版本链负责。',
      fields: [
        { path: 'meta.configVersion', label: '配置版本号', unit: '', min: 1, max: 999, step: 1 },
      ],
    },
  ];
}

export class ConfigScreen implements Screen {
  private readonly app: AppApi;
  private root: HTMLElement | null = null;
  private tab: ConfigTab = 'fire';
  private scenarioId: string | null = null;
  private saveNote = '所有修改已自动保存';
  private readonly lazySave = debounce(() => {
    this.saveNote = '已写入本地配置';
    const note = this.root?.querySelector('.config-save-state');
    if (note) note.innerHTML = `<i></i>${this.saveNote}`;
  }, 350);

  constructor(app: AppApi) {
    this.app = app;
  }

  mount(): void {
    this.renderPage();
  }

  unmount(): void {
    this.root = null;
  }

  private renderPage(): void {
    const host = document.querySelector<HTMLElement>('#screen-host');
    if (!host) return;
    const config = this.app.getConfig();
    if (!this.scenarioId) this.scenarioId = config.scenarios[0]?.id ?? null;
    const root = document.createElement('div');
    root.className = 'screen-inner config-screen';
    const sections: Record<ConfigTab, FieldGroup[]> = {
      fire: fireGroups(),
      units: unitGroups(config),
      land: [],
      scenario: scenarioGroups(config, this.scenarioId ?? ''),
      rules: rulesGroups(),
      json: [],
    };
    root.innerHTML = `
      <header class="config-head">
        <div>
          <div class="eyebrow"><span class="eyebrow-line"></span> BALANCE TABLES / 数值配置</div>
          <h1>把经验变成可复现的参数</h1>
          <p class="page-lead">所有火行为、单位性能、植被、战役与评分数值都在配置表中。修改立即保存，新推演生效，无需改代码。</p>
        </div>
        <div class="config-head-actions">
          <span class="config-save-state"><i></i>${this.saveNote}</span>
          <button class="btn btn-ghost btn-sm" id="config-import">${icon('upload', 13)} 导入</button>
          <button class="btn btn-ghost btn-sm" id="config-export">${icon('download', 13)} 导出</button>
          <button class="btn btn-ghost btn-sm danger-ghost" id="config-reset">${icon('refresh', 13)} 恢复默认</button>
        </div>
      </header>
      <div class="config-notice">${icon('info', 14)} 正在进行的推演会保留原有参数快照；修改后请开启新推演或批量推演以验证效果。配置版本 v${config.meta.configVersion} · 共 ${countNumbers(config)} 个数值项</div>
      <div class="config-layout">
        <aside class="config-nav panel">
          ${TABS.map((tab) => `<button class="config-nav-item ${this.tab === tab.id ? 'active' : ''}" data-config-tab="${tab.id}">
            <span class="cn-icon">${icon(tab.icon, 17)}</span>
            <span><b>${tab.label}</b><small>${tab.description}</small></span>
            ${icon('chevron', 13)}
          </button>`).join('')}
          <div class="config-version-card">
            <span class="eyebrow small">SCHEMA</span>
            <b>${this.app.saveStore.getVersionLabel()}</b>
            <small>旧版 v1 / v2 存档会在读取时自动迁移。</small>
            <span class="migration-ok">${icon('check', 12)} 迁移链已启用</span>
          </div>
        </aside>
        <main class="config-main panel" id="config-main"></main>
      </div>
      <input type="file" id="config-file" accept="application/json,.json" hidden />
    `;
    host.replaceChildren(root);
    this.root = root;
    root.querySelectorAll<HTMLElement>('[data-config-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tab = button.dataset['configTab'] as ConfigTab;
        this.renderPage();
      });
    });
    root.querySelector('#config-import')?.addEventListener('click', () => root.querySelector<HTMLInputElement>('#config-file')?.click());
    root.querySelector<HTMLInputElement>('#config-file')?.addEventListener('change', (event) => this.importConfig(event));
    root.querySelector('#config-export')?.addEventListener('click', () => {
      downloadText(`forest-fire-config-v${this.app.getConfig().meta.configVersion}.json`, this.exportConfig());
      this.app.toast('配置文件已导出', { level: 'success' });
    });
    root.querySelector('#config-reset')?.addEventListener('click', () => {
      if (!window.confirm('恢复所有数值到内置默认配置？当前自定义参数将丢失。')) return;
      this.app.configStore.reset();
      this.saveNote = '已恢复默认配置';
      this.app.toast('数值配置已恢复默认', { level: 'success' });
      this.renderPage();
    });
    this.renderMain(sections);
  }

  private renderMain(sections: Record<ConfigTab, FieldGroup[]>): void {
    const main = this.root?.querySelector<HTMLElement>('#config-main');
    if (!main) return;
    if (this.tab === 'json') {
      main.innerHTML = this.jsonMarkup();
      this.bindJson(main);
      return;
    }
    if (this.tab === 'scenario') {
      const config = this.app.getConfig();
      main.innerHTML = `<div class="config-main-head">
        <div><span class="eyebrow small">THEATER PARAMETERS</span><h2>${escapeHtml(config.scenarios.find((s) => s.id === this.scenarioId)?.name ?? '战役参数')}</h2></div>
        <label class="scenario-select">切换战区
          <select id="scenario-config-select">${config.scenarios.map((scenario) => `<option value="${escapeHtml(scenario.id)}" ${scenario.id === this.scenarioId ? 'selected' : ''}>${escapeHtml(scenario.code)} · ${escapeHtml(scenario.name)}</option>`).join('')}</select>
        </label>
      </div>
      <div class="field-groups">${this.groupsMarkup(sections[this.tab])}</div>`;
      main.querySelector('#scenario-config-select')?.addEventListener('change', (event) => {
        this.scenarioId = (event.target as HTMLSelectElement).value;
        this.renderPage();
      });
      this.bindFields(main);
      return;
    }
    main.innerHTML = `<div class="config-main-head">
      <div><span class="eyebrow small">${TABS.find((tab) => tab.id === this.tab)?.label.toUpperCase()}</span><h2>${TABS.find((tab) => tab.id === this.tab)?.description}</h2></div>
      <span class="config-main-badge">AUTO APPLY</span>
    </div>
    <div class="field-groups">${this.groupsMarkup(sections[this.tab])}</div>`;
    this.bindFields(main);
  }

  private fieldGridMarkup(fields: FieldDef[]): string {
    return `<div class="field-grid">${fields.map((field) => this.fieldMarkup(field)).join('')}</div>`;
  }

  private groupsMarkup(groups: FieldGroup[]): string {
    if (this.tab === 'land') {
      const config = this.app.getConfig();
      return `<div class="land-grid">
        ${Object.entries(config.vegetation).map(([key, veg]) => `<div class="land-card">
          <div class="land-swatch" style="background:${veg.color}"><span style="background:${veg.burnColor}"></span></div>
          <div class="land-head"><span class="eyebrow small">${key.toUpperCase()}</span><h3>${escapeHtml(veg.name)}</h3></div>
          ${this.fieldGridMarkup([
            { path: `vegetation.${key}.fuel`, label: '燃料载荷', min: 0, max: 1, step: 0.01 },
            { path: `vegetation.${key}.spread`, label: '蔓延系数', min: 0, max: 3, step: 0.01 },
            { path: `vegetation.${key}.moisture`, label: '基础含水率', min: 0, max: 1, step: 0.01 },
          ])}
        </div>`).join('')}
        ${Object.entries(config.terrain).map(([key, terrain]) => `<div class="land-card terrain-card">
          <div class="land-swatch terrain" style="background:${terrain.color}"></div>
          <div class="land-head"><span class="eyebrow small">${key.toUpperCase()}</span><h3>${escapeHtml(terrain.name)}</h3></div>
          ${this.fieldGridMarkup([
            { path: `terrain.${key}.speedFactor`, label: '通行速度系数', min: 0, max: 2, step: 0.01 },
            { path: `terrain.${key}.heightTint`, label: '高程着色', min: 0, max: 0.6, step: 0.01 },
          ])}
        </div>`).join('')}
      </div>`;
    }
    return groups.map((group) => group.fields.length > 0 ? `<section class="field-group">
      <div class="field-group-head"><div><h3>${escapeHtml(group.title)}</h3>${group.description ? `<p>${escapeHtml(group.description)}</p>` : ''}</div></div>
      <div class="field-grid">${group.fields.map((field) => this.fieldMarkup(field)).join('')}</div>
    </section>` : '').join('');
  }

  private fieldMarkup(field: FieldDef): string {
    const config = this.app.getConfig();
    const value = getAtPath(config, field.path);
    if (field.kind === 'checkbox') {
      return `<label class="field checkbox-field" title="${escapeHtml(field.help ?? '')}">
        <span class="field-label">${escapeHtml(field.label)}</span>
        <input type="checkbox" data-config-path="${escapeHtml(field.path)}" ${value ? 'checked' : ''}/>
        <span class="check-toggle">${icon('check', 12)}</span>
      </label>`;
    }
    if (field.kind === 'text') {
      return `<label class="field"><span class="field-label">${escapeHtml(field.label)}</span>
        <input type="text" data-config-path="${escapeHtml(field.path)}" value="${escapeHtml(value)}"/>
      </label>`;
    }
    const decimals = String(field.step ?? 1).split('.')[1]?.length ?? 0;
    return `<label class="field" title="${escapeHtml(field.help ?? '')}">
      <span class="field-label">${escapeHtml(field.label)}${field.unit ? `<em>${escapeHtml(field.unit)}</em>` : ''}</span>
      <div class="number-row">
        <input type="number" data-config-path="${escapeHtml(field.path)}"
          value="${Number(value).toFixed(decimals)}"
          min="${field.min ?? ''}" max="${field.max ?? ''}" step="${field.step ?? 1}"
          inputmode="decimal"/>
      </div>
      ${field.help ? `<span class="field-help">${escapeHtml(field.help)}</span>` : ''}
    </label>`;
  }

  private bindFields(scope: HTMLElement): void {
    scope.querySelectorAll<HTMLInputElement>('[data-config-path]').forEach((input) => {
      const path = input.dataset['configPath'];
      if (!path) return;
      const apply = () => {
        if (input.type === 'checkbox') {
          this.app.configStore.patch((draft) => setAtPath(draft, path, input.checked));
        } else {
          const number = Number(input.value);
          if (!Number.isFinite(number)) {
            this.app.toast('请输入有效数值', { level: 'warning' });
            return;
          }
          const min = input.min === '' ? -Infinity : Number(input.min);
          const max = input.max === '' ? Infinity : Number(input.max);
          const clamped = Math.max(min, Math.min(max, number));
          if (clamped !== number) {
            input.value = String(clamped);
            this.app.toast('数值已按允许范围修正', { level: 'warning' });
          }
          this.app.configStore.patch((draft) => setAtPath(draft, path, clamped));
        }
        this.saveNote = '修改已应用';
        this.lazySave();
        const note = this.root?.querySelector('.config-save-state');
        if (note) note.innerHTML = `<i class="dirty"></i>${this.saveNote}`;
      };
      input.addEventListener('change', apply);
    });
  }

  private jsonMarkup(): string {
    return `<div class="config-main-head">
      <div><span class="eyebrow small">RAW CONFIGURATION</span><h2>完整配置表 JSON</h2><p>适用于批量修改、版本管理或导入外部平衡表。应用后会立即覆盖本地配置。</p></div>
      <div class="json-actions"><button class="btn btn-ghost btn-sm" id="json-revert">${icon('refresh', 13)} 还原当前</button><button class="btn btn-primary btn-sm" id="json-apply">${icon('check', 13)} 应用 JSON</button></div>
    </div>
    <div class="json-editor-wrap">
      <div class="json-gutter">CONFIG<br>JSON</div>
      <textarea id="json-editor" spellcheck="false">${escapeHtml(this.exportConfig())}</textarea>
    </div>
    <div class="json-foot"><span>${icon('info', 13)} 编辑完整配置表可修改地图、设施坐标、风变文案等所有字段。</span><span id="json-status"></span></div>`;
  }

  private bindJson(main: HTMLElement): void {
    main.querySelector('#json-revert')?.addEventListener('click', () => {
      const textarea = main.querySelector<HTMLTextAreaElement>('#json-editor');
      if (textarea) textarea.value = this.exportConfig();
    });
    main.querySelector('#json-apply')?.addEventListener('click', () => {
      const textarea = main.querySelector<HTMLTextAreaElement>('#json-editor');
      if (!textarea) return;
      try {
        this.app.configStore.importJson(textarea.value);
        this.app.toast('JSON 配置已应用，新推演将使用新数值', { level: 'success' });
        this.saveNote = 'JSON 配置已应用';
        this.renderPage();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'JSON 格式错误';
        const status = main.querySelector('#json-status');
        if (status) status.textContent = message;
        this.app.toast(message, { level: 'danger' });
      }
    });
  }

  private importConfig(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        this.app.configStore.importJson(text);
        this.app.toast('配置文件已导入并生效', { level: 'success' });
        this.renderPage();
      } catch (error) {
        this.app.toast(error instanceof Error ? error.message : '导入失败', { level: 'danger' });
      }
      input.value = '';
    });
  }

  private exportConfig(): string {
    return this.app.configStore.exportJson();
  }
}

function countNumbers(config: GameConfig): number {
  let count = 0;
  const visit = (value: unknown): void => {
    if (typeof value === 'number') count++;
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(config);
  return count;
}
