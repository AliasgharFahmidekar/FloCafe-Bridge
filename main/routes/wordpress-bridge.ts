import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { requirePermission } from '../services/authorization';
import { getHttpRequestSignal } from '../shutdown';
import { wordpressBridge } from '../services/wordpress-bridge';

const router = Router();

router.get('/status', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json(wordpressBridge.getStatus());
});

router.put('/config', requirePermission('settings.manage'), asyncHandler(async (req: Request, res: Response) => {
  res.json(wordpressBridge.configure({
    site_url: req.body?.site_url,
    api_key: req.body?.api_key,
    enabled: req.body?.enabled,
  }));
}));

router.post('/test', requirePermission('settings.manage'), asyncHandler(async (req: Request, res: Response) => {
  res.json(await wordpressBridge.testConnection(getHttpRequestSignal(req)));
}));

router.post('/sync', requirePermission('settings.manage'), asyncHandler(async (req: Request, res: Response) => {
  res.status(202).json(await wordpressBridge.syncNow(getHttpRequestSignal(req)));
}));

router.post('/disconnect', requirePermission('settings.manage'), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await wordpressBridge.disconnect());
}));

export default router;
