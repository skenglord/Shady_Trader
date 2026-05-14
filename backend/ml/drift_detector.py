"""
Input  (stdin):  JSON with training_features and recent_features
Output (stdout): JSON drift report
"""
import json
import sys
import numpy as np
from scipy.stats import ks_2samp


def detect_drift(training: list, recent: list,
                 feature_names: list, threshold=0.05) -> dict:
    tr = np.array(training)
    re = np.array(recent)

    if tr.shape[1] != re.shape[1]:
        return {'error': 'Feature count mismatch'}

    report = {}
    n_drifted = 0

    for i, name in enumerate(feature_names):
        stat, p = ks_2samp(tr[:, i], re[:, i])
        drifted = bool(p < threshold)
        if drifted:
            n_drifted += 1
        report[name] = {
            'ks_statistic': round(float(stat), 4),
            'p_value': round(float(p), 4),
            'drifted': drifted
        }

    frac = n_drifted / max(len(feature_names), 1)
    report['_summary'] = {
        'features_drifted': n_drifted,
        'total_features': len(feature_names),
        'drift_fraction': round(frac, 3),
        'retrain_recommended': frac > 0.30,
        'drift_score': round(frac, 3)
    }

    print(json.dumps(report))


if __name__ == '__main__':
    data = json.load(sys.stdin)
    detect_drift(
        data['training_features'],
        data['recent_features'],
        data['feature_names']
    )