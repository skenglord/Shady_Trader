"""
Usage:
  python3 backend/ml/model_trainer.py \
    --symbol BTC/USDT \
    --regime strong_bull \
    --output-dir ./models

Reads candles from stdin as JSON (same format as feature_engineering.py).
Outputs JSON training report to stdout.
"""

import argparse
import json
import os
import sys
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import joblib
import shap
from xgboost import XGBClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import accuracy_score, precision_score, recall_score

from feature_engineering import build_features, FEATURE_COLS


def walk_forward_accuracy(X: np.ndarray, y: np.ndarray,
                           n_splits: int = 5) -> dict:
    tscv = TimeSeriesSplit(n_splits=n_splits, gap=20)
    scores = []

    for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
        X_tr, X_te = X[train_idx], X[test_idx]
        y_tr, y_te = y[train_idx], y[test_idx]

        model = XGBClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=10,
            use_label_encoder=False,
            eval_metric='logloss',
            verbosity=0
        )
        model.fit(X_tr, y_tr,
                  eval_set=[(X_te, y_te)],
                  verbose=False)

        preds = model.predict(X_te)
        acc = accuracy_score(y_te, preds)
        scores.append(acc)

    return {
        'mean_accuracy': float(np.mean(scores)),
        'std_accuracy': float(np.std(scores)),
        'fold_scores': [float(s) for s in scores]
    }


def train_and_save(features_df: pd.DataFrame, symbol: str,
                   regime: str, output_dir: str) -> dict:
    X = features_df[FEATURE_COLS].values
    y = features_df['target_direction'].values

    if len(X) < 500:
        return {'error': f'Insufficient data: {len(X)} rows (need 500+)'}

    wf = walk_forward_accuracy(X, y)

    tscv = TimeSeriesSplit(n_splits=5, gap=20)

    base_model = XGBClassifier(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.03,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=10,
        use_label_encoder=False,
        eval_metric='logloss',
        verbosity=0
    )

    calibrated = CalibratedClassifierCV(
        base_model,
        cv=tscv,
        method='isotonic'
    )
    calibrated.fit(X, y)

    inner_model = calibrated.calibrated_classifiers_[0].estimator
    explainer = shap.TreeExplainer(inner_model)

    split = int(len(X) * 0.8)
    X_ho, y_ho = X[split:], y[split:]
    probs_ho = calibrated.predict_proba(X_ho)[:, 1]
    preds_ho = (probs_ho > 0.5).astype(int)

    acc_ho = float(accuracy_score(y_ho, preds_ho))
    prec_ho = float(precision_score(y_ho, preds_ho, zero_division=0))
    rec_ho = float(recall_score(y_ho, preds_ho, zero_division=0))

    os.makedirs(output_dir, exist_ok=True)
    safe_sym = symbol.replace('/', '_')
    model_path = os.path.join(output_dir, f'{safe_sym}_{regime}.joblib')

    joblib.dump({
        'model': calibrated,
        'explainer': explainer,
        'feature_cols': FEATURE_COLS,
        'symbol': symbol,
        'regime': regime,
        'trained_rows': len(X)
    }, model_path)

    return {
        'model_path': model_path,
        'symbol': symbol,
        'regime': regime,
        'training_rows': len(X),
        'holdout_accuracy': acc_ho,
        'holdout_precision': prec_ho,
        'holdout_recall': rec_ho,
        'walk_forward': wf,
        'feature_count': len(FEATURE_COLS)
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', required=True)
    parser.add_argument('--regime', required=True,
                        choices=['strong_bull', 'weak_bull', 'sideways', 'bear'])
    parser.add_argument('--output-dir', default='./models')
    args = parser.parse_args()

    raw_candles = json.load(sys.stdin)
    df_raw = pd.DataFrame(raw_candles)

    for col in ['open', 'high', 'low', 'close', 'volume']:
        df_raw[col] = pd.to_numeric(df_raw[col], errors='coerce')

    df_raw = df_raw.sort_values('time').reset_index(drop=True)

    features_df = build_features(df_raw)
    report = train_and_save(features_df, args.symbol, args.regime, args.output_dir)

    print(json.dumps(report))


if __name__ == '__main__':
    main()