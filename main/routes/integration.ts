import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getDatabase, getSettingValue, upsertSettings, parseRowJson, attachEffectiveAddons } from '../db';
import { orderRoutes } from './orders';
import { validateProductQuantity } from './orders-validation';
import { resolveInventoryDeduction } from '../services/inventory';
import { parsePhoneE164, stripPhoneDigits } from '../lib/phone';

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
  const categories = db.prepare(`SELECT id, name, description, image_url, sort_order, parent_id, slug, color, icon, is_active FROM categories WHERE deleted_at IS NULL ORDER BY sort_order ASC, name ASC`).all() as any[];
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


function resolveIntegrationCustomer(db: ReturnType<typeof getDatabase>, body: any): string | null {
  const customer = body?.customer && typeof body.customer === 'object' ? body.customer : {};
  const billing = body?.billing && typeof body.billing === 'object' ? body.billing : {};
  const shipping = body?.shipping && typeof body.shipping === 'object' ? body.shipping : {};

  const explicit = typeof body?.customer_id === 'string' ? body.customer_id.trim() : '';
  if (explicit && explicit.startsWith('cust-')) {
    const existing = db.prepare('SELECT id FROM customers WHERE id = ? AND is_active = 1').get(explicit) as { id: string } | undefined;
    if (existing) return String(existing.id);
  }

  const phoneInput = String(customer.phone || billing.phone || shipping.phone || '').trim();
  const countryHint = String(billing.country || shipping.country || getSettingValue('country') || '').trim();
  let phone: string | null = null;
  let countryCode: string | null = null;
  let phoneDigits = '';

  if (phoneInput) {
    const parsed = parsePhoneE164(phoneInput, countryHint);
    if (!parsed) throw Object.assign(new Error('Customer phone number is invalid'), { statusCode: 422 });
    phone = parsed.e164;
    countryCode = parsed.countryCode;
    phoneDigits = stripPhoneDigits(phone);
  }

  const email = String(customer.email || billing.email || '').trim().toLowerCase();
  const fullName = String(
    customer.name ||
    [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
    [billing.first_name, billing.last_name].filter(Boolean).join(' ') ||
    [shipping.first_name, shipping.last_name].filter(Boolean).join(' ') ||
    'Online customer'
  ).trim();

  let existing: any = null;
  if (phoneDigits) existing = db.prepare('SELECT * FROM customers WHERE phone_digits = ? LIMIT 1').get(phoneDigits);
  if (!existing && email) existing = db.prepare('SELECT * FROM customers WHERE LOWER(email) = ? ORDER BY is_active DESC, created_at ASC, id ASC LIMIT 1').get(email);

  const addressParts = [
    billing.address_1 || shipping.address_1,
    billing.address_2 || shipping.address_2,
    billing.city || shipping.city,
    billing.state || shipping.state,
    billing.postcode || shipping.postcode,
    billing.country || shipping.country,
  ].filter(Boolean);
  const address = addressParts.join(', ') || null;

  if (existing) {
    db.prepare('UPDATE customers SET name=?, email=?, phone=?, country_code=?, address=?, is_active=1, updated_at=? WHERE id=?')
      .run(fullName, email || existing.email || null, phone || existing.phone || null, countryCode || existing.country_code || null, address || existing.address || null, new Date().toISOString(), existing.id);
    return String(existing.id);
  }

  const externalId = typeof body?.external_order_id === 'string' ? body.external_order_id.trim() : '';
  const id = externalId
    ? 'cust-online-' + crypto.createHash('sha256').update('wordpress:' + externalId).digest('hex').slice(0, 32)
    : 'cust-' + randomUUID();

  db.prepare('INSERT INTO customers (id, name, email, phone, country_code, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, fullName, email || null, phone, countryCode, address, new Date().toISOString(), new Date().toISOString());
  return id;
}

function integrationActor(req: Request, res: Response, next: () => void): void {
  const db = getDatabase();
  const configured = process.env.FLOCAFE_INTEGRATION_USER_ID?.trim();
  const actor = configured
    ? db.prepare("SELECT id, role, is_active FROM users WHERE id = ? AND role IN ('owner','manager')").get(configured) as any
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
  const externalOrderId = body.external_order_id.trim();
  if (externalOrderId.length > 100) {
    res.status(422).json({ error: 'external_order_id must be at most 100 characters' });
    return;
  }

  const existing = getDatabase().prepare("SELECT id FROM orders WHERE online_platform = 'wordpress' AND external_order_id = ?").get(externalOrderId) as { id: string } | undefined;
  if (existing) {
    const db = getDatabase();
    const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(existing.id)) as any;
    const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(existing.id).map(parseRowJson) as any[]);
    res.status(200).json({ order: { ...order, items }, idempotent_replay: true });
    return;
  }

  try {
    const customerId = resolveIntegrationCustomer(getDatabase(), { ...body, external_order_id: externalOrderId });
    const originalBody = req.body;
    const originalUrl = req.url;
    const originalIdempotencyKey = req.get('Idempotency-Key');
    req.body = { ...body, external_order_id: externalOrderId, customer_id: customerId };
    if (!originalIdempotencyKey) req.headers['idempotency-key'] = `wordpress:${externalOrderId}`;
    req.url = '/';
    (orderRoutes as any).handle(req, res, (err?: any) => {
      req.body = originalBody;
      req.url = originalUrl;
      if (originalIdempotencyKey) req.headers['idempotency-key'] = originalIdempotencyKey; else delete req.headers['idempotency-key'];
      next(err);
    });
  } catch (error: any) {
    res.status(error.statusCode || 422).json({ error: error.message || 'Unable to resolve integration customer' });
  }
});

integrationRoutes.get('/orders/changes', (req, res) => {
  const db = getDatabase();
  const afterRevision = Math.max(0, Number(req.query.after_revision || 0));
  const currentRevision = Number((db.prepare('SELECT revision FROM integration_order_state WHERE id = 1').get() as any)?.revision || 0);
  const changes = db.prepare("SELECT c.revision, c.order_id, o.external_order_id, c.status, c.changed_at FROM integration_order_changes c JOIN orders o ON o.id = c.order_id WHERE c.revision > ? AND o.online_platform = 'wordpress' ORDER BY c.revision ASC LIMIT 500").all(afterRevision);
  res.json({ after_revision: afterRevision, revision: currentRevision, has_more: (changes as any[]).length === 500, changes });
});


integrationRoutes.get('/orders/:id', (req, res) => {
  const db = getDatabase();
  const order = parseRowJson(db.prepare("SELECT * FROM orders WHERE id = ? AND online_platform = 'wordpress'").get(req.params.id)) as any;
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
  const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(req.params.id).map(parseRowJson) as any[]);
  res.json({ order: { ...order, items } });
});

integrationRoutes.post('/orders/:id/cancel', integrationActor, (req, res, next) => {
  const id = String(req.params.id);
  const db = getDatabase();
  const exists = db.prepare("SELECT 1 FROM orders WHERE id = ? AND online_platform = 'wordpress'").get(id);
  if (!exists) { res.status(404).json({ error: 'Order not found' }); return; }
  const originalUrl = req.url;
  req.url = `/${id}/status`;
  (req as any).body = { ...(req.body || {}), status: 'cancelled' };
  (orderRoutes as any).handle(req, res, (err?: any) => {
    req.url = originalUrl;
    next(err);
  });
});

export default integrationRoutes;
