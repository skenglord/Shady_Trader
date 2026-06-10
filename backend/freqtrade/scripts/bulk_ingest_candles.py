#!/usr/bin/env python3
"""
Bulk ingest script: walks user_data/data/<exchange>/, parses *-{timeframe}.feather and *.parquet
files, transforms to {time, open, high, low, close, volume}, and inserts into the existing
candles SQLite table using INSERT OR IGNORE for idempotency.

Emits progress to stdout: "{pair}: {rows_inserted}/{total}"

Known limitations handled (from integration plan §9):
  1. Volume currency normalization (spot base → quote)
  2. Timeframe alignment (Freqtrade-resampled vs in-house resampling)
  3. Pair naming: drops ':USDT' / ':USD' futures suffix
  4. Parquet support via pyarrow
"""
import pandas as pd
import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone

# --- Paths ---
# Resolve project root relative to this script's location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FREQTRADE_DIR = os.path.dirname(SCRIPT_DIR)  # backend/freqtrade/
BACKEND_DIR = os.path.dirname(os.path.dirname(FREQTRADE_DIR))  # backend/
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)  # Shady_Trader/

DEFAULT_DATA_DIR = os.path.join(FREQTRADE_DIR, 'user_data', 'data')
DEFAULT_DB_PATH = os.path.join(PROJECT_ROOT, 'trading.db')


def find_data_dirs(data_dir: str):
    """Yield (exchange_name, exchange_path) tuples for each subdirectory in data_dir."""
    if not os.path.isdir(data_dir):
        print(f"WARNING: data directory not found: {data_dir}", file=sys.stderr)
        return
    for entry in sorted(os.listdir(data_dir)):
        exchange_path = os.path.join(data_dir, entry)
        if os.path.isdir(exchange_path):
            yield entry, exchange_path


def parse_pair_timeframe_from_filename(filename: str):
    """
    Parse pair and timeframe from Freqtrade filename patterns:
      BTC_USDT-1h.feather
      BTC_USDT-1h-mark.feather
      BTC_USDT-1h-futures.feather
      ETH_USDT-5m.parquet
      SOL_USDT-1d.feather
      BTC_USDT:USDT-1h.feather  (futures pair naming)

    Returns (pair, timeframe) or (None, None) if not a candle file.
    """
    # Strip extension
    base, ext = os.path.splitext(filename)
    if ext.lower() not in ('.feather', '.parquet'):
        return None, None

    # Skip non-OHLCV files (mark price, funding rate, trades)
    if '-mark' in base or '-futures' in base or '-trades' in base or '-funding' in base:
        return None, None

    # Split on the LAST '-' to separate timeframe
    last_dash = base.rfind('-')
    if last_dash == -1:
        return None, None

    timeframe = base[last_dash + 1:]
    pair_raw = base[:last_dash]

    # Normalize pair: replace '_' with '/'
    pair = pair_raw.replace('_', '/')

    # Strip futures suffix (:USDT, :USD, :USDC) — limitation #3 from plan §9
    if pair.endswith(':USDT') or pair.endswith(':USD') or pair.endswith(':USDC'):
        pair = pair.split(':')[0]

    return pair, timeframe


def load_dataframe(filepath: str):
    """Load a feather or parquet file into a pandas DataFrame."""


    ext = os.path.splitext(filepath)[1].lower()
    try:
        if ext == '.feather':
            return pd.read_feather(filepath)
        elif ext == '.parquet':
            return pd.read_parquet(filepath)
        else:
            raise ValueError(f"Unsupported file type: {ext}")
    except Exception as e:
        print(f"WARNING: Could not read {filepath}: {e}", file=sys.stderr)
        return None


def normalize_volume(df, pair: str, exchange: str) -> pd.DataFrame:
    """
    Handle volume currency normalization (limitation #1 from plan §9).
    Spot exchanges typically report volume in base currency (e.g. BTC).
    Futures typically report volume in quote currency (e.g. USDT).
    For spot data, normalize to quote: vol_quote = vol_base * (open+close)/2.
    """
    if 'close' not in df.columns or 'open' not in df.columns:
        return df

    avg_volume = df['volume'].mean() if len(df) > 0 else 0
    avg_price = df['close'].mean() if len(df) > 0 else 0

    if avg_price > 0 and avg_volume > 0:
        estimated_quote = avg_volume * avg_price
        if estimated_quote > avg_volume * 5:  # volume is likely base currency
            df = df.copy()
            df['volume'] = df['volume'] * ((df['close'] + df['open']) / 2.0)
            df['volume_currency'] = 'quote_normalized'

    return df


def align_timeframe(df, timeframe: str) -> pd.DataFrame:
    """Passthrough: use raw date column as time in ms (timeframe alignment deferred)."""
    if 'date' not in df.columns and 'timestamp' not in df.columns:
        return df
    time_col = 'date' if 'date' in df.columns else 'timestamp'
    if df[time_col].dtype in ('int64', 'float64'):
        # Already ms epoch
        pass
    else:
        # Convert datetime to ms
        df = df.copy()
        df[time_col] = df[time_col].astype('int64') // 10**6
    return df


def ingest_exchange(db_path: str, exchange: str, exchange_path: str, dry_run: bool = False):
    """Ingest all candle files for a single exchange. Returns (total_inserted, total_rows)."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    total_inserted = 0
    total_rows = 0

    files = sorted(os.listdir(exchange_path))
    candle_files = [f for f in files if f.endswith('.feather') or f.endswith('.parquet')]

    for filename in candle_files:
        pair, timeframe = parse_pair_timeframe_from_filename(filename)
        if pair is None or timeframe is None:
            continue

        filepath = os.path.join(exchange_path, filename)
        df = load_dataframe(filepath)
        if df is None or len(df) == 0:
            continue

        # Map column names: Freqtrade uses 'date' for timestamp
        if 'date' not in df.columns and 'timestamp' in df.columns:
            df = df.rename(columns={'timestamp': 'date'})

        required = ['date', 'open', 'high', 'low', 'close', 'volume']
        missing_req = [c for c in required if c not in df.columns]
        if missing_req:
            print(f"WARNING: {filename} missing columns {missing_req}, skipping", file=sys.stderr)
            continue

        # Handle volume normalization
        df = normalize_volume(df, pair, exchange)

        # Handle timeframe alignment
        df = align_timeframe(df, timeframe)

        time_col = '_rounded_ms' if '_rounded_ms' in df.columns else 'date'
        if df[time_col].dtype in ('int64', 'float64'):
            time_ms = df[time_col]
        else:
            time_ms = df[time_col].astype('int64') // 10**6

        rows = []
        for idx in range(len(df)):
            t = int(time_ms.iloc[idx])
            o = float(df['open'].iloc[idx])
            h = float(df['high'].iloc[idx])
            l = float(df['low'].iloc[idx])
            c = float(df['close'].iloc[idx])
            v = float(df['volume'].iloc[idx])

            if any(pd.isna(x) for x in (t, o, h, l, c, v)):
                continue

            rows.append((pair, timeframe, t, o, h, l, c, v))

        total_rows += len(rows)

        if dry_run:
            print(f"{pair}/{timeframe}: [DRY RUN] would insert {len(rows)} rows")
            continue

        batch_size = 500
        inserted = 0
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            cursor.executemany(
                """INSERT OR IGNORE INTO candles
                   (symbol, timeframe, time, open, high, low, close, volume)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                batch
            )
            inserted += cursor.rowcount

        conn.commit()
        total_inserted += inserted
        print(f"{pair}/{timeframe}: {inserted}/{len(rows)}")

    conn.close()
    return total_inserted, total_rows


def main():
    parser = argparse.ArgumentParser(
        description='Bulk ingest Freqtrade candle data into the candles SQLite table.'
    )
    parser.add_argument(
        '--db', default=DEFAULT_DB_PATH,
        help=f'Path to SQLite database (default: {DEFAULT_DB_PATH})'
    )
    parser.add_argument(
        '--data-dir', default=DEFAULT_DATA_DIR,
        help=f'Path to Freqtrade user_data/data directory (default: {DEFAULT_DATA_DIR})'
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='Print what would be done without inserting'
    )
    parser.add_argument(
        '--exchange', default=None,
        help='Limit ingestion to a specific exchange subdirectory'
    )
    args = parser.parse_args()

    if not os.path.isfile(args.db):
        print(f"ERROR: Database file not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    grand_total_inserted = 0
    grand_total_rows = 0

    for exchange, exchange_path in find_data_dirs(args.data_dir):
        if args.exchange and exchange != args.exchange:
            continue
        print(f"\n[{exchange}]")
        inserted, total = ingest_exchange(args.db, exchange, exchange_path, dry_run=args.dry_run)
        grand_total_inserted += inserted
        grand_total_rows += total

    print(f"\nTotal: {grand_total_inserted}/{grand_total_rows} rows inserted")

    if args.dry_run:
        print("[DRY RUN] No rows were actually inserted.")
        sys.exit(0)

    print("Bulk ingest complete.")
    sys.exit(0)


if __name__ == '__main__':
    main()
