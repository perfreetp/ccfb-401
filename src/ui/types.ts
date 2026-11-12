import type { GameConfig, ScenarioConfig } from '../config/types';
import type { SaveStore } from '../save/store';
import type { ConfigStore } from '../config/configStore';
import type { DeploymentPlan, MissionResult } from '../sim/types';
import type { Simulation } from '../sim/engine';

export type AppPage = 'campaign' | 'deployment' | 'command' | 'review' | 'config';

export interface ToastLevel {
  level?: 'info' | 'success' | 'warning' | 'danger';
}

export interface AppApi {
  readonly saveStore: SaveStore;
  readonly configStore: ConfigStore;
  getConfig(): GameConfig;
  getActiveMission(): ScenarioConfig | null;
  getActiveSimulation(): Simulation | null;
  getLastResult(): MissionResult | null;
  getDeployment(): DeploymentPlan | null;
  setActiveMission(missionId: string): void;
  launchSimulation(plan: DeploymentPlan): void;
  recordSimulation(simulation: Simulation): void;
  navigate(page: AppPage): void;
  toast(message: string, options?: ToastLevel): void;
  openSaveManager(): void;
  clearSession(): void;
}

export interface Screen {
  mount(): void | Promise<void>;
  unmount(): void;
}
