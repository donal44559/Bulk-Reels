import React, { useState } from 'react';

export default function ActivationScreen({ error: initialError, onActivated }) {
  const [username, setUsername] = useState('');
  const [key, setKey]           = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(initialError || '');

  const submit = async (e) => {
    e && e.preventDefault();
    if (!username.trim() || !key.trim()) {
      setError('Username and activation key required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await window.api.auth.activate({
        username: username.trim(),
        activation_key: key.trim(),
      });
      if (res.success) {
        onActivated && onActivated(res.user);
      } else {
        setError(res.error || 'Activation failed');
      }
    } catch (e) {
      setError(e.message || 'Activation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6"
         style={{ background: 'linear-gradient(135deg, #0b1220 0%, #1e293b 100%)' }}>
      <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-4"
               style={{ background: 'linear-gradient(135deg, #06b6d4, #a855f7)' }}>
            <span className="text-4xl">🎬</span>
          </div>
          <h1 className="text-3xl font-bold text-white mb-1">Bulk Reels Upload Pro</h1>
          <p className="text-sm text-slate-400">Activate your license to continue</p>
        </div>

        {/* Form */}
        <form onSubmit={submit}
              className="panel p-6 space-y-4 rounded-2xl border border-white/10"
              style={{ background: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(10px)' }}>
          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 mb-2 font-semibold">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="e.g. eusuf"
              autoFocus
              disabled={busy}
              className="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:border-cyanx transition"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 mb-2 font-semibold">
              Activation Key
            </label>
            <input
              type="text"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX-YYYY"
              disabled={busy}
              className="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white placeholder-slate-500 font-mono text-sm focus:outline-none focus:border-cyanx transition"
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              ⚠ {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-3 rounded-lg font-semibold text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: busy ? '#475569' : 'linear-gradient(90deg, #06b6d4, #a855f7)' }}
          >
            {busy ? 'Activating...' : 'Activate License'}
          </button>

          <div className="text-center text-xs text-slate-500 pt-2 border-t border-white/5">
            Need help? Contact admin for a license key.
          </div>
        </form>

        <div className="mt-6 text-center text-xs text-slate-600">
          © {new Date().getFullYear()} Bulk Reels Upload Pro — DEVELOPED BY RAKIB
        </div>
      </div>
    </div>
  );
}
