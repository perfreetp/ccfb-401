import type { Cell, GameMap } from './types';

export interface PathOptions {
  flying?: boolean;
  avoidFire?: boolean;
  dangerPenalty?: number;
  maxNodes?: number;
}

interface QueueNode {
  x: number;
  y: number;
  g: number;
  f: number;
  h: number;
  order: number;
}

class MinHeap {
  private items: QueueNode[] = [];
  private order = 0;

  push(node: Omit<QueueNode, 'order'>): void {
    const item = { ...node, order: this.order++ };
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): QueueNode | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  get size(): number {
    return this.items.length;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(this.items[index], this.items[parent])) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.items.length;
    while (true) {
      let smallest = index;
      const left = index * 2 + 1;
      const right = left + 1;
      if (left < length && this.less(this.items[left], this.items[smallest])) smallest = left;
      if (right < length && this.less(this.items[right], this.items[smallest])) smallest = right;
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }

  private less(a: QueueNode, b: QueueNode): boolean {
    return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.order < b.order)));
  }
}

const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

export function isPassable(map: GameMap, x: number, y: number, flying = false): boolean {
  if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return false;
  if (flying) return true;
  const cell = map.cells[y][x];
  return cell.terrain !== 'water' && cell.terrain !== 'cliff';
}

export function isCellBurning(map: GameMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return false;
  return map.cells[y][x].fire === 1;
}

function cellCost(map: GameMap, x: number, y: number, options: PathOptions): number {
  const cell = map.cells[y][x];
  if (!options.flying && (cell.terrain === 'water' || cell.terrain === 'cliff')) return Infinity;
  if (!options.flying && options.avoidFire !== false && cell.fire === 1) return Infinity;
  let cost = 1;
  if (!options.flying) {
    if (cell.terrain === 'road') cost = 0.74;
    else if (cell.terrain === 'ridge') cost = 1.22;
  }
  if (!options.flying && options.avoidFire !== false) {
    const danger = options.dangerPenalty ?? 4.5;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (isCellBurning(map, x + dx, y + dy)) cost += danger;
      }
    }
  }
  return cost;
}

function heuristic(dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  return ax + ay + (Math.SQRT2 - 2) * Math.min(ax, ay);
}

export function findPath(
  map: GameMap,
  start: { x: number; y: number },
  goal: { x: number; y: number },
  options: PathOptions = {},
): { x: number; y: number }[] | null {
  const maxNodes = options.maxNodes ?? map.cols * map.rows * 2;
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const gx = Math.floor(goal.x);
  const gy = Math.floor(goal.y);
  if (sx < 0 || sy < 0 || sx >= map.cols || sy >= map.rows) return null;
  if (sx === gx && sy === gy) return [{ x: sx, y: sy }];
  if (gx < 0 || gy < 0 || gx >= map.cols || gy >= map.rows) return null;
  if (!isPassable(map, gx, gy, options.flying)) return null;

  const cols = map.cols;
  const rows = map.rows;
  const size = cols * rows;
  const gScore = new Float32Array(size);
  gScore.fill(Infinity);
  const parents = new Int32Array(size);
  parents.fill(-1);
  const visited = new Uint8Array(size);
  const open = new MinHeap();

  const startIndex = sy * cols + sx;
  gScore[startIndex] = 0;
  open.push({ x: sx, y: sy, g: 0, h: heuristic(gx - sx, gy - sy), f: heuristic(gx - sx, gy - sy) });

  let expanded = 0;
  while (open.size > 0) {
    const current = open.pop()!;
    const index = current.y * cols + current.x;
    if (visited[index]) continue;
    visited[index] = 1;
    expanded++;
    if (current.x === gx && current.y === gy) {
      const path: { x: number; y: number }[] = [];
      let cursor = index;
      let guard = 0;
      while (cursor !== -1 && guard++ <= size) {
        if (cursor < 0 || cursor >= size) return null;
        path.push({ x: cursor % cols, y: Math.floor(cursor / cols) });
        cursor = parents[cursor];
      }
      if (cursor !== -1) return null;
      path.reverse();
      return path;
    }
    if (expanded > maxNodes) return null;

    for (const [dx, dy, moveCost] of DIRS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (visited[ny * cols + nx]) continue;
      if (dx !== 0 && dy !== 0) {
        if (!options.flying) {
          if (!isPassable(map, current.x + dx, current.y, false)) continue;
          if (!isPassable(map, current.x, current.y + dy, false)) continue;
        }
      }
      const step = cellCost(map, nx, ny, options);
      if (!Number.isFinite(step)) continue;
      const tentative = current.g + step * moveCost;
      const neighborIndex = ny * cols + nx;
      if (tentative >= gScore[neighborIndex]) continue;
      gScore[neighborIndex] = tentative;
      parents[neighborIndex] = index;
      const h = heuristic(gx - nx, gy - ny);
      open.push({ x: nx, y: ny, g: tentative, h, f: tentative + h });
    }
  }
  return null;
}

export function adjacencyDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy);
}

export function findNearestPassable(
  map: GameMap,
  start: { x: number; y: number },
  predicate?: (cell: Cell) => boolean,
  maxRadius = 8,
  flying = false,
): { x: number; y: number } | null {
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) continue;
        const cell = map.cells[y][x];
        if (!isPassable(map, x, y, flying)) continue;
        if (cell.fire === 1) continue;
        if (predicate && !predicate(cell)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

export function nearestWaterSource(
  map: GameMap,
  start: { x: number; y: number },
  flying = false,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      const cell = map.cells[y][x];
      if (!cell.terrain || !cell.terrain.includes('water')) {
        if (!(cell.base || cell.terrain === 'water')) continue;
      }
      if (!flying) {
        if (cell.terrain === 'water') {
          const shore = findNearestPassable(
            map,
            { x, y },
            (candidate) => candidate.terrain !== 'water' && candidate.fire !== 1,
            3,
            false,
          );
          if (!shore) continue;
          const d = (shore.x - start.x) ** 2 + (shore.y - start.y) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            best = shore;
          }
        } else if (cell.base) {
          const d = (x - start.x) ** 2 + (y - start.y) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            best = { x, y };
          }
        }
      } else {
        const d = (x - start.x) ** 2 + (y - start.y) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = { x, y };
        }
      }
    }
  }
  return best;
}

export function findRetreatCell(
  map: GameMap,
  start: { x: number; y: number },
  flying: boolean,
  safeRadius = 4,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      if (!isPassable(map, x, y, flying)) continue;
      const cell = map.cells[y][x];
      if (cell.fire === 1) continue;
      let minFireDistance = 99;
      for (let dy = -safeRadius; dy <= safeRadius; dy++) {
        for (let dx = -safeRadius; dx <= safeRadius; dx++) {
          if (isCellBurning(map, x + dx, y + dy)) {
            minFireDistance = Math.min(minFireDistance, Math.max(Math.abs(dx), Math.abs(dy)));
          }
        }
      }
      if (minFireDistance < 2.1) continue;
      const distance = (x - start.x) ** 2 + (y - start.y) ** 2;
      const score = distance - minFireDistance * 8;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}
