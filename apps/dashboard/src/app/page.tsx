'use client';

import {
  Zap,
  DollarSign,
  Activity,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Users,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useAnalytics, useProvider, useTimeSeries } from '@/lib/hooks';
import { ErrorState } from '@/components/error-state';
import { format } from 'date-fns';

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3000';

/** Convert a stroop amount string to USDC units without float precision loss. */
function formatStroops(stroops: string | undefined): string {
  if (!stroops || stroops === '0') return '0';
  const n = BigInt(stroops);
  const whole = n / 10000000n;
  const frac = (n % 10000000n).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export default function DashboardPage() {
  const { data: provider } = useProvider();
  const { data: stats, isLoading, error, refetch } = useAnalytics(provider?.id);
  const { data: timeSeriesData } = useTimeSeries(provider?.id, 60, 24);

  // Build chart data from the time series API only — no fake/demo data.
  const chartData =
    timeSeriesData && timeSeriesData.length > 0
      ? timeSeriesData.map((point) => ({
          name: format(new Date(point.timestamp), 'MMM d, HH:mm'),
          paid: point.paidRequests,
          unpaid: point.unpaidRequests,
        }))
      : [];

  if (error) {
    const isUnauthenticated = (error as Error).message?.includes('401');
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Overview of your x402 LLM gateway</p>
        </div>
        <ErrorState
          title={isUnauthenticated ? 'Authentication required' : 'Failed to load analytics'}
          message={
            isUnauthenticated ? (
              'Your session has expired or you are not logged in.'
            ) : (
              <>
                {(error as Error).message}. Make sure the gateway is running at{' '}
                <code className="bg-gray-800 px-1 rounded">{GATEWAY_URL}</code>.
              </>
            )
          }
          onRetry={() => refetch()}
          unauthenticated={isUnauthenticated}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Overview of your x402 LLM gateway</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="stat-label">Total Revenue</span>
            <div className="p-2 bg-green-900/20 rounded-lg">
              <DollarSign className="w-5 h-5 text-green-400" />
            </div>
          </div>
          <div className="stat-value text-green-400">
            {isLoading ? '...' : `${formatStroops(stats?.totalRevenue)} USDC`}
          </div>
          <div className="flex items-center gap-1 mt-2 text-xs text-green-400">
            <ArrowUpRight className="w-3 h-3" /> Live on-chain
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="stat-label">Paid Requests</span>
            <div className="p-2 bg-blue-900/20 rounded-lg">
              <Zap className="w-5 h-5 text-blue-400" />
            </div>
          </div>
          <div className="stat-value">
            {isLoading ? '...' : (stats?.paidRequests ?? 0).toLocaleString()}
          </div>
          <div className="flex items-center gap-1 mt-2 text-xs text-blue-400">
            <ArrowUpRight className="w-3 h-3" /> {stats?.successRate.toFixed(1)}% success rate
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="stat-label">Avg Response</span>
            <div className="p-2 bg-purple-900/20 rounded-lg">
              <Activity className="w-5 h-5 text-purple-400" />
            </div>
          </div>
          <div className="stat-value">
            {isLoading ? '...' : `${stats?.averageResponseTime ?? 0}ms`}
          </div>
          <div className="flex items-center gap-1 mt-2 text-xs text-purple-400">
            <TrendingUp className="w-3 h-3" /> Per-request latency
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="stat-label">Unpaid (402s)</span>
            <div className="p-2 bg-yellow-900/20 rounded-lg">
              <ArrowDownRight className="w-5 h-5 text-yellow-400" />
            </div>
          </div>
          <div className="stat-value">
            {isLoading ? '...' : (stats?.unpaidRequests ?? 0).toLocaleString()}
          </div>
          <div className="flex items-center gap-1 mt-2 text-xs text-yellow-400">
            <ArrowDownRight className="w-3 h-3" /> Awaiting payment
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Request Volume</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" stroke="#6b7280" fontSize={12} />
              <YAxis stroke="#6b7280" fontSize={12} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#111827',
                  border: '1px solid #1f2937',
                  borderRadius: '8px',
                  color: '#f9fafb',
                }}
              />
              <Line
                type="monotone"
                dataKey="paid"
                stroke="#22c55e"
                strokeWidth={2}
                dot={{ fill: '#22c55e', r: 4 }}
                name="Paid"
              />
              <Line
                type="monotone"
                dataKey="unpaid"
                stroke="#eab308"
                strokeWidth={2}
                dot={{ fill: '#eab308', r: 4 }}
                name="Unpaid"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Users className="w-5 h-5 text-green-400" />
            Top Paying Callers
          </h2>
          <div className="space-y-3">
            {isLoading ? (
              <p className="text-muted-foreground text-sm py-4 text-center">Loading...</p>
            ) : (
              (stats?.topCallers?.slice(0, 5).map((caller, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-2 border-b border-border last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-blue-500 flex items-center justify-center text-xs font-bold">
                      {caller.address.slice(0, 2)}
                    </div>
                    <span className="text-sm font-mono">
                      {caller.address.slice(0, 8)}...{caller.address.slice(-4)}
                    </span>
                  </div>
                  <div className="text-sm">
                    <span className="text-green-400 font-medium">
                      {formatStroops(caller.totalSpent)} USDC
                    </span>
                    <span className="text-muted-foreground ml-2">{caller.requestCount} req</span>
                  </div>
                </div>
              )) ?? null)
            )}
            {!isLoading && !stats?.topCallers?.length && (
              <p className="text-muted-foreground text-sm py-4 text-center">No callers yet</p>
            )}
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            Top Routes by Revenue
          </h2>
          <div className="space-y-3">
            {isLoading ? (
              <p className="text-muted-foreground text-sm py-4 text-center">Loading...</p>
            ) : (
              (stats?.topRoutes?.slice(0, 5).map((route, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-2 border-b border-border last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-xs font-bold">
                      {i + 1}
                    </div>
                    <span className="text-sm font-mono">{route.path}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-blue-400 font-medium">
                      {formatStroops(route.revenue)} USDC
                    </span>
                    <span className="text-muted-foreground ml-2">{route.requestCount} req</span>
                  </div>
                </div>
              )) ?? null)
            )}
            {!isLoading && !stats?.topRoutes?.length && (
              <p className="text-muted-foreground text-sm py-4 text-center">No routes yet</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
