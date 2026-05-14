import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../logging/logger.js';

export interface PredictRequest {
  features: number[];
  symbol: string;
  regime: string;
  model_path: string;
}

export interface PredictResponse {
  probability: number;
  direction: 'buy' | 'sell';
  top_features: [string, number][];
  error?: string;
}

export interface FeatureRequest {
  candles: Record<string, number>[];
}

export interface FeatureResponse {
  features: number[][];
  feature_cols: string[];
  n_rows: number;
  error?: string;
}

export async function extractFeatures(
  candles: Record<string, number>[],
  timeoutMs = 5000
): Promise<FeatureResponse> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'feature_engineering.py');
    const pythonBin = process.env.ML_PYTHON_BIN ?? 'python3';

    const proc = spawn(pythonBin, [scriptPath]);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Feature extraction timed out'));
    }, timeoutMs);

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.stdin.write(JSON.stringify(candles));
    proc.stdin.end();

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Feature extraction failed (${code}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Invalid JSON from feature extractor: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

const INFERENCE_SCRIPT = `
import sys, json, joblib, numpy as np

models = {}

def predict(req):
    mp = req['model_path']
    if mp not in models:
        obj = joblib.load(mp)
        models[mp] = obj
    obj = models[mp]
    model = obj['model']
    explainer = obj['explainer']
    feat_cols = obj['feature_cols']

    X = np.array([req['features']])
    prob = float(model.predict_proba(X)[0][1])

    inner = model.calibrated_classifiers_[0].estimator
    shap_vals = explainer.shap_values(X)[0]
    importance = list(zip(feat_cols, [abs(float(v)) for v in shap_vals]))
    top3 = sorted(importance, key=lambda x: x[1], reverse=True)[:3]

    return {
        'probability': prob,
        'direction': 'buy' if prob > 0.5 else 'sell',
        'top_features': [[k, v] for k, v in top3]
    }

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        result = predict(req)
        print(json.dumps(result), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'probability': 0.5,
                          'direction': 'buy', 'top_features': []}), flush=True)
`;

let inferenceProc: ChildProcess | null = null;
let pendingCallbacks: Map<number, {
  resolve: (v: PredictResponse) => void;
  reject: (e: Error) => void;
}> = new Map();
let requestCounter = 0;
let lineBuffer = '';

function getInferenceProcess(): ChildProcess {
  if (inferenceProc && !inferenceProc.killed) return inferenceProc;

  const pythonBin = process.env.ML_PYTHON_BIN ?? 'python3';
  inferenceProc = spawn(pythonBin, ['-c', INFERENCE_SCRIPT]);
  lineBuffer = '';

  inferenceProc.stdout?.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const id = Math.min(...Array.from(pendingCallbacks.keys()));
      const cb = pendingCallbacks.get(id);
      pendingCallbacks.delete(id);

      try {
        cb?.resolve(JSON.parse(line) as PredictResponse);
      } catch (e) {
        cb?.reject(new Error(`Malformed inference response: ${line.slice(0, 100)}`));
      }
    }
  });

  inferenceProc.on('error', err => {
    logger.error('[python_bridge] Inference process error:', err);
    inferenceProc = null;
  });

  inferenceProc.on('exit', () => {
    logger.warn('[python_bridge] Inference process exited — will restart on next call');
    inferenceProc = null;
  });

  return inferenceProc;
}

export async function predict(
  req: PredictRequest,
  timeoutMs = 3000
): Promise<PredictResponse> {
  return new Promise((resolve, reject) => {
    const id = ++requestCounter;
    const proc = getInferenceProcess();

    const timer = setTimeout(() => {
      pendingCallbacks.delete(id);
      reject(new Error(`ML inference timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCallbacks.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject: e => { clearTimeout(timer); reject(e); }
    });

    const payload = JSON.stringify(req) + '\n';
    proc.stdin?.write(payload);
  });
}