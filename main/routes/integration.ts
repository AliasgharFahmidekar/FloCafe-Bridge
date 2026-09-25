import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDatabase, getSettingValue } from '../db';

export const integrationRoutes = Router();

function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress || req.ip || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireIntegrationKey(req: Request, res: Response): boolean {
  if (!isLoopback(req)) { res.status(403).json({ error: 'Integration API is localhost-only' }); return false; }
  const expected = process.env.FLOCAFE_INTEGRATION_API_KEY?.trim();
  if (!expected) { res.status(503).json({ error: 'Integration API is not configured' }); return false; }
  const supplied = req.get('x-flocafe-integration-key')?.trim() || '';
  if (!supplied || !timingSafeEqualText(supplied, expected)) { res.status(401).json({ error: 'Invalid integration credentials' }); return false; }
  return true;
}

integrationRoutes.use((req, res, next) => { if (requireIntegrationKey(req, res)) next(); });

function getCatalogRevision(db: ReturnType<typeof getDatabase>): number {
  const row = db.prepare('SELECT revision FROM integration_catalog_state WHERE id = 1').get() as { revision?: number } | undefined;
  return Number(row?.revision || 0);
}

function readStoreStatus() {
  const enabled = getSettingValue('online_ordering_enabled');
  const open = getSettingValue('online_ordering_open');
  return { online_ordering_enabled: enabled !== 'false', online_ordering_open: open !== 'false' };
}

function readCatalog() {
  const db = getDatabase();
  const revision = getCatalogRevision(db);
  const categories = db.prepare(`SELECT id, name, description, image_url, sort_order, parent_id, slug, color, icon, is_active FROM categories WHERE deleted_at IS NULL AND is_active = 1 ORDER BY sort_order ASC, name ASC`).all() as any[];
  const products = db.prepare(`SELECT id, category_id, name, description, price, sku, sale_unit, image_url, sort_order, is_active, tags FROM products WHERE deleted_at IS NULL ORDER BY sort_order ASC, name ASC`).all() as any[];
  return {
    revision,
    categories: categories.map((row) => ({ id: String(row.id), name: row.name, description: row.description ?? null, image_url: row.image_url ?? null, sort_order: Number(row.sort_order || 0), parent_id: row.parent_id == null ? null : String(row.parent_id), slug: row.slug ?? null, color: row.color ?? null, icon: row.icon ?? null })),
    products: products.map((row) => ({ id: String(row.id), category_id: row.category_id == null ? null : String(row.category_id), name: row.name, description: row.description ?? null, price: Number(row.price || 0), sku: row.sku ?? null, sale_unit: row.sale_unit ?? null, image_url: row.image_url ?? null, sort_order: Number(row.sort_order || 0), is_available: row.is_active === 1, tags: (() => { try { return row.tags ? JSON.parse(row.tags) : []; } catch { return []; } })() })),
  };
}

integrationRoutes.get('/health', (_req, res) => {
  const db = getDatabase();
  res.json({ status: 'ok', service: 'FloCafe Integration API', api_version: 1, flocafe_version: process.env.npm_package_version || 'unknown', catalog_revision: getCatalogRevision(db), timestamp: new Date().toISOString() });
});

integrationRoutes.get('/store', (_req, res) => {
  res.json({ ...readStoreStatus(), currency: getSettingValue('currency'), timestamp: new Date().toISOString() });
});

integrationRoutes.get('/catalog', (_req, res) => res.json(readCatalog()));
integrationRoutes.get('/catalog/snapshot', (_req, res) => res.json(readCatalog()));

integrationRoutes.get('/catalog/changes', (req, res) => {
  const db = getDatabase();
  const afterRevision = Math.max(0, Number(req.query.after_revision || 0));
  const currentRevision = getCatalogRevision(db);
  const changes = db.prepare('SELECT revision, entity_type, entity_id, action, changed_at FROM integration_catalog_changes WHERE revision > ? ORDER BY revision ASC LIMIT 500').all(afterRevision);
  res.json({ after_revision: afterRevision, revision: currentRevision, has_more: (changes as any[]).length === 500, changes });
});

export default integrationRoutes;