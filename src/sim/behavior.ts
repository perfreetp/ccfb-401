import type { Unit } from './types';

export enum BTStatus {
  Success = 'success',
  Failure = 'failure',
  Running = 'running',
}

export interface AIHooks {
  isTrapped(unit: Unit): boolean;
  isLowWater(unit: Unit): boolean;
  isInDanger(unit: Unit): boolean;
  hasPlayerCommand(unit: Unit): boolean;
  hasBreakWork(unit: Unit): boolean;
  fireDetected(unit: Unit): boolean;
  runDistress(unit: Unit, dt: number): BTStatus;
  runRetreat(unit: Unit, dt: number): BTStatus;
  runResupply(unit: Unit, dt: number): BTStatus;
  runCommand(unit: Unit, dt: number): BTStatus;
  runBreak(unit: Unit, dt: number): BTStatus;
  runFight(unit: Unit, dt: number): BTStatus;
  runIdle(unit: Unit, dt: number): BTStatus;
}

export interface AIContext {
  unit: Unit;
  dt: number;
  hooks: AIHooks;
}

export abstract class BTNode {
  constructor(
    readonly id: string,
    readonly label: string,
  ) {}

  abstract tick(ctx: AIContext): BTStatus;
}

export class Sequence extends BTNode {
  constructor(
    id: string,
    label: string,
    readonly children: BTNode[],
  ) {
    super(id, label);
  }

  tick(ctx: AIContext): BTStatus {
    for (const child of this.children) {
      const status = child.tick(ctx);
      if (status !== BTStatus.Success) return status;
    }
    return BTStatus.Success;
  }
}

export class Selector extends BTNode {
  constructor(
    id: string,
    label: string,
    readonly children: BTNode[],
  ) {
    super(id, label);
  }

  tick(ctx: AIContext): BTStatus {
    for (const child of this.children) {
      const status = child.tick(ctx);
      if (status !== BTStatus.Failure) return status;
    }
    return BTStatus.Failure;
  }
}

export class Condition extends BTNode {
  constructor(
    id: string,
    label: string,
    readonly predicate: (ctx: AIContext) => boolean,
  ) {
    super(id, label);
  }

  tick(ctx: AIContext): BTStatus {
    return this.predicate(ctx) ? BTStatus.Success : BTStatus.Failure;
  }
}

export class Action extends BTNode {
  constructor(
    id: string,
    label: string,
    readonly run: (ctx: AIContext) => BTStatus,
  ) {
    super(id, label);
  }

  tick(ctx: AIContext): BTStatus {
    ctx.unit.btNode = this.id;
    return this.run(ctx);
    }
}

export interface BehaviorNodeDescription {
  id: string;
  label: string;
  kind: 'selector' | 'sequence' | 'condition' | 'action';
  children?: BehaviorNodeDescription[];
}

function describe(node: BTNode): BehaviorNodeDescription {
  if (node instanceof Sequence) {
    return { id: node.id, label: node.label, kind: 'sequence', children: node.children.map(describe) };
  }
  if (node instanceof Selector) {
    return { id: node.id, label: node.label, kind: 'selector', children: node.children.map(describe) };
  }
  if (node instanceof Condition) {
    return { id: node.id, label: node.label, kind: 'condition' };
  }
  return { id: node.id, label: node.label, kind: 'action' };
}

function actions(hooks: AIHooks): Record<string, (unit: Unit, dt: number) => BTStatus> {
  return {
    distress: (unit, dt) => hooks.runDistress(unit, dt),
    retreat: (unit, dt) => hooks.runRetreat(unit, dt),
    resupply: (unit, dt) => hooks.runResupply(unit, dt),
    command: (unit, dt) => hooks.runCommand(unit, dt),
    break: (unit, dt) => hooks.runBreak(unit, dt),
    fight: (unit, dt) => hooks.runFight(unit, dt),
    idle: (unit, dt) => hooks.runIdle(unit, dt),
  };
}

export function buildBehaviorTree(hooks: AIHooks): { tree: BTNode; description: BehaviorNodeDescription } {
  const run = actions(hooks);
  const sequence = (id: string, label: string, condition: (unit: Unit) => boolean, actionId: string): Sequence =>
    new Sequence(id, label, [
      new Condition(`${id}-cond`, label, (ctx) => condition(ctx.unit)),
      new Action(`${actionId}-act`, label, (ctx) => run[actionId](ctx.unit, ctx.dt)),
    ]);

  const root = new Selector('root', '行为树根节点', [
    sequence('sos', '被困求救', (unit) => hooks.isTrapped(unit), 'distress'),
    sequence('safety', '危险避险', (unit) => hooks.isInDanger(unit), 'retreat'),
    sequence('supply', '低水位补水', (unit) => hooks.isLowWater(unit), 'resupply'),
    sequence('command', '执行玩家指令', (unit) => hooks.hasPlayerCommand(unit), 'command'),
    sequence('break', '开挖隔离带', (unit) => hooks.hasBreakWork(unit), 'break'),
    sequence('detect', '发现火情', (unit) => hooks.fireDetected(unit), 'fight'),
    new Action('idle', '原地警戒', (ctx) => run['idle'](ctx.unit, ctx.dt)),
  ]);

  return { tree: root, description: describe(root) };
}

export const BEHAVIOR_LABELS: Record<string, string> = {
  root: '行为选择',
  sos: '被困求救',
  safety: '危险避险',
  supply: '低水位补水',
  command: '执行玩家指令',
  break: '开挖隔离带',
  detect: '发现火情',
  idle: '原地警戒',
  'sos-cond': '判定：被火线合围 / 无安全路径',
  'safety-cond': '判定：火线进入危险半径',
  'supply-cond': '判定：水量低于阈值',
  'command-cond': '判定：存在玩家下达的任务',
  'break-cond': '判定：隔离带计划未完成',
  'detect-cond': '判定：探测半径内存在明火',
  'distress-act': '发送坐标、寻找突围方向',
  'retreat-act': '撤向安全地域',
  'resupply-act': '前往最近水源补水',
  'command-act': '机动至目标并执行',
  'break-act': '抵近火线前缘开挖隔离带',
  'fight-act': '逼近火点并实施压制',
  'idle-act': '在部署点附近警戒',
};
