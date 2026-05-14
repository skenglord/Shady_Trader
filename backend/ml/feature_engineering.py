"""
Input (stdin):  JSON array of candle+indicator rows from indicators/engine.ts
Output (stdout): JSON with features matrix and target labels
"""

import json
import sys
import numpy as np
import pandas as pd


INDICATOR_COLS = [
    'rsi', 'macd', 'macdSignal', 'macdHistogram',
    'ema9', 'ema21', 'ema50',
    'bbUpper', 'bbMiddle', 'bbLower',
    'adx', 'atr', 'stochRsi', 'vwap', 'volume'
]

FEATURE_COLS = [
    'ret_1', 'ret_3', 'ret_6', 'ret_12', 'ret_24',
    'body_ratio', 'upper_wick', 'lower_wick', 'candle_range_norm',
    'rsi_z', 'macd_z', 'adx_z', 'atr_z', 'stochrsi_z',
    'ema9_ema21_ratio', 'price_ema9_ratio', 'price_vwap_ratio',
    'bb_position', 'bb_width_norm',
    'vol_ratio', 'vol_delta',
]


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    eps = 1e-9

    for n in [1, 3, 6, 12, 24]:
        out[f'ret_{n}'] = df['close'].pct_change(n)

    candle_range = (df['high'] - df['low']).clip(lower=eps)
    body = df['close'] - df['open']
    out['body_ratio'] = body / candle_range
    out['upper_wick'] = (df['high'] - df[['open', 'close']].max(axis=1)) / candle_range
    out['lower_wick'] = (df[['open', 'close']].min(axis=1) - df['low']) / candle_range
    out['candle_range_norm'] = candle_range / df['close']

    for src, dst in [('rsi', 'rsi_z'), ('macd', 'macd_z'),
                      ('adx', 'adx_z'), ('atr', 'atr_z'), ('stochRsi', 'stochrsi_z')]:
        if src in df.columns:
            roll_mean = df[src].rolling(20, min_periods=5).mean()
            roll_std = df[src].rolling(20, min_periods=5).std().clip(lower=eps)
            out[dst] = (df[src] - roll_mean) / roll_std
        else:
            out[dst] = 0.0

    if 'ema9' in df.columns and 'ema21' in df.columns:
        out['ema9_ema21_ratio'] = df['ema9'] / df['ema21'].clip(lower=eps) - 1
        out['price_ema9_ratio'] = df['close'] / df['ema9'].clip(lower=eps) - 1
    else:
        out['ema9_ema21_ratio'] = 0.0
        out['price_ema9_ratio'] = 0.0

    if 'vwap' in df.columns:
        out['price_vwap_ratio'] = df['close'] / df['vwap'].clip(lower=eps) - 1
    else:
        out['price_vwap_ratio'] = 0.0

    if all(c in df.columns for c in ['bbUpper', 'bbLower', 'bbMiddle']):
        bb_width = (df['bbUpper'] - df['bbLower']).clip(lower=eps)
        out['bb_position'] = (df['close'] - df['bbLower']) / bb_width
        out['bb_width_norm'] = bb_width / df['bbMiddle'].clip(lower=eps)
    else:
        out['bb_position'] = 0.5
        out['bb_width_norm'] = 0.0

    vol_ma = df['volume'].rolling(20, min_periods=5).mean().clip(lower=eps)
    out['vol_ratio'] = df['volume'] / vol_ma
    out['vol_delta'] = df['volume'].pct_change(1)

    out['target_return'] = df['close'].pct_change(1).shift(-1)
    out['target_direction'] = (out['target_return'] > 0).astype(int)

    out = out.ffill().dropna()
    return out


def main():
    raw = json.load(sys.stdin)
    df = pd.DataFrame(raw)

    for col in ['open', 'high', 'low', 'close', 'volume'] + INDICATOR_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')

    df = df.sort_values('time').reset_index(drop=True)
    features = build_features(df)

    missing = [c for c in FEATURE_COLS if c not in features.columns]
    if missing:
        print(json.dumps({'error': f'Missing features: {missing}'}), file=sys.stderr)
        sys.exit(1)

    result = {
        'features': features[FEATURE_COLS].values.tolist(),
        'targets': features['target_direction'].values.tolist(),
        'returns': features['target_return'].values.tolist(),
        'n_rows': len(features),
        'feature_cols': FEATURE_COLS
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()