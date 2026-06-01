import { useState, useEffect, useCallback } from "react";

interface MLModel {
  symbol: string;
  regime: string;
  accuracy: number;
  drift_score: number;
  training_rows: number;
  trained_at: string;
  last_drift_check: string | null;
  is_active: number;
}

interface MLStatus {
  ml_enabled: boolean;
  models: MLModel[];
  confidence_threshold: string;
}

interface AccuracyRow {
  regime: string;
  total: number;
  correct: number;
  accuracy_pct: number;
  avg_confidence: number;
  avg_gemma_adj: number;
}

interface Prediction {
  id: number;
  symbol: string;
  regime: string;
  candle_time: string;
  xgb_probability: number;
  gemma_adjustment: number;
  final_score: number;
  predicted_direction: string;
  actual_direction: string | null;
  was_correct: number | null;
  top_features: string;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';
const AUTH_TOKEN = () => localStorage.getItem('api_token') ?? '';

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN()}` }
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

function StatusBadge({ value, good, warn }: {
  value: number; good: number; warn: number
}) {
  const color =
    value >= good ? 'text-green-400' :
    value >= warn ? 'text-yellow-400' :
    'text-red-400';
  return <span className={`font-mono font-semibold ${color}`}>{value.toFixed(1)}%</span>;
}

function DriftBadge({ score }: { score: number }) {
  const label = score < 0.15 ? 'Stable' :
                score < 0.30 ? 'Warning' : 'Retrain';
  const color = score < 0.15 ? 'bg-green-900 text-green-300' :
                score < 0.30 ? 'bg-yellow-900 text-yellow-300' :
                               'bg-red-900 text-red-300';
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>
      {label}
    </span>
  );
}

function RegimeChip({ regime }: { regime: string }) {
  const colors: Record<string, string> = {
    strongbull: 'bg-emerald-900 text-emerald-300',
    weakbull:   'bg-teal-900 text-teal-300',
    sideways:    'bg-slate-700 text-slate-300',
    bear:        'bg-red-900 text-red-300',
  };
  const label = regime.replace('_', ' ');
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[regime] ?? 'bg-gray-700 text-gray-300'}`}>
      {label}
    </span>
  );
}

function ModelInventory({ models, threshold }: {
  models: MLModel[]; threshold: string
}) {
  if (models.length === 0) {
    return (
      <div className="text-gray-500 text-sm py-4 text-center">
        No trained models found.{' '}
        <code className="text-xs bg-gray-800 px-1 rounded">
          npx ts-node scripts/train_models.ts
        </code>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700 text-gray-400 text-left">
            <th className="pb-2 pr-4">Symbol</th>
            <th className="pb-2 pr-4">Regime</th>
            <th className="pb-2 pr-4">Accuracy</th>
            <th className="pb-2 pr-4">Drift</th>
            <th className="pb-2 pr-4">Rows</th>
            <th className="pb-2">Trained</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {models.map((m, i) => (
            <tr key={i} className="hover:bg-gray-800/40 transition-colors">
              <td className="py-2 pr-4 font-mono text-gray-200">{m.symbol}</td>
              <td className="py-2 pr-4"><RegimeChip regime={m.regime} /></td>
              <td className="py-2 pr-4">
                <StatusBadge value={m.accuracy * 100} good={57} warn={53} />
              </td>
              <td className="py-2 pr-4">
                <DriftBadge score={m.drift_score} />
              </td>
              <td className="py-2 pr-4 text-gray-400 font-mono">
                {m.training_rows.toLocaleString()}
              </td>
              <td className="py-2 text-gray-500 text-xs">
                {new Date(m.trained_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-600 mt-2">
        Confidence threshold: <span className="text-gray-400">{threshold}</span>
      </p>
    </div>
  );
}

function AccuracyTable({ rows }: { rows: AccuracyRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-gray-500 text-sm py-4 text-center">
        No resolved predictions yet. Check back after shadow trades complete.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700 text-gray-400 text-left">
            <th className="pb-2 pr-4">Regime</th>
            <th className="pb-2 pr-4">Predictions</th>
            <th className="pb-2 pr-4">Accuracy</th>
            <th className="pb-2 pr-4">Avg Confidence</th>
            <th className="pb-2">Avg Gemma Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-gray-800/40 transition-colors">
              <td className="py-2 pr-4"><RegimeChip regime={r.regime} /></td>
              <td className="py-2 pr-4 font-mono text-gray-300">
                {r.total.toLocaleString()}
              </td>
              <td className="py-2 pr-4">
                <StatusBadge value={r.accuracy_pct} good={57} warn={53} />
              </td>
              <td className="py-2 pr-4 font-mono text-gray-400">
                {(r.avg_confidence * 100).toFixed(1)}%
              </td>
              <td className="py-2 font-mono">
                <span className={r.avg_gemma_adj >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {r.avg_gemma_adj >= 0 ? '+' : ''}{(r.avg_gemma_adj * 100).toFixed(1)}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PredictionFeed({ predictions }: { predictions: Prediction[] }) {
  return (
    <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
      {predictions.length === 0 && (
        <p className="text-gray-500 text-sm text-center py-4">No predictions logged yet.</p>
      )}
      {predictions.map(p => {
        const correct = p.was_correct === 1;
        const resolved = p.actual_direction !== null;
        let topFeats: [string, number][] = [];
        try { topFeats = JSON.parse(p.top_features ?? '[]'); } catch { /* */ }

        return (
          <div
            key={p.id}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs
                        ${resolved
                          ? correct
                            ? 'bg-green-950/40 border border-green-900/30'
                            : 'bg-red-950/40 border border-red-900/30'
                          : 'bg-gray-800/40 border border-gray-700/30'}`}
          >
            <span className="w-4 text-center flex-shrink-0">
              {resolved ? (correct ? '✓' : '✗') : '⋯'}
            </span>
            <RegimeChip regime={p.regime} />
            <span className="font-mono text-gray-300 flex-shrink-0">
              XGB: {(p.xgb_probability * 100).toFixed(0)}%
            </span>
            <span className={`font-mono flex-shrink-0
                              ${p.gemma_adjustment >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              G: {p.gemma_adjustment >= 0 ? '+' : ''}{(p.gemma_adjustment * 100).toFixed(0)}%
            </span>
            <span className="font-mono text-white font-semibold flex-shrink-0">
              → {(p.final_score * 100).toFixed(0)}%
            </span>
            {topFeats[0] && (
              <span className="text-gray-500 truncate hidden lg:block">
                {topFeats[0][0].replace(/_/g, ' ')}
              </span>
            )}
            <span className="text-gray-600 ml-auto flex-shrink-0">
              {new Date(p.candle_time).toLocaleTimeString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface MLDashboardProps {
  symbol?: string;
}

export default function MLDashboard({ symbol = 'BTC/USDT' }: MLDashboardProps) {
  const [status, setStatus] = useState<MLStatus | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyRow[]>([]);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'models' | 'accuracy' | 'feed'>('models');

  const refresh = useCallback(async () => {
    try {
      const [s, a, p] = await Promise.all([
        apiFetch<MLStatus>('/api/ml/status'),
        apiFetch<AccuracyRow[]>(`/api/ml/accuracy?symbol=${encodeURIComponent(symbol)}&days=7`),
        apiFetch<Prediction[]>(`/api/ml/predictions?symbol=${encodeURIComponent(symbol)}&limit=50`)
      ]);
      setStatus(s);
      setAccuracy(a);
      setPredictions(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ML data');
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const totalPredictions = accuracy.reduce((s, r) => s + r.total, 0);
  const weightedAccuracy = accuracy.length > 0
    ? accuracy.reduce((s, r) => s + r.accuracy_pct * r.total, 0) / Math.max(totalPredictions, 1)
    : 0;

  const recentCorrect = predictions.filter(p => p.was_correct === 1).length;
  const recentTotal = predictions.filter(p => p.actual_direction !== null).length;
  const recentAcc = recentTotal > 0 ? (recentCorrect / recentTotal) * 100 : 0;

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 animate-pulse">
        <div className="h-4 bg-gray-700 rounded w-32 mb-4" />
        <div className="space-y-2">
          {[1,2,3].map(i => <div key={i} className="h-3 bg-gray-800 rounded" />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-900 border border-red-900 rounded-xl p-5">
        <p className="text-red-400 text-sm">{error}</p>
        <button
          onClick={refresh}
          className="mt-2 text-xs text-gray-400 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const mlEnabled = status?.ml_enabled ?? false;

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <span className="text-white font-semibold text-sm">ML Meta-Labeling</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                            ${mlEnabled
                              ? 'bg-emerald-900 text-emerald-300'
                              : 'bg-gray-700 text-gray-400'}`}>
            {mlEnabled ? 'Active' : 'Disabled'}
          </span>
        </div>
        {totalPredictions > 0 && (
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span>
              7d avg:{' '}
              <StatusBadge value={weightedAccuracy} good={57} warn={53} />
            </span>
            <span>
              recent:{' '}
              <StatusBadge value={recentAcc} good={57} warn={53} />
            </span>
            <span className="text-gray-600">
              {totalPredictions.toLocaleString()} predictions
            </span>
          </div>
        )}
      </div>

      <div className="flex border-b border-gray-800 text-xs">
        {(['models', 'accuracy', 'feed'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 capitalize transition-colors
                        ${tab === t
                          ? 'text-white border-b-2 border-blue-500 bg-gray-800/40'
                          : 'text-gray-500 hover:text-gray-300'}`}
          >
            {t === 'feed' ? 'Predictions' : t}
          </button>
        ))}
        <div className="ml-auto px-4 py-2.5">
          <button
            onClick={refresh}
            className="text-gray-600 hover:text-gray-400 transition-colors text-xs"
            title="Refresh"
          >
            ↺ refresh
          </button>
        </div>
      </div>

      <div className="px-5 py-4">
        {tab === 'models' && (
          <ModelInventory
            models={status?.models ?? []}
            threshold={status?.confidence_threshold ?? '0.58'}
          />
        )}
        {tab === 'accuracy' && <AccuracyTable rows={accuracy} />}
        {tab === 'feed' && <PredictionFeed predictions={predictions} />}
      </div>

      {!mlEnabled && (
        <div className="px-5 pb-4 pt-0 text-xs text-gray-600">
          Set <code className="bg-gray-800 px-1 rounded">ML_ENABLED=true</code> in{' '}
          <code className="bg-gray-800 px-1 rounded">.env</code> after training models.
        </div>
      )}
    </div>
  );
}