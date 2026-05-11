// Correlation Matrix Engine - Cholesky Decomposition and Stress Testing
import { Matrix } from 'ml-matrix';

export class CorrelationMatrix {
  private covMatrix: Matrix;
  private cholFactor: Matrix | null = null;
  private eigenvals: number[] | null = null;
  private eigenvecs: Matrix | null = null;

  constructor(
    private returns: number[][],  // [nTimesteps × nAssets]
    private method: 'ledoit-wolf' | 'sample' = 'ledoit-wolf'
  ) {
    this.covMatrix = this.computeCovariance();
  }

  /**
   * Compute covariance matrix with shrinkage for stability
   */
  private computeCovariance(): Matrix {
    const n = this.returns.length;      // Timesteps
    const p = this.returns[0].length;   // Assets
    
    // Convert to Matrix
    const X = new Matrix(this.returns);
    
    // Center the data
    const means = X.mean('column');
    const X_centered = X.subRowVector(means);
    
    // Sample covariance
    const sampleCov = X_centered.transpose().mmul(X_centered).div(n - 1);
    
    if (this.method === 'sample') {
      return sampleCov;
    }
    
    // Ledoit-Wolf shrinkage
    return this.ledoitWolfShrinkage(sampleCov, X_centered);
  }

  /**
   * Ledoit-Wolf shrinkage estimator for improved stability
   */
  private ledoitWolfShrinkage(sampleCov: Matrix, X_centered: Matrix): Matrix {
    const n = X_centered.rows;
    const p = X_centered.columns;
    
    // Compute sample variances
    const vars = sampleCov.diagonal();
    const meanVar = vars.reduce((a, b) => a + b, 0) / p;
    
    // Compute average correlation
    let sumCorr = 0;
    let count = 0;
    for (let i = 0; i < p; i++) {
      for (let j = i + 1; j < p; j++) {
        const corr = sampleCov.get(i, j) / Math.sqrt(vars[i] * vars[j]);
        sumCorr += corr;
        count++;
      }
    }
    const meanCorr = count > 0 ? sumCorr / count : 0;
    
    // Target matrix: constant correlation
    const target = Matrix.eye(p, p).mul(meanVar);
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        if (i !== j) {
          target.set(i, j, meanCorr * Math.sqrt(vars[i] * vars[j]));
        }
      }
    }
    
    // Compute shrinkage intensity
    const normF = (A: Matrix, B: Matrix) => {
      let sum = 0;
      for (let i = 0; i < A.rows; i++) {
        for (let j = 0; j < A.columns; j++) {
          const diff = A.get(i, j) - B.get(i, j);
          sum += diff * diff;
        }
      }
      return sum;
    };
    
    const piHat = this.computePiHat(X_centered, sampleCov, meanVar, meanCorr);
    const gamma = normF(sampleCov.sub(target), sampleCov.sub(target));
    const kappa = (piHat - gamma) / gamma;
    const shrinkage = Math.max(0, Math.min(1, kappa / n));
    
    // Shrinkage estimator
    return target.mul(shrinkage).add(sampleCov.mul(1 - shrinkage));
  }

  private computePiHat(
    X: Matrix,
    sampleCov: Matrix,
    meanVar: number,
    meanCorr: number
  ): number {
    const n = X.rows;
    const p = X.columns;
    
    let sum = 0;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        let covEst = 0;
        for (let k = 0; k < n; k++) {
          const xik = X.get(k, i) - sampleCov.get(i, i);
          const xjk = X.get(k, j) - sampleCov.get(j, j);
          covEst += xik * xjk;
        }
        covEst /= n;
        
        const trueCov = (i === j) ? meanVar : meanCorr * Math.sqrt(meanVar * meanVar);
        sum += Math.pow(covEst - trueCov, 2);
      }
    }
    
    return sum / (n * n);
  }

  /**
   * Cholesky decomposition: Σ = L · L^T
   * Returns lower triangular matrix L
   */
  cholesky(): Matrix {
    if (this.cholFactor) {
      return this.cholFactor;
    }
    
    try {
      this.cholFactor = Matrix.cholesky(this.covMatrix);
      return this.cholFactor;
    } catch (error) {
      // Fallback: use eigenvalue correction
      return this.choleskyWithCorrection();
    }
  }

  /**
   * Modified Cholesky with eigenvalue correction for near-singular matrices
   */
  private choleskyWithCorrection(): Matrix {
    const corrected = this.covMatrix.clone();
    const minEigenval = 1e-8;
    
    // Compute eigendecomposition
    const eig = Matrix.eigenvalueDecomposition(corrected);
    const eigenvals = eig.realEigenvalues;
    const eigenvecs = eig.eigenvectorMatrix;
    
    // Clip negative eigenvalues
    const clipped = eigenvals.map(val => Math.max(val, minEigenval));
    
    // Reconstruct: Σ = Q · Λ · Q^T
    const Lambda = Matrix.diag(clipped);
    const correctedCov = eigenvecs.mmul(Lambda).mmul(eigenvecs.transpose());
    
    this.covMatrix = correctedCov;
    this.cholFactor = Matrix.cholesky(correctedCov);
    this.eigenvals = clipped;
    this.eigenvecs = eigenvecs;
    
    return this.cholFactor;
  }

  /**
   * Generate correlated random numbers
   * Z_correlated = L · Z where Z ~ N(0, I)
   */
  generateCorrelatedNoise(numSamples: number): number[][] {
    const L = this.cholesky();
    const p = L.rows;
    const noise: number[][] = [];
    
    for (let i = 0; i < numSamples; i++) {
      const z = Array(p).fill(0).map(() => this.gaussianRandom());
      const correlated = L.mmul(Matrix.columnVector(z)).to1DArray();
      noise.push(correlated);
    }
    
    return noise;
  }

  private gaussianRandom(): number {
    // Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return r * Math.cos(theta);
  }

  /**
   * Apply stress scenario to correlation matrix
   */
  applyStress(scenario: {
    type: 'crisis' | 'flight-to-quality' | 'regime-shift';
    intensity?: number;
  }): Matrix {
    const intensity = scenario.intensity || 1.0;
    const stressed = this.covMatrix.clone();
    const p = stressed.rows;
    
    switch (scenario.type) {
      case 'crisis':
        // Amplify correlations
        for (let i = 0; i < p; i++) {
          for (let j = 0; j < p; j++) {
            if (i !== j) {
              const current = stressed.get(i, j);
              const newVal = Math.min(current * (1 + 0.5 * intensity), 0.99);
              stressed.set(i, j, newVal);
              stressed.set(j, i, newVal);
            }
          }
        }
        break;
        
      case 'flight-to-quality':
        // All correlations → 1.0
        for (let i = 0; i < p; i++) {
          for (let j = 0; j < p; j++) {
            if (i !== j) {
              stressed.set(i, j, 0.95 * intensity);
              stressed.set(j, i, 0.95 * intensity);
            }
          }
        }
        break;
        
      case 'regime-shift':
        // Increase off-diagonals
        for (let i = 0; i < p; i++) {
          for (let j = 0; j < p; j++) {
            if (i !== j) {
              const current = stressed.get(i, j);
              stressed.set(i, j, Math.min(current * 1.3, 0.9));
              stressed.set(j, i, Math.min(current * 1.3, 0.9));
            }
          }
        }
        break;
    }
    
    return stressed;
  }

  /**
   * Validate positive definiteness
   */
  isPositiveDefinite(tolerance: number = 1e-8): boolean {
    try {
      const eig = Matrix.eigenvalueDecomposition(this.covMatrix);
      const minEigenval = Math.min(...eig.realEigenvalues);
      return minEigenval > tolerance;
    } catch {
      return false;
    }
  }

  /**
   * Get condition number
   */
  getConditionNumber(): number {
    const eig = this.covMatrix.eigenvalueDecomposition();
    const eigenvals = eig.realEigenvalues;
    const maxEig = Math.max(...eigenvals);
    const minEig = Math.min(...eigenvals);
    return maxEig / minEig;
  }

  /**
   * Get covariance matrix
   */
  getCovariance(): number[][] {
    return this.covMatrix.to2DArray();
  }
}
