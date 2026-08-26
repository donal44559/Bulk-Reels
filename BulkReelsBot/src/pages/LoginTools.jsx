import React, { useEffect, useState } from 'react';
import api from '../api.js';

export default function LoginTools() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [toast, setToast] = useState(null);
  // User settings — persist in localStorage
  const [headless, setHeadless] = useState(() => {
    const v = localStorage.getItem('lt_headless');
    return v === null ? true : v === 'true';
  });
  const [concurrency, setConcurrency] = useState(() => {
    const v = parseInt(localStorage.getItem('lt_concurrency'));
    return isNaN(v) || v < 1 ? 3 : Math.min(20, v);
  });
  const [safeMode, setSafeMode] = useState(() => {
    const v = localStorage.getItem('lt_safeMode');
    return v === null ? true : v === 'true';   // default: safe mode ON
  });

  useEffect(() => { localStorage.setItem('lt_headless', String(headless)); }, [headless]);
  useEffect(() => { localStorage.setItem('lt_concurrency', String(concurrency)); }, [concurrency]);
  useEffect(() => { localStorage.setItem('lt_safeMode', String(safeMode)); }, [safeMode]);

  useEffect(() => {
    const off = api.onLoginToolsProgress && api.onLoginToolsProgress((p) => setProgress(p));
    return () => off && off();
  }, []);

  const pushToast = (msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const start = async () => {
    setRunning(true);
    setResult(null);
    setProgress({ total: 0, done: 0, success: 0, failed: 0, current: 'reading file...' });
    const res = await api.loginToolsRun({ headless, concurrency, speed: safeMode ? 'safe' : 'fast' });
    setRunning(false);
    setProgress(null);
    if (res.canceled) return;
    if (res.success) {
      setResult(res);
      pushToast(`✓ ${res.successCount} success · ${res.failedCount} failed`, 'success');
    } else {
      pushToast(res.error || 'Login Tools failed', 'error');
    }
  };

  const stop = async () => {
    await api.loginToolsStop();
    pushToast('Stop requested — will finish current accounts', 'info');
  };

  const openFolder = async (folderPath) => {
    const r = await api.loginToolsOpenFolder(folderPath);
    if (!r.success) pushToast(r.error || 'Failed to open folder', 'error');
  };

  return (
    <div className="space-y-5">
      {/* Hero panel */}
      <div className="panel p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🔐</span>
            <div>
              <div className="text-lg font-bold text-white">Facebook Login Tools</div>
              <div className="text-xs text-muted mt-0.5">
                Standalone tool — Excel select koro, prottek row cookies+password diye login test hobe,
                sesh e Success + Failed alada Excel sheet e save hobe.
              </div>
            </div>
          </div>
          {!running ? (
            <button className="btn-blue whitespace-nowrap" onClick={start}>
              📊 SELECT EXCEL & START
            </button>
          ) : (
            <button className="btn-red whitespace-nowrap" onClick={stop}>
              ■ STOP
            </button>
          )}
        </div>

        <div className="text-xs text-muted bg-black/30 rounded-lg px-4 py-3 border border-border">
          <div className="font-semibold text-cyanx mb-1">Excel columns needed:</div>
          <div><b>uid</b> (required) · <b>pass</b> (optional) · <b>cookies</b> (optional)</div>
          <div className="mt-2 text-[11px]">
            <b>Flow per account:</b> 1) Cookies login try → 2) Fail hole (or password page ashle) password diye try →
            3) Success hole fresh cookies capture kore Success sheet e save · Fail hole reason soho Failed sheet e save
          </div>
        </div>
      </div>

      {/* Settings panel */}
      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-4">⚙ Settings</div>

        {/* Safe Mode — full width, most important */}
        <div className={`rounded-lg px-4 py-4 border mb-4 ${
          safeMode ? 'bg-greenx/10 border-greenx/40' : 'bg-redx/10 border-redx/40'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-semibold text-white flex items-center gap-2">
                {safeMode ? '🛡 Safe Mode' : '⚡ Fast Mode'}
                <span className={`text-[10px] px-2 py-0.5 rounded ${safeMode ? 'bg-greenx/30 text-greenx' : 'bg-redx/30 text-redx'}`}>
                  {safeMode ? 'RECOMMENDED' : 'RISKY'}
                </span>
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {safeMode
                  ? 'Human-like delays 2-7s + slow typing + random stagger → FB bot detect korte parbe na'
                  : 'No delays, fast typing, instant clicks → FB bot detect korte pare, id suspend risk'}
              </div>
            </div>
            <button
              type="button"
              disabled={running}
              onClick={() => setSafeMode(v => !v)}
              className={`relative w-14 h-7 rounded-full transition-colors ${
                safeMode ? 'bg-greenx' : 'bg-redx'
              } ${running ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${safeMode ? 'translate-x-7' : 'translate-x-0.5'}`} />
            </button>
          </div>
          <div className="text-[10px] text-muted mt-2">
            {safeMode
              ? '⏱ ~8-15 sec per account · id safety > speed'
              : '⚡ ~3-5 sec per account · speed > id safety (only use with disposable accounts)'}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Headless toggle */}
          <div className="bg-black/30 rounded-lg px-4 py-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-semibold text-white">Headless Mode</div>
                <div className="text-[11px] text-muted mt-0.5">
                  {headless
                    ? '👻 Browsers invisible (fast, background)'
                    : '👁 Browsers visible (dekha jabe kaj korche)'}
                </div>
              </div>
              <button
                type="button"
                disabled={running}
                onClick={() => setHeadless(v => !v)}
                className={`relative w-14 h-7 rounded-full transition-colors ${
                  headless ? 'bg-greenx' : 'bg-white/20'
                } ${running ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <span
                  className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                    headless ? 'translate-x-7' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="text-[10px] text-muted mt-2">
              {headless
                ? 'Tip: Headless off korle prottek browser screen e dekha jabe (slow but debug korar jonno valo)'
                : 'Warning: Onek browser open hole screen full hoye jabe — kom concurrency use koro'}
            </div>
          </div>

          {/* Concurrency slider */}
          <div className="bg-black/30 rounded-lg px-4 py-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-semibold text-white">Parallel Browsers</div>
                <div className="text-[11px] text-muted mt-0.5">
                  Ekshathe koto browser kaj korbe
                </div>
              </div>
              <div className="text-2xl font-bold text-cyanx font-mono min-w-[3ch] text-right">
                {concurrency}
              </div>
            </div>
            <input
              type="range"
              min="1"
              max="20"
              step="1"
              value={concurrency}
              disabled={running}
              onChange={(e) => setConcurrency(parseInt(e.target.value))}
              className="w-full accent-cyanx"
            />
            <div className="flex justify-between text-[10px] text-muted mt-1">
              <span>1-2 (safest)</span>
              <span>3-5 (balanced)</span>
              <span>10+ (risky)</span>
            </div>
            <div className="flex gap-1 mt-3">
              {[1, 3, 5, 10, 15, 20].map(n => (
                <button
                  key={n}
                  disabled={running}
                  onClick={() => setConcurrency(n)}
                  className={`flex-1 text-[11px] py-1 rounded transition-colors ${
                    concurrency === n
                      ? 'bg-cyanx text-black font-bold'
                      : 'bg-white/5 text-muted hover:bg-white/10'
                  } ${running ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Progress panel */}
      {progress && (
        <div className="panel p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-cyanx">
              🌐 {safeMode ? '🛡 Safe' : '⚡ Fast'} · {concurrency} parallel · {headless ? 'headless' : 'visible'}...
            </div>
            <div className="text-xs text-muted font-mono">
              {progress.done} / {progress.total || '?'}
            </div>
          </div>
          <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-gradient-to-r from-cyanx to-purplex transition-all"
              style={{ width: `${progress.total ? (progress.done / progress.total * 100) : 0}%` }}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-greenx/10 border border-greenx/30 rounded-lg px-4 py-3">
              <div className="text-muted text-[10px] uppercase tracking-wider">Success ✓</div>
              <div className="text-greenx font-bold text-2xl">{progress.success || 0}</div>
            </div>
            <div className="bg-redx/10 border border-redx/30 rounded-lg px-4 py-3">
              <div className="text-muted text-[10px] uppercase tracking-wider">Failed ✗</div>
              <div className="text-redx font-bold text-2xl">{progress.failed || 0}</div>
            </div>
            <div className="bg-cyanx/10 border border-cyanx/30 rounded-lg px-4 py-3">
              <div className="text-muted text-[10px] uppercase tracking-wider">Current</div>
              <div className="text-cyanx text-xs truncate mt-1" title={progress.current}>
                {progress.current || '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Result panel */}
      {result && (
        <div className="panel p-5 bg-greenx/5 border-greenx/30">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-greenx">
              ✓ Complete{result.stopped ? ' (stopped by user)' : ''}
            </div>
            <button className="text-xs text-muted hover:text-white" onClick={() => setResult(null)}>× dismiss</button>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white/5 rounded-lg px-4 py-3 text-center">
              <div className="text-muted text-[10px] uppercase">Total Rows</div>
              <div className="text-white font-bold text-2xl">{result.total}</div>
            </div>
            <div className="bg-greenx/10 border border-greenx/30 rounded-lg px-4 py-3 text-center">
              <div className="text-muted text-[10px] uppercase">Success ✓</div>
              <div className="text-greenx font-bold text-2xl">{result.successCount}</div>
            </div>
            <div className="bg-redx/10 border border-redx/30 rounded-lg px-4 py-3 text-center">
              <div className="text-muted text-[10px] uppercase">Failed ✗</div>
              <div className="text-redx font-bold text-2xl">{result.failedCount}</div>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {result.outDir && (
              <button className="btn-ghost text-xs" onClick={() => openFolder(result.outDir)}>
                📂 Open Result Folder
              </button>
            )}
            {result.successFile && (
              <span className="text-xs text-muted flex items-center gap-1">
                <span className="text-greenx">●</span> Login_Success.xlsx
              </span>
            )}
            {result.failedFile && (
              <span className="text-xs text-muted flex items-center gap-1">
                <span className="text-redx">●</span> Login_Failed.xlsx
              </span>
            )}
          </div>
        </div>
      )}

      {/* Info footer */}
      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-3">HOW IT WORKS</div>
        <ol className="text-sm text-muted space-y-2 list-decimal list-inside">
          <li>Excel select koro — prothom sheet er first row e header (uid, pass, cookies)</li>
          <li>Prottek row er jonno ekta headless browser open hobe (3 parallel)</li>
          <li>Cookies thakle first e cookies inject kore login try korbe</li>
          <li>Cookies fail hole ba password page dekhale → pass diye login try korbe</li>
          <li>Password login success hole fresh cookies capture kore Success sheet e save korbe</li>
          <li>Failed sheet e uid, pass, cookies ar <b>fail_reason</b> column save hobe</li>
        </ol>
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-2xl text-sm font-medium ${
          toast.type === 'success' ? 'bg-greenx/90 text-black' :
          toast.type === 'error'   ? 'bg-redx/90 text-white' :
                                     'bg-cyanx/90 text-black'
        }`}>{toast.msg}</div>
      )}
    </div>
  );
}
