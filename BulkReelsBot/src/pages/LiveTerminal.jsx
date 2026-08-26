import React, { useEffect, useRef, useState } from 'react';
import api from '../api.js';

export default function LiveTerminal() {
  const [lines, setLines] = useState(['Waiting for tasks...']);
  const [state, setState] = useState({ running: false, totalActive: 0, remaining: 0, success: 0, failed: 0, results: [], workers: {} });
  const [, setTick] = useState(0);
  const termRef = useRef(null);
  const resultsRef = useRef([]);

  // Tick every second so worker card elapsed times re-render
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const off1 = api.onLog((l) => setLines((old) => {
      const next = [...old, l].slice(-1000);
      return next;
    }));
    const off2 = api.onTaskUpdate((s) => {
      setState((prev) => {
        // Accumulate recent results
        if (s.results && s.results.length) {
          resultsRef.current = [...resultsRef.current, ...s.results].slice(-10);
        }
        if (!s.running && s.remaining === 0) {
          // task ended
        }
        return { ...prev, ...s, results: resultsRef.current };
      });
    });
    return () => { off1 && off1(); off2 && off2(); };
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [lines]);

  const copy = () => {
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
  };
  const clear = () => { setLines(['Cleared.']); resultsRef.current = []; setState(s => ({ ...s, results: [] })); };

  return (
    <div className="space-y-5">
      <div className="panel p-5">
        <div className="grid grid-cols-4 gap-6">
          <Metric label="TOTAL ACTIVE" value={state.totalActive} color="text-cyanx" />
          <Metric label="REMAINING"    value={state.remaining}    color="text-purplex" />
          <Metric label="SUCCESS"      value={state.success}      color="text-greenx" />
          <Metric label="FAILED"       value={state.failed}       color="text-redx" />
        </div>
        {state.currentInfo && (
          <div className="mt-4 p-3 rounded-lg bg-purplex/10 border border-purplex/40 text-purplex font-semibold text-center">
            🎯 {state.currentInfo}
          </div>
        )}
      </div>

      {/* Per-worker live cards — one card per parallel browser */}
      {state.workers && Object.keys(state.workers).length > 0 && (
        <div className="panel p-5">
          <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-3">
            🌐 LIVE BROWSERS ({Object.values(state.workers).filter(w => w.status === 'running').length} running)
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {Object.values(state.workers)
              .sort((a, b) => a.workerId - b.workerId)
              .map((w) => <WorkerCard key={w.workerId} w={w} />)}
          </div>
        </div>
      )}

      <div className="panel p-5">
        <div ref={termRef} className="terminal">
          {lines.map((l, i) => (
            <div key={i} className={
              /✓|success|ok\b/i.test(l) ? 'ok' :
              /✗|fail|error/i.test(l) ? 'fail' :
              /warn/i.test(l) ? 'warn' :
              /━━━|starting|finished|opened|closed/i.test(l) ? 'info' : ''
            }>{l}</div>
          ))}
        </div>
        <div className="flex justify-center gap-3 mt-5">
          <button className="btn-red"    onClick={() => api.stopTask()}>⏹ STOP TASK</button>
          <button className="btn-orange" onClick={() => api.pauseTask()}>⏸ PAUSE TASK</button>
          <button className="btn-green"  onClick={() => api.resumeTask()}>▶ RESUME TASK</button>
          <button className="btn-primary" onClick={copy}>📋 COPY LOG</button>
          <button className="btn-ghost" onClick={clear}>Clear</button>
        </div>
      </div>

      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-4">FINAL RESULTS (LAST 10)</div>
        {(!state.results || state.results.length === 0) ? (
          <div className="text-muted text-sm">No results yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-muted">
              <tr>
                <th className="p-2 text-left">Profile</th>
                <th className="p-2 text-left">UID</th>
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-left">Time</th>
                <th className="p-2 text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {state.results.slice(-10).reverse().map((r, i) => (
                <tr key={i} className="table-row">
                  <td className="p-2 text-white">{r.name}</td>
                  <td className="p-2 text-muted font-mono text-xs">{r.uid}</td>
                  <td className="p-2">
                    {r.ok
                      ? <span className="text-greenx">OK</span>
                      : r.stopped
                        ? <span className="text-slate-400">STOPPED</span>
                        : <span className="text-redx">FAILED</span>}
                  </td>
                  <td className="p-2 text-muted">{r.ms} ms</td>
                  <td className="p-2 text-redx">{r.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, color }) {
  return (
    <div className="text-center">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-4xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function WorkerCard({ w }) {
  const statusColor = {
    running: 'border-cyanx bg-cyanx/10 text-cyanx',
    done:    'border-greenx bg-greenx/10 text-greenx',
    failed:  'border-redx bg-redx/10 text-redx',
    stopped: 'border-slate-500 bg-slate-700/20 text-slate-300',
    idle:    'border-white/10 bg-white/5 text-muted',
  }[w.status] || 'border-white/10 bg-white/5 text-muted';

  const statusEmoji = {
    running: '🟢',
    done:    '✅',
    failed:  '❌',
    stopped: '⏹',
    idle:    '⚪',
  }[w.status] || '⚪';

  const elapsed = w.startedAt ? Math.round((Date.now() - w.startedAt) / 1000) : 0;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className={`rounded-lg border p-3 ${statusColor}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="font-bold text-white text-sm">
          {statusEmoji} Browser W{w.workerId}
        </div>
        <div className="text-xs text-muted font-mono">{mm}:{ss}</div>
      </div>
      <div className="text-white text-sm font-semibold truncate" title={w.profileName}>
        {w.profileName}
      </div>
      <div className="text-muted text-xs font-mono truncate mb-2">UID: {w.profileUid}</div>
      {w.currentInfo && (
        <div className="text-xs bg-black/30 rounded p-2 mt-1 truncate" title={w.currentInfo}>
          {w.currentInfo}
        </div>
      )}
      {w.status === 'failed' && w.error && (
        <div className="text-redx text-xs mt-1 truncate" title={w.error}>⚠ {w.error}</div>
      )}
    </div>
  );
}
