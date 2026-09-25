import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { getDatabase, getSettingValue, upsertSettings, parseRowJson, attachEffectiveAddons } from '../db';
import { orderRoutes } from './orders';
import { validateProductQuantity } from './orders-validation';
import { resolveInventoryDeduction } from '../services/inventory';

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

integrationRoutes.post('/store', (req, res) => {
  const body = req.body || {};
  if (body.online_ordering_enabled !== undefined && typeof body.online_ordering_enabled !== 'boolean') {
    res.status(400).json({ error: 'online_ordering_enabled must be boolean' }); return;
  }
  if (body.online_ordering_open !== undefined && typeof body.online_ordering_open !== 'boolean') {
    res.status(400).json({ error: 'online_ordering_open must be boolean' }); return;
  }
  upsertSettings({
    online_ordering_enabled: body.online_ordering_enabled === undefined ? undefined : String(body.online_ordering_enabled),
    online_ordering_open: body.online_ordering_open === undefined ? undefined : String(body.online_ordering_open),
  });
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

function integrationActor(req: Request, res: Response, next: () => void): void {
  const db = getDatabase();
  const configured = process.env.FLOCAFE_INTEGRATION_USER_ID?.trim();
  const actor = configured
    ? db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(configured) as any
    : db.prepare("SELECT id, role, is_active FROM users WHERE is_active = 1 AND role IN ('owner','manager') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END LIMIT 1").get() as any;
  if (!actor || actor.is_active !== 1) {
    res.status(503).json({ error: 'No active FloCafe integration actor is configured' });
    return;
  }
  (req as any).user = { userId: String(actor.id), role: actor.role };
  next();
}

integrationRoutes.post('/orders/quote', (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: 'At least one item is required' }); return; }
    if (items.length > 100) { res.status(400).json({ error: 'Too many items' }); return; }
    const db = getDatabase();
    let subtotal = 0;
    const quotedItems = items.map((item: any) => {
      const product = db.prepare('SELECT id, name, sku, price, is_active, deleted_at, sale_unit, allow_fractional_quantity, weight_precision FROM products WHERE id = ?').get(item?.product_id) as any;
      if (!product || product.deleted_at || product.is_active !== 1) throw Object.assign(new Error(`Product ${item?.product_id} is unavailable`), { statusCode: 409 });
      validateProductQuantity(product, item?.quantity);
      const deduction = resolveInventoryDeduction(product, item.quantity);
      if (deduction && deduction.deductedQuantity < item.quantity) throw Object.assign(new Error(`Insufficient availability for ${product.name}`), { statusCode: 409 });
      const unitPrice = Number(product.price);
      const lineTotal = unitPrice * Number(item.quantity);
      subtotal += lineTotal;
      return { product_id: String(product.id), name: product.name, sku: product.sku ?? null, quantity: item.quantity, unit_price: unitPrice, line_total: lineTotal };
    });
    res.json({ valid: true, currency: getSettingValue('currency'), items: quotedItems, estimated_subtotal: subtotal, note: 'Final total is calculated by FloCafe during order creation using its current tax, charge, discount, and pricing rules.', quoted_at: new Date().toISOString() });
  } catch (error: any) {
    res.status(error.statusCode || 400).json({ valid: false, error: error.message || 'Unable to quote order' });
  }
});

integrationRoutes.post('/orders', integrationActor, (req, res, next) => {
  const body = req.body || {};
  const store = readStoreStatus();
  if (!store.online_ordering_enabled || !store.online_ordering_open) {
    res.status(409).json({ error: 'Online ordering is currently closed' });
    return;
  }
  if (body.type !== 'online') {
    res.status(400).json({ error: 'Integration orders must use type=online' });
    return;
  }
  if (typeof body.online_platform !== 'string' || body.online_platform.trim() !== 'wordpress') {
    res.status(400).json({ error: 'online_platform must be wordpress' });
    return;
  }
  if (typeof body.external_order_id !== 'string' || !body.external_order_id.trim()) {
    res.status(400).json({ error: 'external_order_id is required' });
    return;
  }

  const existing = getDatabase().prepare("SELECT id FROM orders WHERE online_platform = 'wordpress' AND external_order_id = ?").get(body.external_order_id.trim()) as { id: string } | undefined;
  if (existing) {
    const db = getDatabase();
    const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(existing.id)) as any;
    const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(existing.id).map(parseRowJson) as any[]);
    res.status(200).json({ order: { ...order, items }, idempotent_replay: true });
    return;
  }

  const originalUrl = req.url;
  req.url = '/';
  orderRoutes.handle(req, res, (err?: any) => {
    req.url = originalUrl;
    next(err);
  });
});

integrationRoutes.get('/orders/:id', (req, res) => {
  const db = getDatabase();
  const order = parseRowJson(db.prepare("SELECT * FROM orders WHERE id = ? AND online_platform = 'wordpress'").get(req.params.id)) as any;
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
  const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(req.params.id).map(parseRowJson) as any[]);
  res.json({ order: { ...order, items } });
});

integrationRoutes.get('/orders/changes', (req, res) => {
  const db = getDatabase();
  const afterRevision = Math.max(0, Number(req.query.after_revision || 0));
  const currentRevision = Number((db.prepare('SELECT revision FROM integration_order_state WHERE id = 1').get() as any)?.revision || 0);
  const changes = db.prepare("SELECT c.revision, c.order_id, c.status, c.changed_at FROM integration_order_changes c JOIN orders o ON o.id = c.order_id WHERE c.revision > ? AND o.online_platform = 'wordpress' ORDER BY c.revision ASC LIMIT 500").all(afterRevision);
  res.json({ after_revision: afterRevision, revision: currentRevision, has_more: (changes as any[]).length === 500, changes });
});

integrationRoutes.post('/orders/:id/cancel', integrationActor, (req, res, next) => {
  const id = String(req.params.id);
  const db = getDatabase();
  const exists = db.prepare("SELECT 1 FROM orders WHERE id = ? AND online_platform = 'wordpress'").get(id);
  if (!exists) { res.status(404).json({ error: 'Order not found' }); return; }
  const originalUrl = req.url;
  req.url = `/${id}/status`;
  (req as any).body = { ...(req.body || {}), status: 'cancelled' };
  orderRoutes.handle(req, res, (err?: any) => {
    req.url = originalUrl;
    next(err);
  });
});

export default integrationRoutes;
