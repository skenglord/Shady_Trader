import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.status(410).json({
    error: 'WFA API is deprecated',
    message: 'Walk-forward analysis endpoints are retired. Use the tested WFA components under backend/validation/wfa for offline analysis.',
    alternatives: [
      'backend/validation/wfa/data-partitioner.ts',
      'backend/validation/wfa/rolling-optimizer.ts',
      'backend/validation/wfa/overfitting-detector.ts',
      'backend/validation/wfa/statistical-validator.ts',
      'backend/validation/wfa/wfa-checkpoint.ts',
    ],
  });
});

router.get('/health', (_req, res) => {
  res.status(410).json({
    status: 'deprecated',
    service: 'wfa',
  });
});

router.all('*', (_req, res) => {
  res.status(410).json({
    error: 'WFA API is deprecated',
    message: 'The Fastify-style WFA controller is no longer mounted. Use the WFA component modules for offline validation.',
  });
});

export default router;
