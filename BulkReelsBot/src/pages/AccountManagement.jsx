import React, { useEffect, useState } from 'react';
import api from '../api.js';
import Modal from '../components/Modal.jsx';

export default function AccountManagement() {
  const [history, setHistory] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);

  const refresh = async () => setHistory(await api.importHistory());
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const off = api.onImportProgress && api.onImportProgress((p) => setImportProgress(p));
    return () => off && off();
  }, []);
  const pushToast = (msg, type='info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const doImport = async () => {
    setImporting(true);
    setImportResult(null);
    setImportProgress({ total: 0, done: 0, valid: 0, dead: 0, current: 'reading file...' });
    const res = await api.importExcel();
    setImporting(false);
    setImportProgress(null);
    if (res.canceled) return;
    if (res.success) {
      setImportResult(res);
      pushToast(`✓ ${res.imported} logged in & saved · ${res.dead || 0} skipped`, 'success');
      refresh();
    } else {
      pushToast(res.error || 'Import failed', 'error');
    }
  };

  const openImportFolder = async (folderPath) => {
    const r = await api.importOpenFolder(folderPath);
    if (!r.success) pushToast(r.error || 'Failed to open folder', 'error');
  };

  return (
    <div className="space-y-5">
      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-4">ACCOUNT ACTIONS</div>
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1fr_auto] items-center px-5 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <span className="text-cyanx text-xl">📊</span>
              <div>
                <div className="font-semibold text-white">Import from Excel</div>
                <div className="text-xs text-muted mt-0.5">
                  Each account browser login test → only logged-in accounts saved · Columns: uid, name, group, password, 2fa, cookies, proxy, notes
                </div>
              </div>
            </div>
            <button className="btn-blue" onClick={doImport} disabled={importing}>
              {importing ? 'TESTING LOGIN...' : 'IMPORT EXCEL'}
            </button>
          </div>

          {importProgress && (
            <div className="px-5 py-4 border-b border-border bg-cyanx/5">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold text-cyanx">🌐 Testing login in browsers (3 parallel, headless)...</div>
                <div className="text-xs text-muted font-mono">
                  {importProgress.done} / {importProgress.total || '?'}
                </div>
              </div>
              <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden mb-3">
                <div
                  className="h-full bg-gradient-to-r from-cyanx to-purplex transition-all"
                  style={{ width: `${importProgress.total ? (importProgress.done / importProgress.total * 100) : 0}%` }}
                />
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="bg-greenx/10 border border-greenx/30 rounded px-3 py-2">
                  <div className="text-muted text-[10px]">LOGGED IN</div>
                  <div className="text-greenx font-bold text-lg">{importProgress.valid || 0}</div>
                </div>
                <div className="bg-redx/10 border border-redx/30 rounded px-3 py-2">
                  <div className="text-muted text-[10px]">FAILED</div>
                  <div className="text-redx font-bold text-lg">{importProgress.dead || 0}</div>
                </div>
                <div className="bg-cyanx/10 border border-cyanx/30 rounded px-3 py-2">
                  <div className="text-muted text-[10px]">CURRENT</div>
                  <div className="text-cyanx text-xs truncate mt-1" title={importProgress.current}>
                    {importProgress.current || '—'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {importResult && (
            <div className="px-5 py-4 border-b border-border bg-greenx/5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-greenx">✓ Import complete</div>
                <button className="text-xs text-muted hover:text-white" onClick={() => setImportResult(null)}>× dismiss</button>
              </div>
              <div className="grid grid-cols-4 gap-3 text-sm mb-3">
                <div className="bg-white/5 rounded px-3 py-2 text-center">
                  <div className="text-muted text-[10px] uppercase">Checked</div>
                  <div className="text-white font-bold text-xl">{importResult.total}</div>
                </div>
                <div className="bg-greenx/10 border border-greenx/30 rounded px-3 py-2 text-center">
                  <div className="text-muted text-[10px] uppercase">Valid ✓</div>
                  <div className="text-greenx font-bold text-xl">{importResult.valid}</div>
                </div>
                <div className="bg-redx/10 border border-redx/30 rounded px-3 py-2 text-center">
                  <div className="text-muted text-[10px] uppercase">Dead ✗</div>
                  <div className="text-redx font-bold text-xl">{importResult.dead}</div>
                </div>
                <div className="bg-cyanx/10 border border-cyanx/30 rounded px-3 py-2 text-center">
                  <div className="text-muted text-[10px] uppercase">Saved to DB</div>
                  <div className="text-cyanx font-bold text-xl">{importResult.imported}</div>
                </div>
              </div>
              {importResult.importDir && (
                <div className="flex gap-2 flex-wrap items-center">
                  <button className="btn-ghost text-xs" onClick={() => openImportFolder(importResult.importDir)}>
                    📂 Open Import Folder
                  </button>
                  {importResult.validFile && (
                    <span className="text-xs text-muted flex items-center gap-1">
                      <span className="text-greenx">●</span> valid_accounts.xlsx
                    </span>
                  )}
                  {importResult.deadFile && (
                    <span className="text-xs text-muted flex items-center gap-1">
                      <span className="text-redx">●</span> dead_accounts.xlsx
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-[1fr_auto] items-center px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="text-purplex text-xl">➕</span>
              <span className="font-semibold text-white">Add Account (Manual Login)</span>
            </div>
            <button className="btn-blue" onClick={() => setShowAdd(true)}>ADD ACCOUNT</button>
          </div>
        </div>
      </div>

      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-4">IMPORT HISTORY</div>
        {history.length === 0 ? (
          <div className="text-muted text-sm">No imports yet. Try importing an Excel with columns: <b>uid, name, group, password, 2fa, cookies, proxy, notes</b>.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-muted">
              <tr>
                <th className="p-3 text-left">Import Date/Time</th>
                <th className="p-3 text-center">Profiles Imported</th>
                <th className="p-3 text-right">Source</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id} className="table-row">
                  <td className="p-3 text-greenx">{h.imported_at}</td>
                  <td className="p-3 text-cyanx text-center font-semibold">{h.profiles_imported}</td>
                  <td className="p-3 text-right text-muted">{h.source_file || '—'}</td>
                  <td className="p-3 text-right"><button className="btn-blue !px-3 !py-1 text-xs">VIEW</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && <AddAccountModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); pushToast('Profile saved', 'success'); refresh(); }} />}

      {toast && (
        <div className={`fixed bottom-5 right-5 px-4 py-2 rounded-lg shadow-xl text-sm z-50
          ${toast.type==='error' ? 'bg-rose-600' : toast.type==='success' ? 'bg-emerald-600' : 'bg-slate-700'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function AddAccountModal({ onClose, onSaved }) {
  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('Default');
  const [password, setPassword] = useState('');
  const [twofa, setTwofa] = useState('');
  const [cookies, setCookies] = useState('');
  const [proxy, setProxy] = useState('');
  const [notes, setNotes] = useState('');
  const [groups, setGroups] = useState([]);

  useEffect(() => { api.listGroups().then(setGroups); }, []);

  const save = async () => {
    if (!uid.trim()) return alert('UID required');
    const res = await api.upsertProfile({
      uid: uid.trim(), name: name || `Profile ${uid}`, group_name: group,
      password, two_fa: twofa, cookies, proxy, notes,
    });
    if (res.success) onSaved(); else alert(res.error || 'Failed');
  };

  return (
    <Modal title="Add Account" onClose={onClose} wide
      footer={<>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-green" onClick={save}>Save</button>
      </>}>
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">UID *</label><input className="input" value={uid} onChange={e => setUid(e.target.value)} placeholder="100016105712398" /></div>
        <div><label className="label">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} /></div>
        <div>
          <label className="label">Group</label>
          <select className="input" value={group} onChange={e => setGroup(e.target.value)}>
            {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
          </select>
        </div>
        <div><label className="label">Password</label><input className="input" value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div><label className="label">2FA Secret</label><input className="input" value={twofa} onChange={e => setTwofa(e.target.value)} placeholder="TOTP secret (optional)" /></div>
        <div><label className="label">Proxy</label><input className="input" value={proxy} onChange={e => setProxy(e.target.value)} placeholder="host:port:user:pass" /></div>
        <div className="col-span-2"><label className="label">Cookies (JSON or string)</label><textarea className="input" rows="3" value={cookies} onChange={e => setCookies(e.target.value)} /></div>
        <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={notes} onChange={e => setNotes(e.target.value)} /></div>
      </div>
    </Modal>
  );
}
