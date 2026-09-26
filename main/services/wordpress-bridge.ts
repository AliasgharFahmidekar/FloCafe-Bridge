import { safeStorage } from 'electron';
import { randomBytes, createHash } from 'node:crypto';
import { getDatabase, getSettingValue } from '../db';
import { getServerPort } from '../server-state';

type BridgeConfigRow = {
  id: number;
  bridge_id: string;
  site_url: string;
  api_key_encrypted: string | null;
  enabled: number;
  applied_catalog_revision: number;
  last_catalog_sync: string | null;
  last_order_poll: string | null;
  last_heartbeat: string | null;
  last_error: string | null;
  last_error_at: string | null;
  remote_site_id: string | null;
};

type BridgeStatus = {
  enabled: boolean;
  configured: boolean;
  bridge_id: string;
  site_url: string;
  remote_site_id: string | null;
  source_catalog_revision: number;
  applied_catalog_revision: number;
  queue_size: number;
  last_catalog_sync: string | null;
  last_order_poll: string | null;
  last_heartbeat: string | null;
  last_error: string | null;
  last_error_at: string | null;
  running: boolean;
};

type CatalogSnapshot = {
  revision: number;
  generated_at: string;
  full_snapshot: true;
  currency: string;
  categories: Array<{
    id: string;
    name: string;
    description: string | null;
    parent_id: string | null;
    slug: string | null;
    color: string | null;
    icon: string | null;
    is_active: boolean;
  }>;
  products: Array<{
    id: string;
    category_id: string | null;
    name: string;
    description: string | null;
    price: number;
    sku: string | null;
    image_url: string | null;
    is_available: boolean;
    sort_order: number;
    sale_unit: string | null;
    tags: string[];
  }>;
};

type WordPressOrder = {
  woo_order_id: number;
  external_order_id: string;
  type: string;
  online_platform: string;
  currency: string;
  total: number;
  status: string;
  note?: string | null;
  items: Array<{
    flocafe_product_id: string;
    quantity: number;
    name?: string;
  }>;
  customer?: Record<string, unknown>;
  billing?: Record<string, unknown>;
  shipping?: Record<string, unknown>;
};

const INTERNAL_INTEGRATION_TOKEN = randomBytes(32).toString('hex');
export function getInternalWordPressBridgeToken(): string {
  return INTERNAL_INTEGRATION_TOKEN;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeUrl(input: string): string {
  const trimmed = input.trim().replace(/\/$/, '');
  const url = new URL(trimmed);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('WordPress site URL must use HTTP or HTTPS');
  return trimmed;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function extractError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WordPressHttpClient {
  private base = '';
  private apiKey: string | null = null;

  set(siteUrl: string, apiKey: string | null): void {
    this.base = siteUrl.replace(/\/$/, '') + '/wp-json/flocafe/v1';
    this.apiKey = apiKey;
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    if (!this.base || !this.apiKey) throw new Error('WordPress connection is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const headers = new Headers(init.headers);
      headers.set('accept', 'application/json');
      headers.set('content-type', 'application/json');
      headers.set('x-flocafe-bridge-key', this.apiKey);
      const response = await fetch(this.base + path, { ...init, headers, signal: controller.signal });
      const text = await response.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!response.ok) {
        const detail = typeof body === 'string' ? body : (body?.message || body?.error || JSON.stringify(body));
        const error = new Error(`WordPress ${response.status}: ${detail}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  health(signal?: AbortSignal): Promise<any> { return this.request('/health', {}, signal); }
  syncCatalog(snapshot: CatalogSnapshot, signal?: AbortSignal): Promise<any> {
    return this.request('/catalog/sync', { method: 'POST', body: JSON.stringify(snapshot) }, signal);
  }
  heartbeat(payload: unknown, signal?: AbortSignal): Promise<any> {
    return this.request('/bridge/heartbeat', { method: 'POST', body: JSON.stringify(payload) }, signal);
  }
  pendingOrders(limit = 20, signal?: AbortSignal): Promise<any> {
    return this.request(`/orders/pending?limit=${limit}`, {}, signal);
  }
  claimOrder(id: number, bridgeId: string, signal?: AbortSignal): Promise<any> {
    return this.request(`/orders/${id}/claim`, { method: 'POST', body: JSON.stringify({ claimed_at: nowIso() }), headers: { 'x-cafeflo-bridge-id': bridgeId } }, signal);
  }
  ackOrder(id: number, payload: unknown, signal?: AbortSignal): Promise<any> {
    return this.request(`/orders/${id}/ack`, { method: 'POST', body: JSON.stringify(payload) }, signal);
  }
  failOrder(id: number, payload: unknown, signal?: AbortSignal): Promise<any> {
    return this.request(`/orders/${id}/failed`, { method: 'POST', body: JSON.stringify(payload) }, signal);
  }
  updateOrderStatus(id: number, payload: unknown, signal?: AbortSignal): Promise<any> {
    return this.request(`/orders/${id}/status`, { method: 'POST', body: JSON.stringify(payload) }, signal);
  }
}

class WordPressBridgeService {
  private running = false;
  private catalogTimer: NodeJS.Timeout | null = null;
  private orderTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;
  private catalogWakeTimer: NodeJS.Timeout | null = null;
  private readonly wp = new WordPressHttpClient();

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installTimers();
    void this.safeRun('startup', async () => {
      const config = this.readConfig();
      if (!config.enabled || !this.isConfigured(config)) return;
      await this.syncCatalog();
      await this.pollOrders();
      await this.pollOrderStatuses();
      await this.sendHeartbeat();
    });
  }

  stop(): void {
    this.running = false;
    for (const timer of [this.catalogTimer, this.orderTimer, this.heartbeatTimer, this.reconcileTimer, this.catalogWakeTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.catalogTimer = this.orderTimer = this.heartbeatTimer = this.reconcileTimer = this.catalogWakeTimer = null;
  }

  notifyCatalogChanged(): void {
    if (!this.running) return;
    if (this.catalogWakeTimer) clearTimeout(this.catalogWakeTimer);
    this.catalogWakeTimer = setTimeout(() => {
      this.catalogWakeTimer = null;
      void this.safeRun('catalog', () => this.syncCatalog());
    }, 150);
  }

  getStatus(): BridgeStatus {
    const config = this.readConfig();
    const source = this.sourceRevision();
    const queue = Number((getDatabase().prepare(`
      SELECT COUNT(*) AS c FROM wordpress_bridge_outbox
      WHERE status IN ('pending','processing')
    `).get() as { c: number }).c);
    return {
      enabled: bool(config.enabled),
      configured: this.isConfigured(config),
      bridge_id: config.bridge_id,
      site_url: config.site_url,
      remote_site_id: config.remote_site_id,
      source_catalog_revision: source,
      applied_catalog_revision: config.applied_catalog_revision,
      queue_size: queue,
      last_catalog_sync: config.last_catalog_sync,
      last_order_poll: config.last_order_poll,
      last_heartbeat: config.last_heartbeat,
      last_error: config.last_error,
      last_error_at: config.last_error_at,
      running: this.running,
    };
  }

  configure(input: { site_url?: unknown; api_key?: unknown; enabled?: unknown; }): BridgeStatus {
    const db = getDatabase();
    const current = this.readConfig();
    let siteUrl = current.site_url;
    if (input.site_url !== undefined) {
      if (typeof input.site_url !== 'string' || !input.site_url.trim()) throw new Error('WordPress site URL is required');
      siteUrl = safeUrl(input.site_url);
    }

    let encrypted = current.api_key_encrypted;
    if (input.api_key !== undefined) {
      if (typeof input.api_key !== 'string' || !input.api_key.trim()) {
        throw new Error('Bridge API key cannot be empty. Use Disconnect to remove the connection.');
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is not available on this device');
      }
      encrypted = safeStorage.encryptString(input.api_key.trim()).toString('base64');
    }

    const enabled = input.enabled === undefined ? bool(current.enabled) : bool(input.enabled);
    if (enabled && (!siteUrl || !encrypted)) throw new Error('Enter the WordPress URL and Bridge API key before enabling the connection');

    db.prepare(`
      UPDATE wordpress_bridge_config
      SET site_url = ?, api_key_encrypted = ?, enabled = ?, updated_at = ?
      WHERE id = 1
    `).run(siteUrl, encrypted, enabled ? 1 : 0, nowIso());

    this.reconfigureRuntime();
    return this.getStatus();
  }

  async disconnect(): Promise<BridgeStatus> {
    this.stop();
    const db = getDatabase();
    db.prepare(`
      UPDATE wordpress_bridge_config
      SET site_url = '', api_key_encrypted = NULL, enabled = 0, remote_site_id = NULL,
          last_error = NULL, last_error_at = NULL, updated_at = ?
      WHERE id = 1
    `).run(nowIso());
    this.clearPendingQueue();
    if (this.running) this.start();
    return this.getStatus();
  }

  async testConnection(signal?: AbortSignal): Promise<any> {
    const config = this.readConfig();
    if (!this.isConfigured(config)) throw new Error('WordPress connection is not configured');
    const key = this.decryptApiKey(config.api_key_encrypted);
    this.wp.set(config.site_url, key);
    const health = await this.wp.health(signal);
    if (!health?.ok) throw new Error('WordPress Bridge health check failed');
    this.persistRemoteSiteId(health?.site_id ? String(health.site_id) : null);
    this.clearError();
    return { ok: true, health };
  }

  async syncNow(signal?: AbortSignal): Promise<any> {
    const config = this.readConfig();
    if (!this.isConfigured(config)) throw new Error('WordPress connection is not configured');
    const catalog = await this.syncCatalog(signal);
    await this.pollOrders(signal);
    await this.pollOrderStatuses(signal);
    return { ok: true, catalog };
  }

  async syncCatalog(signal?: AbortSignal): Promise<any> {
    const config = this.readConfig();
    if (!this.isConfigured(config)) return { skipped: true, reason: 'not_configured' };
    const key = this.decryptApiKey(config.api_key_encrypted);
    this.wp.set(config.site_url, key);
    const snapshot = this.buildCatalogSnapshot();
    if (Number(snapshot.revision) > 0 && Number(snapshot.revision) <= Number(config.applied_catalog_revision)) {
      return { skipped: true, reason: 'already_applied', revision: snapshot.revision };
    }
    const outboxId = this.ensureCatalogOutbox();
    if (!outboxId) return { skipped: true, reason: 'retry_backoff' };
    try {
      const response = await this.wp.syncCatalog(snapshot, signal);
      if (response?.mappings?.products) {
        for (const map of response.mappings.products) this.upsertMapping('product', String(map.flocafe_product_id), Number(map.woo_product_id), snapshot.revision);
      }
      if (response?.mappings?.categories) {
        for (const map of response.mappings.categories) this.upsertMapping('category', String(map.flocafe_category_id), Number(map.woo_category_id), snapshot.revision);
      }
      const db = getDatabase();
      db.prepare(`
        UPDATE wordpress_bridge_config
        SET applied_catalog_revision = ?, last_catalog_sync = ?, last_error = NULL, last_error_at = NULL,
            updated_at = ?
        WHERE id = 1
      `).run(snapshot.revision, nowIso(), nowIso());
      if (outboxId) this.completeOutbox(outboxId);
      return { ...response, source_revision: snapshot.revision };
    } catch (error) {
      if (outboxId) this.failOutbox(outboxId, extractError(error));
      this.recordError(error);
      throw error;
    }
  }

  async pollOrders(signal?: AbortSignal): Promise<void> {
    const config = this.readConfig();
    if (!this.isConfigured(config)) return;
    const key = this.decryptApiKey(config.api_key_encrypted);
    this.wp.set(config.site_url, key);
    const list = await this.wp.pendingOrders(20, signal);
    this.markOrderPoll();
    const orders = Array.isArray(list?.orders) ? list.orders as WordPressOrder[] : [];
    for (const order of orders) {
      if (!order?.woo_order_id || !order.external_order_id) continue;
      const already = getDatabase().prepare('SELECT flocafe_order_id FROM wordpress_bridge_orders WHERE external_order_id = ?').get(order.external_order_id) as { flocafe_order_id?: string | null } | undefined;
      if (already?.flocafe_order_id) {
        await this.wp.ackOrder(order.woo_order_id, { flocafe_order_id: already.flocafe_order_id, external_order_id: order.external_order_id, already_exists: true }, signal);
        continue;
      }
      try {
        await this.wp.claimOrder(order.woo_order_id, config.bridge_id, signal);
      } catch (error) {
        if (Number((error as any)?.status) === 409) continue;
        throw error;
      }

      try {
        const items = order.items.map(item => ({ product_id: String(item.flocafe_product_id), quantity: Number(item.quantity) }));
        const quote = await this.localRequest('/api/integration/orders/quote', { method: 'POST', body: JSON.stringify({ items }) }, signal);
        if (!quote?.valid) {
          await this.wp.failOrder(order.woo_order_id, { code: 'CATALOG_CHANGED', message: quote?.message || quote?.error || 'Product availability or price changed.', retryable: false }, signal);
          continue;
        }

        const result = await this.localRequest('/api/integration/orders', {
          method: 'POST',
          body: JSON.stringify({
            type: 'online',
            online_platform: 'wordpress',
            external_order_id: order.external_order_id,
            currency: order.currency,
            customer: order.customer,
            billing: order.billing,
            shipping: order.shipping,
            note: order.note,
            items,
          }),
        }, signal);

        const flocafeOrder = result?.order ?? result;
        const flocafeOrderId = String(flocafeOrder?.id || '');
        if (!flocafeOrderId) throw new Error('FloCafe did not return an order ID');

        this.upsertOrderMap(order.external_order_id, order.woo_order_id, flocafeOrderId, String(flocafeOrder.status || 'pending'));
        await this.wp.ackOrder(order.woo_order_id, {
          flocafe_order_id: flocafeOrderId,
          external_order_id: order.external_order_id,
          already_exists: Boolean(result?.idempotent_replay),
        }, signal);
      } catch (error) {
        const status = Number((error as any)?.statusCode ?? (error as any)?.status ?? 0);
        const retryable = status === 0 || status >= 500;
        await this.wp.failOrder(order.woo_order_id, {
          code: retryable ? 'FLOCAFE_TEMPORARY_FAILURE' : 'FLOCAFE_CREATE_FAILED',
          message: extractError(error),
          retryable,
        }, signal).catch(() => {});
        if (retryable) throw error;
      }
    }
  }

  async pollOrderStatuses(signal?: AbortSignal): Promise<void> {
    const config = this.readConfig();
    if (!this.isConfigured(config)) return;
    const key = this.decryptApiKey(config.api_key_encrypted);
    this.wp.set(config.site_url, key);
    const state = getDatabase().prepare('SELECT revision FROM wordpress_bridge_order_state WHERE id = 1').get() as { revision: number };
    const data = await this.localRequest(`/api/integration/orders/changes?after_revision=${Math.max(0, Number(state.revision || 0))}`, {}, signal);
    const changes = Array.isArray(data?.changes) ? data.changes : [];
    for (const change of changes) {
      const externalId = String(change.external_order_id || '');
      if (!externalId) continue;
      const row = getDatabase().prepare('SELECT woo_order_id FROM wordpress_bridge_orders WHERE external_order_id = ?').get(externalId) as { woo_order_id?: number } | undefined;
      const wooId = Number(row?.woo_order_id || externalId);
      if (!Number.isInteger(wooId) || wooId <= 0) continue;
      await this.wp.updateOrderStatus(wooId, {
        flocafe_order_id: String(change.order_id),
        flocafe_status: String(change.status),
        status: String(change.status),
      }, signal);
      this.upsertOrderMap(externalId, wooId, String(change.order_id), String(change.status));
      getDatabase().prepare('UPDATE wordpress_bridge_config SET last_order_poll = ?, updated_at = ? WHERE id = 1').run(nowIso(), nowIso());
      getDatabase().prepare('UPDATE wordpress_bridge_order_state SET revision = ?, updated_at = ? WHERE id = 1').run(Number(change.revision), nowIso());
    }
    if (data?.revision && changes.length === 0) {
      getDatabase().prepare('UPDATE wordpress_bridge_order_state SET revision = ?, updated_at = ? WHERE id = 1').run(Number(data.revision), nowIso());
    }
  }

  async sendHeartbeat(signal?: AbortSignal): Promise<void> {
    const config = this.readConfig();
    if (!this.isConfigured(config)) return;
    const key = this.decryptApiKey(config.api_key_encrypted);
    this.wp.set(config.site_url, key);
    const payload = {
      bridge_id: config.bridge_id,
      version: 'native',
      flocafe_version: process.env.npm_package_version || 'unknown',
      os: process.platform,
      online: true,
      catalog_revision: this.sourceRevision(),
      timestamp: nowIso(),
      flocafe_store: {
        online_ordering_enabled: getSettingValue('online_ordering_enabled') !== 'false',
        online_ordering_open: getSettingValue('online_ordering_open') !== 'false',
        currency: getSettingValue('currency') || '',
      },
    };
    const response = await this.wp.heartbeat(payload, signal);
    this.persistRemoteSiteId(response?.site_id ? String(response.site_id) : null);
    getDatabase().prepare('UPDATE wordpress_bridge_config SET last_heartbeat=?, last_error=NULL, last_error_at=NULL, updated_at=? WHERE id=1').run(nowIso(), nowIso());
  }

  private installTimers(): void {
    this.catalogTimer = setInterval(() => void this.safeRun('catalog', () => this.syncCatalog()), 2000);
    this.orderTimer = setInterval(() => void this.safeRun('orders', () => this.pollOrders()), 3000);
    this.heartbeatTimer = setInterval(() => void this.safeRun('heartbeat', () => this.sendHeartbeat()), 30000);
    this.reconcileTimer = setInterval(() => void this.safeRun('reconcile', async () => {
      await this.syncCatalog();
      await this.pollOrderStatuses();
    }), 300000);
  }

  private async safeRun(name: string, fn: () => Promise<unknown>): Promise<void> {
    if (!this.running && name !== 'startup') return;
    if (this.cycleInFlight) return;
    this.cycleInFlight = true;
    try {
      await fn();
    } catch (error) {
      this.recordError(error, name);
    } finally {
      this.cycleInFlight = false;
    }
  }

  private readConfig(): BridgeConfigRow {
    return getDatabase().prepare('SELECT * FROM wordpress_bridge_config WHERE id = 1').get() as BridgeConfigRow;
  }

  private isConfigured(config: BridgeConfigRow): boolean {
    return Boolean(config.site_url && config.api_key_encrypted);
  }

  private decryptApiKey(encrypted: string | null): string {
    if (!encrypted) throw new Error('WordPress Bridge API key is not configured');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is not available on this device');
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  private buildCatalogSnapshot(): CatalogSnapshot {
    const db = getDatabase();
    const state = db.prepare('SELECT revision FROM wordpress_bridge_catalog_state WHERE id=1').get() as { revision: number };
    const categories = db.prepare(`
      SELECT id, name, description, parent_id, slug, color, icon, sort_order, is_active
      FROM categories
      WHERE deleted_at IS NULL
      ORDER BY sort_order ASC, name ASC
    `).all() as any[];
    const products = db.prepare(`
      SELECT id, category_id, name, description, price, sku, image_url, sort_order, is_active, sale_unit, tags
      FROM products
      WHERE deleted_at IS NULL
      ORDER BY sort_order ASC, name ASC
    `).all() as any[];
    return {
      revision: Number(state.revision || 0),
      generated_at: nowIso(),
      full_snapshot: true,
      currency: getSettingValue('currency') || '',
      categories: categories.map(row => ({
        id: String(row.id),
        name: String(row.name),
        description: row.description == null ? null : String(row.description),
        parent_id: row.parent_id == null ? null : String(row.parent_id),
        slug: row.slug == null ? null : String(row.slug),
        color: row.color == null ? null : String(row.color),
        icon: row.icon == null ? null : String(row.icon),
        is_active: Number(row.is_active) === 1,
      })),
      products: products.map(row => ({
        id: String(row.id),
        category_id: row.category_id == null ? null : String(row.category_id),
        name: String(row.name),
        description: row.description == null ? null : String(row.description),
        price: Number(row.price || 0),
        sku: row.sku == null || row.sku === '' ? null : String(row.sku),
        image_url: row.image_url == null || row.image_url === '' ? null : String(row.image_url),
        is_available: Number(row.is_active) === 1,
        sort_order: Number(row.sort_order || 0),
        sale_unit: row.sale_unit == null || row.sale_unit === '' ? null : String(row.sale_unit),
        tags: this.parseTags(row.tags),
      })),
    };
  }

  private parseTags(value: unknown): string[] {
    if (typeof value !== 'string' || !value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).slice(0, 100) : [];
    } catch { return []; }
  }

  private sourceRevision(): number {
    const row = getDatabase().prepare('SELECT revision FROM wordpress_bridge_catalog_state WHERE id=1').get() as { revision: number };
    return Number(row?.revision || 0);
  }

  private ensureCatalogOutbox(): number {
    const db = getDatabase();
    const existing = db.prepare(`
      SELECT id, status, next_attempt_at FROM wordpress_bridge_outbox
      WHERE type='catalog' AND status IN ('pending','processing')
      ORDER BY id LIMIT 1
    `).get() as { id: number; status: string; next_attempt_at: string } | undefined;
    if (existing) {
      if (existing.status === 'pending' && new Date(existing.next_attempt_at).getTime() > Date.now()) {
        return 0;
      }
      if (existing.status === 'pending') {
        db.prepare(`UPDATE wordpress_bridge_outbox SET status='processing', updated_at=? WHERE id=?`).run(nowIso(), existing.id);
      }
      return Number(existing.id);
    }
    db.prepare(`DELETE FROM wordpress_bridge_outbox WHERE type='catalog' AND status='completed'`).run();
    const now = nowIso();
    return Number(db.prepare(`
      INSERT INTO wordpress_bridge_outbox(type,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES ('catalog','processing',0,?,?,?)
    `).run('catalog', 'processing', 0, now, now, now).lastInsertRowid);
  }

  private completeOutbox(id: number): void {
    getDatabase().prepare('UPDATE wordpress_bridge_outbox SET status=\'completed\', updated_at=? WHERE id=?').run(nowIso(), id);
  }

  private failOutbox(id: number, error: string): void {
    const db = getDatabase();
    const row = db.prepare('SELECT attempts FROM wordpress_bridge_outbox WHERE id=?').get(id) as { attempts: number } | undefined;
    const attempts = Number(row?.attempts || 0) + 1;
    const delay = Math.min(300000, 1000 * Math.pow(2, Math.min(attempts, 8)));
    db.prepare(`
      UPDATE wordpress_bridge_outbox
      SET status='pending', attempts=?, next_attempt_at=?, last_error=?, updated_at=?
      WHERE id=?
    `).run(attempts, new Date(Date.now() + delay).toISOString(), error.slice(0, 1000), nowIso(), id);
  }

  private clearPendingQueue(): void {
    getDatabase().prepare(`
      UPDATE wordpress_bridge_outbox
      SET status='completed', updated_at=?
      WHERE status IN ('pending','processing')
    `).run(nowIso());
  }

  private upsertMapping(type: 'product'|'category', flocafeId: string, wordpressId: number, revision: number): void {
    const db=getDatabase(), now=nowIso();
    db.prepare(`
      INSERT INTO wordpress_bridge_mappings(entity_type,flocafe_id,wordpress_id,last_revision,last_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(entity_type,flocafe_id) DO UPDATE SET
        wordpress_id=excluded.wordpress_id,last_revision=excluded.last_revision,
        last_hash=excluded.last_hash,updated_at=excluded.updated_at
    `).run(type, flocafeId, wordpressId, revision, createHash('sha256').update(`${flocafeId}:${wordpressId}`).digest('hex'), now, now);
  }

  private upsertOrderMap(externalId: string, wooId: number, floId: string, status: string): void {
    const now=nowIso();
    getDatabase().prepare(`
      INSERT INTO wordpress_bridge_orders(external_order_id,woo_order_id,flocafe_order_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(external_order_id) DO UPDATE SET
        woo_order_id=excluded.woo_order_id,flocafe_order_id=excluded.flocafe_order_id,
        status=excluded.status,updated_at=excluded.updated_at
    `).run(externalId, wooId, floId, status, now, now);
  }

  private localRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    const port = getServerPort();
    if (!port) throw new Error('FloCafe local server is not ready');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(init.headers || {}),
        'x-flocafe-integration-key': INTERNAL_INTEGRATION_TOKEN,
      },
      signal: controller.signal,
    }).then(async response => {
      const text=await response.text();
      let body:any=null; try{body=text?JSON.parse(text):null;}catch{body=text;}
      if(!response.ok){
        const error=new Error(`FloCafe ${response.status}: ${typeof body==='string'?body:(body?.error||JSON.stringify(body))}`) as Error & {status?:number};
        error.status=response.status;
        throw error;
      }
      return body;
    }).finally(()=>{clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);});
  }

  private markOrderPoll(): void {
    const t=nowIso();
    getDatabase().prepare('UPDATE wordpress_bridge_config SET last_order_poll=?, updated_at=? WHERE id=1').run(t,t);
  }

  private persistRemoteSiteId(siteId: string | null): void {
    getDatabase().prepare('UPDATE wordpress_bridge_config SET remote_site_id=?, updated_at=? WHERE id=1').run(siteId,nowIso());
  }

  private clearError(): void {
    getDatabase().prepare('UPDATE wordpress_bridge_config SET last_error=NULL,last_error_at=NULL,updated_at=? WHERE id=1').run(nowIso());
  }

  private recordError(error: unknown, phase = 'bridge'): void {
    const message=extractError(error);
    console.error(`[WordPressBridge] ${phase}: ${message}`);
    const t=nowIso();
    getDatabase().prepare('UPDATE wordpress_bridge_config SET last_error=?,last_error_at=?,updated_at=? WHERE id=1').run(message.slice(0,1000),t,t);
  }

  private reconfigureRuntime(): void {
    const shouldRun=bool(this.readConfig().enabled);
    this.stop();
    if(shouldRun){this.start();}
  }
}

export const wordpressBridge = new WordPressBridgeService();
