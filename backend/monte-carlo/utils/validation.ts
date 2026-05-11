// Monte Carlo Utilities and Validation
import { Matrix } from 'ml-matrix';

/**
 * Validate correlation matrix is positive definite
 */
export function validateCorrelationMatrix(matrix: number[][]): {
  isValid: boolean;
  minEigenvalue: number;
  conditionNumber: number;
} {
  try {
    const mat = new Matrix(matrix);
    const eig = Matrix.eigenvalueDecomposition(mat);
    const eigenvals = eig.realEigenvalues;
    
    const minEigenval = Math.min(...eigenvals);
    const maxEigenval = Math.max(...eigenvals);
    const conditionNumber = maxEigenval / minEigenval;
    
    return {
      isValid: minEigenval > 1e-8,
      minEigenvalue: minEigenval,
      conditionNumber
    };
  } catch (error) {
    return {
      isValid: false,
      minEigenvalue: 0,
      conditionNumber: Infinity
    };
  }
}

/**
 * Ensure matrix is positive definite using eigenvalue clipping
 */
export function ensurePositiveDefinite(matrix: number[][]): number[][] {
  const mat = new Matrix(matrix);
  const eig = mat.eigenvalueDecomposition();
  const eigenvals = eig.realEigenvalues;
  const eigenvecs = eig.eigenvectorMatrix;
  
  // Clip negative eigenvalues
  const minEigenval = 1e-8;
  const clipped = eigenvals.map(val => Math.max(val, minEigenval));
  
  // Reconstruct matrix
  const Lambda = Matrix.diag(clipped);
  const corrected = eigenvecs.mmul(Lambda).mmul(eigenvecs.transpose());
  
  return corrected.to2DArray();
}

/**
 * Validate simulation parameters
 */
export function validateSimulationParams(params: {
  numPaths: number;
  timeHorizon: number;
  confidenceLevels: number[];
}): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (params.numPaths < 1000 || params.numPaths > 1000000) {
    errors.push('numPaths must be between 1,000 and 1,000,000');
  }
  
  if (params.timeHorizon < 1 || params.timeHorizon > 365) {
    errors.push('timeHorizon must be between 1 and 365 days');
  }
  
  params.confidenceLevels.forEach((cl, i) => {
    if (cl <= 0.5 || cl >= 1.0) {
      errors.push(`confidenceLevels[${i}] must be between 0.5 and 1.0`);
    }
  });
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Calculate portfolio statistics
 */
export function calculatePortfolioStats(positions: Array<{
  symbol: string;
  quantity: number;
  currentPrice: number;
}>): {
  totalValue: number;
  weights: Record<string, number>;
  numPositions: number;
} {
  const totalValue = positions.reduce(
    (sum, pos) => sum + pos.quantity * pos.currentPrice,
    0
  );
  
  const weights: Record<string, number> = {};
  positions.forEach(pos => {
    weights[pos.symbol] = (pos.quantity * pos.currentPrice) / totalValue;
  });
  
  return {
    totalValue,
    weights,
    numPositions: positions.length
  };
}

/**
 * Estimate simulation runtime
 */
export function estimateRuntime(
  numPaths: number,
  timeSteps: number,
  useGPU: boolean
): {
  estimatedMs: number;
  confidence: string;
} {
  // Empirical benchmarks
  const pathsPerMsCPU = 20;  // Approximate
  const pathsPerMsGPU = 200; // Approximate
  
  const throughput = useGPU ? pathsPerMsGPU : pathsPerMsCPU;
  const estimatedMs = (numPaths * timeSteps) / throughput;
  
  let confidence: string;
  if (estimatedMs < 100) {
    confidence = 'high';
  } else if (estimatedMs < 1000) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  
  return {
    estimatedMs,
    confidence
  };
}

/**
 * Check for convergence
 */
export function checkConvergence(
  values: number[],
  windowSize: number = 1000
): {
  converged: boolean;
  coefficientOfVariation: number;
  mean: number;
  std: number;
} {
  if (values.length < windowSize * 2) {
    return {
      converged: false,
      coefficientOfVariation: Infinity,
      mean: 0,
      std: 0
    };
  }
  
  const firstHalf = values.slice(0, windowSize);
  const secondHalf = values.slice(-windowSize);
  
  const mean1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const mean2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  
  const var1 = firstHalf.reduce((a, b) => a + Math.pow(b - mean1, 2), 0) / firstHalf.length;
  const var2 = secondHalf.reduce((a, b) => a + Math.pow(b - mean2, 2), 0) / secondHalf.length;
  
  const pooledMean = (mean1 + mean2) / 2;
  const pooledStd = Math.sqrt((var1 + var2) / 2);
  
  const cv = pooledStd / Math.abs(pooledMean);
  
  return {
    converged: cv < 0.05, // 5% threshold
    coefficientOfVariation: cv,
    mean: pooledMean,
    std: pooledStd
  };
}

/**
 * Generate random seed
 */
export function generateSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
