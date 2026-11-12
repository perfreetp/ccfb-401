export interface CellPoint {
  x: number;
  y: number;
}

export interface LakeConfig {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export interface AssetConfig extends CellPoint {
  id: string;
  name: string;
  kind: 'tower' | 'camp' | 'village' | 'bridge';
}

export interface WindEventConfig {
  atSec: number;
  fromDeg: number;
  speed: number;
  transitionSec: number;
  warnSec: number;
  label: string;
}

export interface ScenarioConfig {
  id: string;
  code: string;
  name: string;
  subtitle: string;
  difficulty: number;
  seed: number;
  cols: number;
  rows: number;
  base: CellPoint;
  ignition: CellPoint;
  lakes: LakeConfig[];
  cliffs: LakeConfig[];
  assets: AssetConfig[];
  budget: number;
  durationSec: number;
  fuelMoistureOffset: number;
  weather: {
    fromDeg: number;
    speed: number;
    humidity: number;
    temperature: number;
  };
  windEvents: WindEventConfig[];
  maxBurnedHa: number;
  briefing: string;
  objective: string;
}

export interface VegetationConfig {
  name: string;
  fuel: number;
  spread: number;
  moisture: number;
  color: string;
  burnColor: string;
}

export interface TerrainConfig {
  name: string;
  color: string;
  passable: boolean;
  waterSource: boolean;
  speedFactor: number;
  heightTint: number;
}

export interface GroundUnitConfig {
  name: string;
  shortName: string;
  role: string;
  cost: number;
  speedCellsPerSec: number;
  waterCapacity: number;
  sprayRate: number;
  suppressPower: number;
  sprayRange: number;
  detectionRadius: number;
  digRate: number;
  canDig: boolean;
  canSpray: boolean;
  canFly: boolean;
  maxCount: number;
  color: string;
  description: string;
}

export interface HelicopterConfig {
  name: string;
  shortName: string;
  role: string;
  cost: number;
  speedCellsPerSec: number;
  waterCapacity: number;
  bucketSize: number;
  dropCooldownSec: number;
  detectionRadius: number;
  digRate: number;
  canDig: boolean;
  canSpray: boolean;
  canFly: boolean;
  maxCount: number;
  color: string;
  description: string;
}

export interface GameConfig {
  meta: {
    configVersion: number;
    title: string;
    cellSizeMeters: number;
  };
  world: {
    mapNoiseScale: number;
    detailNoiseScale: number;
    cliffSlopeThreshold: number;
    ridgeElevation: number;
    lakeShoreFalloff: number;
    roadSpeedFactor: number;
    baseRadiusCells: number;
    deploymentMinFireDistance: number;
    deploymentMinEdgeDistance: number;
  };
  fire: {
    spreadIntervalSec: number;
    baseSpreadChance: number;
    fuelFactorFloor: number;
    humidityFactorFloor: number;
    slopeFactorFloor: number;
    windAlignmentPower: number;
    windDownwindFloor: number;
    windSpeedFactorPerMs: number;
    slopeFactorPerMeter: number;
    maxSlopeFactor: number;
    humiditySensitivity: number;
    temperatureFactorPerDegree: number;
    moistureExponent: number;
    burnDurationSec: number;
    intensityGrowthPerSec: number;
    maxSpreadChancePerNeighbor: number;
    initialIgnitionRadiusCells: number;
    initialIgnitionIntensity: number;
    spotting: {
      minWindSpeed: number;
      chancePerBurningCellPerSec: number;
      maxDistanceCells: number;
      intensityThreshold: number;
    };
    backfireSpreadMultiplier: number;
    firebreakBlockChance: number;
    burnedFuelLoss: number;
  };
  suppression: {
    extinguishIntensity: number;
    wettedMoisture: number;
    wetnessDryRatePerSec: number;
    truckWetRadius: number;
    helicopterDropRadius: number;
    helicopterDropIntensityCut: number;
    helicopterDropWetness: number;
    firebreakProgressPerSec: number;
    minFirebreakProgress: number;
    sprayEfficiency: number;
  };
  behavior: {
    pathReplanSec: number;
    detectionRadiusCells: number;
    dangerRadiusCells: number;
    lowWaterThreshold: number;
    resupplyDwellSec: number;
    distressCooldownSec: number;
    trappedFireRadius: number;
    unsafeFireRadius: number;
    backfireCrewRadiusCells: number;
    safeSearchRadiusCells: number;
    autoBreakLookAheadCells: number;
    autoBreakMaxCells: number;
    retreatCooldownSec: number;
    lostAfterDistressSec: number;
    heliMinDropIntensity: number;
    heliTargetClusterRadius: number;
    unitIdleRadiusCells: number;
  };
  units: {
    ground: GroundUnitConfig;
    tender: GroundUnitConfig;
    helicopter: HelicopterConfig;
  };
  vegetation: Record<string, VegetationConfig>;
  terrain: Record<string, TerrainConfig>;
  rating: {
    threeStarBurnRatio: number;
    twoStarBurnRatio: number;
    passBurnRatio: number;
    threeStarRequiresAllAssets: boolean;
    containmentStabilitySec: number;
    assetLossFailRatio: number;
  };
  batch: {
    defaultRuns: number;
    maxRuns: number;
    tickSeconds: number;
    timeoutGuardSec: number;
  };
  scenarios: ScenarioConfig[];
}

export type UnitType = keyof GameConfig['units'];
