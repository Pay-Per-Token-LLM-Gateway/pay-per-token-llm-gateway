'use client';

import { Plus, Globe, Loader2, AlertTriangle, Send, CheckCircle } from 'lucide-react';
import { useState } from 'react';
import { sendWebhookTest } from '@/lib/api';

const SUPPORTED_EVENTS = ['payment_received', 'request_forwarded', 'verification_failed'] as const;

export default function WebhooksPage() {
  const [showAdd, setShowAdd] = useState(false);
  const [url, setUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    setShowAdd(true);
    setUrl('');
    setTestResult(null);
    setError(null);
  };

  const handleCancel = () => {
    setShowAdd(false);
    setTestResult(null);
    setError(null);
  };

  const handleTest = async () => {
    if (!url.trim()) {
      setError('Please enter a webhook URL');
      return;
    }

    try {
      new URL(url);
    } catch {
      setError('Please enter a valid URL (e.g., https://example.com/webhook)');
      return;
    }

    setTesting(true);
    setError(null);
    setTestResult(null);

    try {
      const result = await sendWebhookTest(url.trim());
      setTestResult({
        success: result.success,
        message: result.success
          ? 'Test webhook sent successfully! Check your endpoint for the test payload.'
          : 'Webhook delivery failed. Verify the URL is correct and reachable.',
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: (err as Error).message,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Webhooks</h1>
          <p className="text-muted-foreground mt-1">
            Configure webhook endpoints for real-time event notifications
          </p>
        </div>
        <button
          onClick={handleAdd}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> Add Webhook
        </button>
      </div>

      {error && (
        <div className="card border-red-800/30 bg-red-950/10">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-red-900/20 rounded-lg shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-400" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-red-400">Error</h3>
              <p className="text-sm text-muted-foreground mt-1">{error}</p>
            </div>
          </div>
        </div>
      )}

      {testResult && (
        <div
          className={
            testResult.success
              ? 'card border-green-800/30 bg-green-950/10'
              : 'card border-red-800/30 bg-red-950/10'
          }
        >
          <div className="flex items-start gap-3">
            <div
              className={
                testResult.success
                  ? 'p-2 bg-green-900/20 rounded-lg shrink-0'
                  : 'p-2 bg-red-900/20 rounded-lg shrink-0'
              }
            >
              {testResult.success ? (
                <CheckCircle className="w-5 h-5 text-green-400" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-red-400" />
              )}
            </div>
            <div className="flex-1">
              <h3
                className={
                  testResult.success ? 'font-medium text-green-400' : 'font-medium text-red-400'
                }
              >
                {testResult.success ? 'Test Successful' : 'Test Failed'}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">{testResult.message}</p>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="card border-green-800/30">
          <h3 className="font-semibold mb-4">Add Webhook Endpoint</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">Webhook URL</label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-service.com/webhook"
                className="w-full px-3 py-2 bg-gray-900 border border-border rounded-lg text-sm focus:outline-none focus:border-green-500/50 transition-colors"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Your endpoint must accept POST requests with JSON payloads.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">Supported Events</label>
              <div className="flex flex-wrap gap-2">
                {SUPPORTED_EVENTS.map((ev) => (
                  <span key={ev} className="badge badge-green text-xs">
                    {ev}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                All webhook endpoints receive all event types. Filter on your server if needed.
              </p>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleTest}
                disabled={testing}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {testing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                {testing ? 'Sending...' : 'Send Test'}
              </button>
              <button
                onClick={handleCancel}
                className="px-4 py-2 bg-muted hover:bg-gray-700 text-foreground rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex flex-col items-center justify-center py-12 gap-4">
          <div className="p-3 bg-muted rounded-full">
            <Globe className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="text-center max-w-md">
            <h3 className="font-medium text-foreground">Configure your webhooks</h3>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              Webhooks let your application receive real-time notifications when events happen on
              the gateway — like payments received, requests forwarded, or verification failures.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
              {SUPPORTED_EVENTS.map((ev) => (
                <span key={ev} className="badge badge-green text-xs">
                  {ev}
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Click &quot;Add Webhook&quot; to test and configure your endpoint.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
