import { OptimizationResult } from './rolling-optimizer';
import { OverfittingDiagnostic } from './overfitting-detector';

export interface EquityCurveData {
  timestamps: number[];
  inSampleEquity: number[];
  outOfSampleEquity: number[];
  benchmarkEquity: number[];
}

export interface DiagnosticChartData {
  labels: string[];
  overfittingScore: number[];
  stabilityScore: number[];
  divergenceRatio: number[];
  correlationDecay: number[];
}

export interface PerformanceHeatmapData {
  foldIndices: number[];
  parameterNames: string[];
  performanceMatrix: number[][];
}

export class ValidationVisualizer {
  /**
   * Generate equity curve data for visualization
   */
  generateEquityCurveData(
    results: OptimizationResult[],
    includeBenchmark: boolean = true
  ): EquityCurveData {
    const timestamps: number[] = [];
    const inSampleEquity: number[] = [];
    const outOfSampleEquity: number[] = [];
    const benchmarkEquity: number[] = [];

    let isEquity = 1.0;
    let oosEquity = 1.0;
    let benchmarkEq = 1.0;

    // Generate synthetic timestamps (one per result)
    const baseTime = Date.now();
    for (let i = 0; i < results.length; i++) {
      timestamps.push(baseTime + i * 86400000); // Daily intervals

      // Simulate equity growth based on Sharpe ratios
      // This is a simplified approximation for visualization
      const isReturn = results[i].inSampleSharpe * 0.01; // Daily return approximation
      const oosReturn = results[i].outOfSampleSharpe * 0.01;
      const benchmarkReturn = 0.0005; // ~12% annual return

      isEquity *= (1 + isReturn);
      oosEquity *= (1 + oosReturn);
      benchmarkEq *= (1 + benchmarkReturn);

      inSampleEquity.push(isEquity);
      outOfSampleEquity.push(oosEquity);
      if (includeBenchmark) {
        benchmarkEquity.push(benchmarkEq);
      }
    }

    return {
      timestamps,
      inSampleEquity,
      outOfSampleEquity,
      benchmarkEquity: includeBenchmark ? benchmarkEquity : [],
    };
  }

  /**
   * Generate diagnostic chart data showing overfitting metrics over time
   */
  generateDiagnosticChartData(
    diagnostics: OverfittingDiagnostic[]
  ): DiagnosticChartData {
    const labels: string[] = [];
    const overfittingScore: number[] = [];
    const stabilityScore: number[] = [];
    const divergenceRatio: number[] = [];
    const correlationDecay: number[] = [];

    diagnostics.forEach((diag, index) => {
      labels.push(`Fold ${index + 1}`);
      overfittingScore.push(diag.metrics.overallOverfittingScore);
      stabilityScore.push(diag.stability.overallStability);
      divergenceRatio.push(diag.metrics.divergenceRatio);
      correlationDecay.push(diag.metrics.correlationDecay);
    });

    return {
      labels,
      overfittingScore,
      stabilityScore,
      divergenceRatio,
      correlationDecay,
    };
  }

  /**
   * Generate performance heatmap data for parameter sensitivity analysis
   */
  generatePerformanceHeatmapData(
    results: OptimizationResult[]
  ): PerformanceHeatmapData {
    const foldIndices = results.map((_, i) => i);
    const parameterNames = [
      'confidenceThreshold',
      'stopLoss',
      'takeProfit',
      'positionSize',
    ];

    const performanceMatrix: number[][] = [];

    parameterNames.forEach((paramName, paramIndex) => {
      const paramValues: number[] = [];

      results.forEach(result => {
        let value: number;
        switch (paramName) {
          case 'confidenceThreshold':
            value = result.parameters.confidenceThreshold;
            break;
          case 'stopLoss':
            value = result.parameters.stopLoss;
            break;
          case 'takeProfit':
            value = result.parameters.takeProfit;
            break;
          case 'positionSize':
            value = result.parameters.positionSize;
            break;
          default:
            value = 0;
        }
        paramValues.push(value);
      });

      performanceMatrix.push(paramValues);
    });

    return {
      foldIndices,
      parameterNames,
      performanceMatrix,
    };
  }

  /**
   * Generate confidence bands for equity curves
   */
  generateConfidenceBands(
    equityCurve: number[],
    confidenceLevel: number = 0.95
  ): { upper: number[]; lower: number[] } {
    const n = equityCurve.length;
    if (n < 2) {
      return { upper: equityCurve, lower: equityCurve };
    }

    // Calculate rolling volatility (simplified)
    const returns = [];
    for (let i = 1; i < n; i++) {
      returns.push((equityCurve[i] - equityCurve[i-1]) / equityCurve[i-1]);
    }

    const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // Calculate confidence interval
    const zScore = confidenceLevel === 0.95 ? 1.96 : 1.645; // 90% or 95%
    const margin = zScore * stdDev / Math.sqrt(n);

    const upper: number[] = [];
    const lower: number[] = [];

    for (let i = 0; i < n; i++) {
      const growthFactor = Math.pow(1 + margin, i + 1);
      const decayFactor = Math.pow(1 - margin, i + 1);

      upper.push(equityCurve[i] * growthFactor);
      lower.push(equityCurve[i] * decayFactor);
    }

    return { upper, lower };
  }

  /**
   * Generate summary statistics for visualization
   */
  generateSummaryStatistics(results: OptimizationResult[]): {
    meanSharpe: number;
    stdSharpe: number;
    maxDrawdown: number;
    winRate: number;
    totalTrades: number;
    sharpeDistribution: number[];
  } {
    const isSharpes = results.map(r => r.inSampleSharpe);
    const oosSharpes = results.map(r => r.outOfSampleSharpe);
    const combinedSharpes = [...isSharpes, ...oosSharpes];

    const meanSharpe = combinedSharpes.reduce((sum, s) => sum + s, 0) / combinedSharpes.length;
    const stdSharpe = Math.sqrt(
      combinedSharpes.reduce((sum, s) => sum + Math.pow(s - meanSharpe, 2), 0) / combinedSharpes.length
    );

    const maxDrawdown = Math.max(...results.map(r => Math.max(r.inSampleMaxDrawdown, r.outOfSampleMaxDrawdown)));
    const avgWinRate = results.reduce((sum, r) => sum + r.winRate, 0) / results.length;
    const totalTrades = results.reduce((sum, r) => sum + r.tradeCount, 0);

    // Create histogram bins for Sharpe distribution
    const minSharpe = Math.min(...combinedSharpes);
    const maxSharpe = Math.max(...combinedSharpes);
    const bins = 10;
    const binWidth = (maxSharpe - minSharpe) / bins;
    const sharpeDistribution: number[] = new Array(bins).fill(0);

    combinedSharpes.forEach(sharpe => {
      const binIndex = Math.min(bins - 1, Math.floor((sharpe - minSharpe) / binWidth));
      sharpeDistribution[binIndex]++;
    });

    return {
      meanSharpe,
      stdSharpe,
      maxDrawdown,
      winRate: avgWinRate,
      totalTrades,
      sharpeDistribution,
    };
  }

  /**
   * Export data in Chart.js compatible format
   */
  exportToChartJS(
    equityData: EquityCurveData,
    diagnosticData: DiagnosticChartData
  ): {
    equityChart: any;
    diagnosticChart: any;
  } {
    const equityChart = {
      type: 'line',
      data: {
        labels: equityData.timestamps.map(t => new Date(t).toLocaleDateString()),
        datasets: [
          {
            label: 'In-Sample Equity',
            data: equityData.inSampleEquity,
            borderColor: 'rgba(75, 192, 192, 1)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            fill: false,
          },
          {
            label: 'Out-of-Sample Equity',
            data: equityData.outOfSampleEquity,
            borderColor: 'rgba(255, 99, 132, 1)',
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
            fill: false,
          },
          {
            label: 'Benchmark',
            data: equityData.benchmarkEquity,
            borderColor: 'rgba(128, 128, 128, 1)',
            backgroundColor: 'rgba(128, 128, 128, 0.2)',
            fill: false,
            borderDash: [5, 5],
          },
        ],
      },
      options: {
        responsive: true,
        title: {
          display: true,
          text: 'Walk-Forward Analysis Equity Curves',
        },
        scales: {
          xAxes: [{
            display: true,
            scaleLabel: {
              display: true,
              labelString: 'Time',
            },
          }],
          yAxes: [{
            display: true,
            scaleLabel: {
              display: true,
              labelString: 'Equity',
            },
          }],
        },
      },
    };

    const diagnosticChart = {
      type: 'line',
      data: {
        labels: diagnosticData.labels,
        datasets: [
          {
            label: 'Overfitting Score',
            data: diagnosticData.overfittingScore,
            borderColor: 'rgba(255, 99, 132, 1)',
            fill: false,
          },
          {
            label: 'Stability Score',
            data: diagnosticData.stabilityScore,
            borderColor: 'rgba(75, 192, 192, 1)',
            fill: false,
          },
          {
            label: 'Divergence Ratio',
            data: diagnosticData.divergenceRatio,
            borderColor: 'rgba(255, 205, 86, 1)',
            fill: false,
            yAxisID: 'divergence',
          },
        ],
      },
      options: {
        responsive: true,
        title: {
          display: true,
          text: 'Overfitting Diagnostics Over Time',
        },
        scales: {
          yAxes: [
            {
              id: 'main',
              type: 'linear',
              position: 'left',
              scaleLabel: {
                display: true,
                labelString: 'Score',
              },
            },
            {
              id: 'divergence',
              type: 'linear',
              position: 'right',
              scaleLabel: {
                display: true,
                labelString: 'Divergence Ratio',
              },
            },
          ],
        },
      },
    };

    return { equityChart, diagnosticChart };
  }
}