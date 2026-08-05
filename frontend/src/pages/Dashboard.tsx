import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, Send, AlertTriangle, Mail } from 'lucide-react';
import StatsCard from '../components/StatsCard';
import { uploadApi } from '../api/upload.api';
import toast from 'react-hot-toast';
import { DashboardStats, ProviderUsage } from '../types';

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [providerUsage, setProviderUsage] = useState<ProviderUsage[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>({});
  const [togglingProvider, setTogglingProvider] = useState<string | null>(null);

  useEffect(() => {
    uploadApi
      .getDashboardStats()
      .then((res) => setStats(res.data))
      .catch(() => setStats({ totalUploads: 0, totalTemplates: 0, totalEmailsSent: 0, totalFailedEmails: 0 }))
      .finally(() => setLoading(false));

    uploadApi
      .getProviderUsage()
      .then((res) => setProviderUsage(res.data.usage))
      .catch(() => setProviderUsage([]))
      .finally(() => setUsageLoading(false));

    uploadApi
      .getProviderSettings()
      .then((res) =>
        setProviderEnabled(
          Object.fromEntries(res.data.settings.map((s) => [s.provider, s.enabled]))
        )
      )
      .catch(() => setProviderEnabled({}));
  }, []);

  const handleToggleProvider = async (provider: string, nextEnabled: boolean) => {
    setTogglingProvider(provider);
    const previous = providerEnabled[provider];
    setProviderEnabled((prev) => ({ ...prev, [provider]: nextEnabled }));
    try {
      await uploadApi.setProviderEnabled(provider, nextEnabled);
      toast.success(`${provider.toUpperCase()} ${nextEnabled ? 'enabled' : 'disabled'}`);
    } catch {
      setProviderEnabled((prev) => ({ ...prev, [provider]: previous }));
      toast.error(`Failed to update ${provider}`);
    } finally {
      setTogglingProvider(null);
    }
  };

  const admin = JSON.parse(localStorage.getItem('desire_admin') || '{}');

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="text-gray-500 mt-1">
          Welcome back, <span className="text-brand-400">{admin.name || 'Admin'}</span>
        </p>
      </div>

      {/* Stats Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="glass-card p-6 animate-pulse">
              <div className="h-4 bg-white/10 rounded w-24 mb-4" />
              <div className="h-8 bg-white/10 rounded w-16" />
            </div>
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatsCard
            title="Total Uploads"
            value={stats.totalUploads}
            icon={<Upload className="w-6 h-6" />}
            color="indigo"
            onClick={() => navigate('/uploads')}
          />
          <StatsCard
            title="Templates"
            value={stats.totalTemplates}
            icon={<FileText className="w-6 h-6" />}
            color="amber"
            onClick={() => navigate('/templates')}
          />
          <StatsCard
            title="Emails Sent"
            value={stats.totalEmailsSent}
            icon={<Send className="w-6 h-6" />}
            color="emerald"
            onClick={() => navigate('/delivery-logs?status=sent')}
          />
          <StatsCard
            title="Failed Emails"
            value={stats.totalFailedEmails}
            icon={<AlertTriangle className="w-6 h-6" />}
            color="rose"
            onClick={() => navigate('/delivery-logs?status=failed')}
          />
        </div>
      ) : null}

      {/* Email Provider Capacity */}
      <div>
        <h2 className="section-title mb-4">Email Provider Capacity (Today)</h2>
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 text-xs font-semibold text-gray-400 uppercase tracking-wider bg-white/[0.01]">
                  <th className="px-6 py-3">Provider</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Sent Today</th>
                  <th className="px-6 py-3">Daily Limit</th>
                  <th className="px-6 py-3">Remaining</th>
                  <th className="px-6 py-3">Enabled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-sm text-gray-300">
                {usageLoading ? (
                  [...Array(3)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-6 py-3" colSpan={6}>
                        <div className="h-4 bg-white/10 rounded w-full" />
                      </td>
                    </tr>
                  ))
                ) : providerUsage.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-gray-500">
                      <Mail className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      Provider usage unavailable
                    </td>
                  </tr>
                ) : (
                  providerUsage.map((p) => {
                    const isLow = p.remainingToday !== null && p.dailyLimit !== null && p.remainingToday / p.dailyLimit < 0.15;
                    const enabled = providerEnabled[p.provider] !== false;
                    return (
                      <tr key={p.provider} className="hover:bg-white/[0.03] transition-colors">
                        <td className="px-6 py-3 font-semibold text-white uppercase">{p.provider}</td>
                        <td className="px-6 py-3">
                          {p.configured ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg border bg-emerald-500/15 text-emerald-400 border-emerald-500/20 text-xs font-medium">
                              Configured
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg border bg-gray-500/15 text-gray-400 border-gray-500/20 text-xs font-medium">
                              Not configured
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3">{p.sentToday}</td>
                        <td className="px-6 py-3">{p.dailyLimit === null ? 'Unlimited' : p.dailyLimit}</td>
                        <td className={`px-6 py-3 font-semibold ${isLow ? 'text-red-400' : 'text-white'}`}>
                          {p.remainingToday === null ? '—' : p.remainingToday}
                        </td>
                        <td className="px-6 py-3">
                          <button
                            type="button"
                            disabled={!p.configured || togglingProvider === p.provider}
                            onClick={() => handleToggleProvider(p.provider, !enabled)}
                            title={!p.configured ? 'Not configured — add its API key first' : undefined}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                              enabled ? 'bg-brand-500' : 'bg-white/10'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                enabled ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="section-title mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <a href="/uploads" className="glass-card-hover p-6 group block">
            <Upload className="w-8 h-8 text-brand-400 mb-3 transition-transform group-hover:scale-110" />
            <h3 className="font-semibold text-white">Upload Contacts</h3>
            <p className="text-sm text-gray-500 mt-1">Upload an Excel file with contacts</p>
          </a>
          <a href="/templates/create" className="glass-card-hover p-6 group block">
            <FileText className="w-8 h-8 text-emerald-400 mb-3 transition-transform group-hover:scale-110" />
            <h3 className="font-semibold text-white">Create Template</h3>
            <p className="text-sm text-gray-500 mt-1">Design a new email template</p>
          </a>
        </div>
      </div>
    </div>
  );
}
