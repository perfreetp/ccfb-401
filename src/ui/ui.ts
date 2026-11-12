export type IconName =
  | 'map'
  | 'layers'
  | 'compass'
  | 'report'
  | 'sliders'
  | 'save'
  | 'close'
  | 'flame'
  | 'wind'
  | 'water'
  | 'crew'
  | 'truck'
  | 'heli'
  | 'clock'
  | 'shield'
  | 'alert'
  | 'play'
  | 'pause'
  | 'fast'
  | 'target'
  | 'break'
  | 'drop'
  | 'backfire'
  | 'arrow'
  | 'chevron'
  | 'plus'
  | 'trash'
  | 'download'
  | 'upload'
  | 'refresh'
  | 'check'
  | 'info';

const ICONS: Record<IconName, string> = {
  map: '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5Z"/><path d="M9 4v13.5M15 6.5V20"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/><path d="M12 1.8v2M12 20.2v2M1.8 12h2M20.2 12h2"/>',
  report: '<path d="M6 3h9l4 4v14H6V3Z"/><path d="M15 3v5h5M9 12h6M9 15h6M9 18h3"/>',
  sliders: '<path d="M4 6h5M13 6h7M4 12h9M17 12h3M4 18h3M11 18h9"/><circle cx="11" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  save: '<path d="M4 4h13l3 3v13H4V4Z"/><path d="M7 4v6h9V4M7 20v-7h10v7"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  flame: '<path d="M12 21c-4 0-7-2.7-7-6.4 0-3.9 3.2-6.1 4.5-9.6.5 2.4 2 3 2.9 4.8 1.1-2 2.6-3.4 3.1-5.4 2.2 2.4 3.5 4.4 3.5 7.1 0 5.6-3.1 9.5-7 9.5Z"/><path d="M12 20c-1.9 0-3.2-1.3-3.2-3 0-1.5 1-2.5 2.2-4 .4 1.7 1.5 2.2 2 3.6.5-1.1 1.4-1.6 2.1-2.4.4 1.7.9 3.6-.1 5.8Z"/>',
  wind: '<path d="M3 8h10a3 3 0 0 0 0-6H9M3 12h16M3 16h8a2.5 2.5 0 0 1 0 5H8"/>',
  water: '<path d="M12 3s6 6.7 6 11a6 6 0 0 1-12 0C6 9.7 12 3 12 3Z"/><path d="M8.5 14.5c.7 1.3 2 2 3.5 2"/>',
  crew: '<circle cx="12" cy="7" r="3.1"/><path d="M5.5 20c.2-4.1 2.6-6.7 6.5-6.7s6.3 2.6 6.5 6.7M3 12l2.5-2M21 12l-2.5-2"/>',
  truck: '<path d="M3 7h11v9H3V7ZM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M5 10h5v3H5z"/>',
  heli: '<path d="M4 6h16M12 6v2.5M8 18h8M12 9c-2 0-3 1-3 3v2h6v-2c0-2-1-3-3-3Z"/><path d="M9 16l-2 2M15 16l2 2M12 18v2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.5 2"/>',
  shield: '<path d="M12 3 20 6v5c0 5-3.1 8.3-8 10-4.9-1.7-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.4 2.4 4.7-5"/>',
  alert: '<path d="M12 3 22 20H2L12 3Z"/><path d="M12 9v5M12 17v.5"/>',
  play: '<path d="M8 5v14l11-7-11-7Z"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  fast: '<path d="m4 5 8 7-8 7V5ZM12 5l8 7-8 7V5Z"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  break: '<path d="M3 16h18M4 10l3-3 3 3 3-3 3 3 3-3 3 3"/><path d="M7 16v-3M12 16v-4M17 16v-3"/>',
  drop: '<path d="M12 3s5.2 5.6 5.2 9.4a5.2 5.2 0 0 1-10.4 0C6.8 8.6 12 3 12 3Z"/><path d="M9 13c.4.9 1.2 1.5 2.2 1.6"/>',
  backfire: '<path d="M4 20h16M6 17c0-4 3-6 4-10 1 4 4 6 4 10"/><path d="M9 16c.3-1.6 1.2-2.7 2.2-3.8.2 1.4 1.2 2 1.5 3.3-.5.2-2.2.4-3.7.5Z"/>',
  arrow: '<path d="M4 12h15M13 6l7 6-7 6"/>',
  chevron: '<path d="m8 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  refresh: '<path d="M20 11a8 8 0 1 1-2.3-5.6M20 4v7h-7"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 6.5v.5"/>',
};

export function icon(name: IconName, size = 18, className = ''): string {
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatHoursMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} 分钟`;
}

export function formatNumber(value: number, digits = 0): string {
  return Number(value).toLocaleString('zh-CN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

export function formatHa(value: number): string {
  return `${formatNumber(value, value < 10 ? 1 : 0)}<span class="unit">ha</span>`;
}

export function starMarkup(stars: number, size = 13): string {
  return `<span class="stars" aria-label="${stars} 星">${'★'.repeat(stars)}<span class="stars-empty">${'☆'.repeat(Math.max(0, 3 - stars))}</span></span>`;
}

export function starsText(stars: number): string {
  return `${'★'.repeat(stars)}${'☆'.repeat(Math.max(0, 3 - stars))}`;
}

export function windFromLabel(fromDeg: number): string {
  const labels = ['北', '北北东', '东北', '东北东', '东', '东南东', '东南', '南南东', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'];
  const index = Math.round((((fromDeg % 360) + 360) % 360) / 22.5) % 16;
  return labels[index];
}

export function windClassName(fromDeg: number): string {
  return 'wind-' + Math.round((((fromDeg % 360) + 360) % 360) / 45) % 8;
}

export function relativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const delta = (Date.now() - time) / 1000;
  if (delta < 60) return '刚刚';
  if (delta < 3600) return `${Math.round(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.round(delta / 3600)} 小时前`;
  return new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function dateTimeLabel(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): (...args: Parameters<T>) => void {
  let timer = 0;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export function downloadText(filename: string, content: string, type = 'application/json'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface LineChartOptions {
  width: number;
  height: number;
  maxY: number;
  goal?: number;
  color?: string;
  markers?: { x: number; label: string; color?: string }[];
  yLabel?: string;
}

export function lineChartSvg(
  points: { x: number; y: number }[],
  options: LineChartOptions,
): string {
  const { width, height, maxY, goal, color = '#e5a142' } = options;
  const pad = { left: 34, right: 12, top: 12, bottom: 24 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const mapX = (x: number) => pad.left + (x / maxX) * innerW;
  const mapY = (y: number) => pad.top + innerH - Math.min(1, y / Math.max(1, maxY)) * innerH;
  const path = points.length > 1
    ? points.map((point, index) => `${index === 0 ? 'M' : 'L'}${mapX(point.x).toFixed(1)},${mapY(point.y).toFixed(1)}`).join(' ')
    : '';
  const areaPath = points.length > 1
    ? `${path} L${mapX(points[points.length - 1].x).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${mapX(points[0].x).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`
    : '';
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const y = pad.top + innerH - fraction * innerH;
    const value = maxY * fraction;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="chart-grid"/>
      <text x="${pad.left - 6}" y="${y + 3}" text-anchor="end" class="chart-axis">${Math.round(value)}</text>`;
  }).join('');
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const x = pad.left + fraction * innerW;
    const value = Math.round(maxX * fraction);
    return `<text x="${x}" y="${height - 6}" text-anchor="middle" class="chart-axis">${value}s</text>`;
  }).join('');
  const markers = (options.markers ?? []).map((marker) => {
    const x = mapX(marker.x);
    return `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${pad.top + innerH}" stroke="${marker.color ?? '#d15b42'}" stroke-width="1" stroke-dasharray="3 4" opacity=".7"/>
      <circle cx="${x}" cy="${pad.top + 4}" r="2.4" fill="${marker.color ?? '#d15b42'}"/>
      <text x="${x + 4}" y="${pad.top + 8}" class="chart-marker">${escapeHtml(marker.label)}</text>`;
  }).join('');
  const goalLine = goal !== undefined && goal > 0
    ? `<line x1="${pad.left}" y1="${mapY(goal)}" x2="${width - pad.right}" y2="${mapY(goal)}" stroke="#d6d6b2" stroke-width="1" stroke-dasharray="5 4" opacity=".45"/>
       <text x="${width - pad.right - 2}" y="${mapY(goal) - 5}" text-anchor="end" class="chart-goal">上限 ${Math.round(goal)}ha</text>`
    : '';
  const last = points[points.length - 1];
  return `<svg class="line-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    ${yTicks}${xTicks}${goalLine}
    ${areaPath ? `<path d="${areaPath}" fill="${color}" opacity=".11"/>` : ''}
    ${path ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>` : ''}
    ${markers}
    ${last ? `<circle cx="${mapX(last.x)}" cy="${mapY(last.y)}" r="3" fill="${color}"/><title>${last.y.toFixed(1)} ha</title>` : ''}
  </svg>`;
}

export function strategyBarChart(
  strategies: { name: string; color: string; value: number; max: number; sublabel: string }[],
): string {
  const maxValue = Math.max(1, ...strategies.map((s) => Math.max(s.value, s.max)));
  return `<div class="bar-list">${strategies.map((strategy) => `
    <div class="bar-row">
      <div class="bar-label"><span class="dot" style="background:${strategy.color}"></span>${escapeHtml(strategy.name)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.max(2, strategy.value / maxValue * 100)}%;background:${strategy.color}"></div>
        <div class="bar-range" style="width:${strategy.max / maxValue * 100}%"></div>
      </div>
      <div class="bar-value">${escapeHtml(strategy.sublabel)}</div>
    </div>`).join('')}</div>`;
}
