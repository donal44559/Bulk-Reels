import React, { useEffect, useState } from 'react';

// ============================================================
// UpdateNotifier — checks Supabase for new version, shows:
//   - Full-screen blocking modal if update is forced
//   - Dismissible banner otherwise
// Auto-checks on mount + every 30 min.
// User dismissals are remembered per-version in localStorage so we
// don't nag on every relaunch (unless it's a forced update).
// ============================================================

export default function UpdateNotifier() {
  const [info, setInfo] = useState(null); // { hasUpdate, forceUpdate, currentVersion, latestVersion, downloadUrl, releaseNotes }
  const [dismissed, setDismissed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const check = async () => {
    try {
      const res = await window.api.updater.check();
      if (res && res.success && res.hasUpdate) {
        // Was this exact version already dismissed by the user?
        const skipped = localStorage.getItem('update_skip_v') === res.latestVersion;
        setInfo(res);
        setDismissed(skipped && !res.forceUpdate);
      } else {
        setInfo(null);
        setDismissed(false);
      }
    } catch { /* silent */ }
  };

  useEffect(() => {
    check();
    const id = setInterval(check, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const doDownload = async () => {
    if (!info?.downloadUrl) return;
    setDownloading(true);
    try {
      await window.api.updater.openDownload(info.downloadUrl);
    } finally {
      // Keep spinner briefly for feedback
      setTimeout(() => setDownloading(false), 1500);
    }
  };

  const doDismiss = () => {
    if (!info) return;
    localStorage.setItem('update_skip_v', info.latestVersion);
    setDismissed(true);
  };

  if (!info || !info.hasUpdate) return null;

  // ---------- FORCE UPDATE — full-screen modal, cannot dismiss ----------
  if (info.forceUpdate) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6"
           style={{ background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(6px)' }}>
        <div className="max-w-lg w-full rounded-2xl overflow-hidden border-2 border-redx shadow-2xl"
             style={{ background: 'linear-gradient(135deg, #1e293b, #0f172a)' }}>
          <div className="p-6 text-center border-b border-white/10"
               style={{ background: 'linear-gradient(90deg, #dc2626, #f97316)' }}>
            <div className="text-5xl mb-2">⚠</div>
            <h2 className="text-2xl font-bold text-white">Update Required</h2>
            <p className="text-white/80 text-sm mt-1">You must update to continue using the app.</p>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Your version:</span>
              <span className="text-white font-mono">v{info.currentVersion}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Latest version:</span>
              <span className="text-greenx font-mono font-bold">v{info.latestVersion}</span>
            </div>
            {info.releaseNotes && (
              <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                <div className="text-xs uppercase text-slate-400 font-semibold mb-2">What's New</div>
                <div className="text-sm text-slate-200 whitespace-pre-wrap max-h-40 overflow-y-auto">{info.releaseNotes}</div>
              </div>
            )}
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200">
              🔒 Your profiles, cookies, settings, and license will be preserved after the update.
            </div>
            <button
              onClick={doDownload}
              disabled={downloading}
              className="w-full py-3 rounded-lg font-bold text-white transition disabled:opacity-70"
              style={{ background: downloading ? '#475569' : 'linear-gradient(90deg, #06b6d4, #a855f7)' }}
            >
              {downloading ? '⏳ Opening download...' : '⬇ Download Update Now'}
            </button>
            <div className="text-center text-xs text-slate-500">
              Installer opens in your browser. Run it to update the app.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- NORMAL UPDATE — dismissible banner ----------
  if (dismissed) return null;
  return <NormalUpdateBanner info={info} onDownload={doDownload} onDismiss={doDismiss} downloading={downloading} />;
}

function NormalUpdateBanner({ info, onDownload, onDismiss, downloading }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40 w-[92%] max-w-2xl">
      <div className="rounded-xl border border-cyanx/40 shadow-2xl overflow-hidden"
           style={{ background: 'linear-gradient(90deg, rgba(6,182,212,0.15), rgba(168,85,247,0.15)), rgba(15, 23, 42, 0.98)', backdropFilter: 'blur(10px)' }}>
        <div className="flex items-start gap-3 p-4">
          <div className="text-3xl">🎉</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className="font-semibold text-white">New version available!</div>
              <span className="chip bg-cyanx/20 text-cyanx border-cyanx/30 text-[10px]">v{info.latestVersion}</span>
              <span className="text-xs text-slate-500">from v{info.currentVersion}</span>
            </div>
            {info.releaseNotes && !expanded && (
              <button onClick={() => setExpanded(true)} className="text-xs text-cyanx hover:underline">See what's new ▾</button>
            )}
            {info.releaseNotes && expanded && (
              <div className="mt-2 p-2 rounded bg-black/30 text-xs text-slate-200 whitespace-pre-wrap max-h-32 overflow-y-auto">
                {info.releaseNotes}
                <button onClick={() => setExpanded(false)} className="block mt-2 text-cyanx hover:underline">Hide ▴</button>
              </div>
            )}
            <div className="mt-1 text-[11px] text-slate-500">🔒 Your data (profiles, cookies, settings) will be preserved.</div>
          </div>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={onDownload}
              disabled={downloading}
              className="px-4 py-1.5 rounded-lg font-semibold text-white text-sm transition disabled:opacity-70 whitespace-nowrap"
              style={{ background: downloading ? '#475569' : 'linear-gradient(90deg, #06b6d4, #a855f7)' }}
            >
              {downloading ? '⏳ Opening...' : '⬇ Download'}
            </button>
            <button onClick={onDismiss} className="text-xs text-slate-400 hover:text-white transition">
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
