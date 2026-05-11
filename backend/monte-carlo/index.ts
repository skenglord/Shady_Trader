// Monte Carlo Simulation Engine - Main Export
export { MonteCarloEngine } from './engine/monte-carlo-engine';
export { PathGenerator } from './engine/path-generator';
export { CorrelationMatrix } from './engine/correlation-matrix';
export { RiskCalculator } from './engine/risk-calculator';
export { StressTestRunner, BlackSwanScenario, FlashCrashScenario, LiquidityCrisisScenario, RegimeShiftScenario } from './engine/stress-test-engine';
export { MonteCarloWebSocketHandler } from './api/monte-carlo-websocket';
export { default as monteCarloRouter } from './api/monte-carlo.controller';

export type {
  MonteCarloRequest,
  MonteCarloResult,
  PathGeneratorConfig,
  CorrelationMatrixConfig,
  StressScenario,
  RiskMetrics,
  ValidationReport
} from './types';

export {
  validateCorrelationMatrix,
  ensurePositiveDefinite,
  validateSimulationParams,
  calculatePortfolioStats,
  estimateRuntime,
  checkConvergence,
  generateSeed,
  formatBytes
} from './utils/validation';
