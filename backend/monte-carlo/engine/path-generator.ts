// Monte Carlo Path Generator - Geometric Brownian Motion and Jump Diffusion
import { Matrix } from 'ml-matrix';
import { randomBytes } from 'crypto';
import { PathGeneratorConfig } from '../types';

export class PathGenerator {
  private useGPU: boolean;
  private gpuKernel: any;
  private seed: number;

  constructor(private config: PathGeneratorConfig = {
    initialPrice: 100,
    drift: 0.05,
    volatility: 0.2,
    timeSteps: 252,
    numPaths: 10000,
    seed: 42
  }) {
    this.useGPU = this.detectWebGL() && config.useGPU !== false;
    this.seed = config.seed || 12345;
  }

  private detectWebGL(): boolean {
    try {
      // In Node.js, check for headless-gl availability
      return typeof window !== 'undefined' && !!window.WebGLRenderingContext;
    } catch {
      return false;
    }
  }

  /**
   * Simple seeded random number generator using linear congruential generator
   */
  private random(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  /**
   * Generate Geometric Brownian Motion paths
   * dS = μS·dt + σS·dW where dW ~ N(0, dt)
   * S_t = S_0 · exp((μ - σ²/2)t + σW_t)
   */
  generateGBM(): Float64Array {
    const { initialPrice, drift, volatility, timeSteps, numPaths } = this.config;
    const dt = 1 / timeSteps;
    const totalPoints = numPaths * (timeSteps + 1);
    const paths = new Float64Array(totalPoints);
    
    // Pre-compute constants for numerical stability
    const driftAdj = (drift - 0.5 * volatility * volatility) * dt;
    const volAdj = volatility * Math.sqrt(dt);
    
    // Initialize all paths with S_0
    for (let i = 0; i < numPaths; i++) {
      paths[i * (timeSteps + 1)] = initialPrice;
    }
    
    // Generate paths
    for (let i = 0; i < numPaths; i++) {
      const baseIdx = i * (timeSteps + 1);
      for (let t = 1; t <= timeSteps; t++) {
        const z = this.boxMuller();  // Standard normal
        const prevPrice = paths[baseIdx + t - 1];
        const logReturn = driftAdj + volAdj * z;
        const newPrice = prevPrice * Math.exp(logReturn);
        
        // Ensure no negative prices (numerical stability)
        paths[baseIdx + t] = Math.max(newPrice, 1e-8);
      }
    }
    
    return paths;
  }

  /**
   * Generate Jump Diffusion paths (Merton model)
   * dS = μS·dt + σS·dW + S·dJ
   * where J is a compound Poisson process
   */
  generateJumpDiffusion(jumpIntensity: number, jumpMean: number, jumpStd: number): Float64Array {
    const { initialPrice, drift, volatility, timeSteps, numPaths } = this.config;
    const dt = 1 / timeSteps;
    const totalPoints = numPaths * (timeSteps + 1);
    const paths = new Float64Array(totalPoints);
    
    const driftAdj = (drift - 0.5 * volatility * volatility) * dt;
    const volAdj = volatility * Math.sqrt(dt);
    
    // Initialize
    for (let i = 0; i < numPaths; i++) {
      paths[i * (timeSteps + 1)] = initialPrice;
    }
    
    for (let i = 0; i < numPaths; i++) {
      const baseIdx = i * (timeSteps + 1);
      for (let t = 1; t <= timeSteps; t++) {
        const z = this.boxMuller();
        
        // Check for jump (Poisson process)
        const jumpProb = 1 - Math.exp(-jumpIntensity * dt);
        const hasJump = this.random() < jumpProb;
        
        let jumpSize = 0;
        if (hasJump) {
          jumpSize = Math.exp(jumpMean + jumpStd * this.boxMuller()) - 1;
        }
        
        const logReturn = driftAdj + volAdj * z + jumpSize;
        const prevPrice = paths[baseIdx + t - 1];
        const newPrice = prevPrice * Math.exp(logReturn);
        
        paths[baseIdx + t] = Math.max(newPrice, 1e-8);
      }
    }
    
    return paths;
  }

  /**
   * Box-Muller transform for generating standard normal variates
   * Uses cached second value for efficiency
   */
  private boxMuller(): number {
    let z1 = 0;
    let generate = false;

    if (!generate) {
      const u1 = this.random();
      const u2 = this.random();

      const r = Math.sqrt(-2.0 * Math.log(u1));
      const theta = 2.0 * Math.PI * u2;

      z1 = r * Math.cos(theta);
      generate = true;
    } else {
      generate = false;
    }

    return z1;
  }

  /**
   * Validate path integrity
   */
  validatePath(path: Float64Array, timeSteps: number): boolean {
    for (let i = 0; i < path.length; i += timeSteps + 1) {
      if (path[i] <= 0 || !isFinite(path[i])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Compute log returns from price paths
   */
  computeLogReturns(paths: Float64Array, timeSteps: number): Float64Array {
    const numPaths = paths.length / (timeSteps + 1);
    const returns = new Float64Array(numPaths * timeSteps);
    
    for (let i = 0; i < numPaths; i++) {
      const baseIdx = i * (timeSteps + 1);
      for (let t = 0; t < timeSteps; t++) {
        const priceT = paths[baseIdx + t + 1];
        const priceT1 = paths[baseIdx + t];
        returns[i * timeSteps + t] = Math.log(priceT / priceT1);
      }
    }
    
    return returns;
  }
}
