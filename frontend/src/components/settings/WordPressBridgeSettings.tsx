'use client';

import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { CheckCircle2, CircleAlert, Link2Off, RefreshCw, Save, Wifi, WifiOff } from 'lucide-react';

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

function formatTimestamp(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function WordPressBridgeSettings() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [siteUrl, setSiteUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/wordpress-bridge/status');
      setStatus(data);
      setSiteUrl(data.site_url || '');
      setEnabled(Boolean(data.enabled));
    } catch {
      toast.error('Could not load WordPress Bridge settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        site_url: siteUrl.trim(),
        enabled,
      };
      if (apiKey.trim()) payload.api_key = apiKey.trim();
      const { data } = await api.put('/wordpress-bridge/config', payload);
      setStatus(data);
      setApiKey('');
      toast.success(enabled ? 'WordPress connection saved and enabled.' : 'WordPress Bridge settings saved.');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not save WordPress Bridge settings.');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const { data } = await api.post('/wordpress-bridge/test', {});
      toast.success(data?.health?.site_id ? `Connected to WordPress site ${data.health.site_id}.` : 'WordPress connection is healthy.');
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'WordPress connection test failed.');
    } finally {
      setTesting(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      await api.post('/wordpress-bridge/sync', {});
      toast.success('Catalog synchronization completed.');
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Catalog synchronization failed.');
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect this FloCafe installation from the WordPress site?')) return;
    setDisconnecting(true);
    try {
      const { data } = await api.post('/wordpress-bridge/disconnect', {});
      setStatus(data);
      setSiteUrl('');
      setApiKey('');
      setEnabled(false);
      toast.success('WordPress connection removed.');
    } catch {
      toast.error('Could not disconnect the WordPress Bridge.');
    } finally {
      setDisconnecting(false);
    }
  };

  const connected = Boolean(status?.configured && status?.enabled && status?.last_heartbeat);
  const revisionHealthy = !status || status.applied_catalog_revision >= status.source_catalog_revision;

  return (
    <div className="w-full max-w-4xl space-y-6">
      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-foreground text-lg">WordPress / WooCommerce</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Connect the built-in FloCafe Bridge to the CafeFlo Connect WordPress plugin.
              Product creation and edits in FloCafe are the authoritative source and are pushed automatically.
            </p>
          </div>
          <div className="shrink-0">
            {connected ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Wifi size={14} /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
                <WifiOff size={14} /> Not connected
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-foreground">WordPress site URL</span>
            <input
              type="url"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://example.com"
              className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              Enter the main WordPress URL, not the /wp-json path.
            </span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-foreground">CafeFlo Bridge API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status?.configured ? 'Leave blank to keep the current key' : 'Paste the key from WooCommerce → CafeFlo Connect'}
              autoComplete="new-password"
              className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              FloCafe stores this credential using the operating system secure credential store.
            </span>
          </label>
        </div>

        <label className="flex items-center gap-3 rounded-lg border border-border p-4 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">Enable automatic synchronization</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              New products, edits, availability changes and deletions are detected automatically.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            <Save size={16} /> {saving ? 'Saving…' : 'Save connection'}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={testing || !status?.configured}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <Wifi size={16} /> {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing || !status?.configured}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync catalog now'}
          </button>
          <button
            type="button"
            onClick={disconnect}
            disabled={disconnecting || !status?.configured}
            className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/30 disabled:opacity-50"
          >
            <Link2Off size={16} /> {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center gap-2 mb-4">
          {status?.last_error ? <CircleAlert size={18} className="text-amber-500" /> : <CheckCircle2 size={18} className="text-emerald-500" />}
          <h3 className="font-semibold text-foreground">Connection diagnostics</h3>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <div><span className="text-xs text-muted-foreground">Bridge ID</span><div className="text-sm text-foreground break-all">{status?.bridge_id || '—'}</div></div>
            <div><span className="text-xs text-muted-foreground">WordPress site ID</span><div className="text-sm text-foreground break-all">{status?.remote_site_id || 'Not checked yet'}</div></div>
            <div><span className="text-xs text-muted-foreground">Catalog revision</span><div className="text-sm text-foreground">{status?.source_catalog_revision ?? 0} / {status?.applied_catalog_revision ?? 0}</div></div>
            <div><span className="text-xs text-muted-foreground">Pending sync work</span><div className="text-sm text-foreground">{status?.queue_size ?? 0}</div></div>
            <div><span className="text-xs text-muted-foreground">Last catalog sync</span><div className="text-sm text-foreground">{formatTimestamp(status?.last_catalog_sync || null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Last order poll</span><div className="text-sm text-foreground">{formatTimestamp(status?.last_order_poll || null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Last heartbeat</span><div className="text-sm text-foreground">{formatTimestamp(status?.last_heartbeat || null)}</div></div>
            <div>
              <span className="text-xs text-muted-foreground">Catalog state</span>
              <div className="text-sm text-foreground">{revisionHealthy ? 'Up to date' : 'Waiting for synchronization'}</div>
            </div>
          </div>
        )}

        {status?.last_error && (
          <div className="mt-5 rounded-lg border border-amber-300 bg-amber-500/5 p-4">
            <div className="text-xs font-medium text-amber-700 dark:text-amber-300">Last integration error</div>
            <div className="text-sm text-foreground mt-1 break-words">{status.last_error}</div>
            <div className="text-xs text-muted-foreground mt-1">{formatTimestamp(status.last_error_at)}</div>
          </div>
        )}
      </div>

      <div className="bg-muted/30 rounded-xl border border-border p-5 text-sm text-muted-foreground">
        <strong className="text-foreground">Important:</strong> FloCafe remains the source of truth for the connected catalog.
        When a product is created or edited in FloCafe, its stable FloCafe ID is used to update the matching WooCommerce product;
        products are never matched by name.
      </div>
    </div>
  );
}
