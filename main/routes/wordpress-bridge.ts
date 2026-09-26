import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { requireRole } from '../middleware/security';
import { getHttpRequestSignal } from '../shutdown';
import { wordpressBridge } from '../services/wordpress-bridge';

const router = Router();

router.get('/status', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json(wordpressBridge.getStatus());
});

router.put('/config', requireRole('owner', 'manager'), asyncHandler(async (req: Request, res: Response) => {
  res.json(wordpressBridge.configure({
    site_url: req.body?.site_url,
    api_key: req.body?.api_key,
    enabled: req.body?.enabled,
  }));
}));

router.post('/test', requireRole('owner', 'manager'), asyncHandler(async (req: Request, res: Response) => {
  res.json(await wordpressBridge.testConnection(getHttpRequestSignal(req)));
}));

router.post('/sync', requireRole('owner', 'manager'), asyncHandler(async (req: Request, res: Response) => {
  res.status(202).json(await wordpressBridge.syncNow(getHttpRequestSignal(req)));
}));

router.post('/disconnect', requireRole('owner', 'manager'), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await wordpressBridge.disconnect());
}));

export default router;
