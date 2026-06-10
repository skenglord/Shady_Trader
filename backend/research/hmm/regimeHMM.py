# regimeHMM.py — Train HMM for regime transition prediction
#
# ISOLATED RESEARCH MODULE — not imported by production.
# Requires: pip install hmmlearn numpy pandas

import numpy as np
from hmmlearn import hmm

def train_regime_hmm(observations: np.ndarray, n_states: int = 4):
    """Train a Gaussian HMM on regime observations."""
    model = hmm.GaussianHMM(n_components=n_states, covariance_type="diag", n_iter=100)
    model.fit(observations)
    return model

# Placeholder — actual training requires historical regime labels
if __name__ == "__main__":
    print("HMM training script — research only")
