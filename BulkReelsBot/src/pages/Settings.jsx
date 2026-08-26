import React, { useEffect, useState } from 'react';
import api from '../api.js';

export default function Settings({ onChanged }) {
  const [groups, setGroups] = useState([]);
  const [settings, setSettings] = useState({});
  const [newGroup, setNewGroup] = useState('');
  const [toast, setToast] = useState(null);
  const push = (msg, type='info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 2500); };

  const refresh = async () => {
    setGroups(await api.listGroups());
    setSettings(await api.getSettings());
  };
  useEffect(() => { refresh(); }, []);

  const update = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  const save = async () => {
    await api.saveSettings(settings);
    push('Settings saved', 'success');
    onChanged && onChanged(settings);
  };

  const addG = async () => {
    if (!newGroup.trim()) return;
    await api.addGroup(newGroup.trim());
    setNewGroup(''); refresh();
  };
  const editG = async (g) => {
    const n = prompt('New name for group:', g.name);
    if (!n || n === g.name) return;
    await api.renameGroup(g.name, n); refresh();
  };
  const delG = async (g) => {
    if (g.name === 'Default') return push('Cannot delete Default', 'error');
    if (!confirm(`Delete group "${g.name}"? Profiles will move to Default.`)) return;
    await api.deleteGroup(g.name); refresh();
  };
  const exportCsv = async () => {
    const res = await api.exportCsv();
    if (res.success) push('CSV exported: ' + res.path, 'success');
    else if (!res.canceled) push(res.error || 'Export failed', 'error');
  };

  return (
    <div className="space-y-5">
      <div className="panel p-6">
        <h2 className="text-2xl font-bold text-white">Application Settings</h2>
        <p className="text-muted text-sm">Configure advanced bot parameters here.</p>
      </div>

      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-4">MANAGE GROUP NAMES</div>
        <div className="flex gap-2 mb-4">
          <input className="input" placeholder="New group name" value={newGroup} onChange={e => setNewGroup(e.target.value)} />
          <button className="btn-primary" onClick={addG}>+ Add Group</button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted">
            <tr>
              <th className="p-3 text-left">Group Name</th>
              <th className="p-3 text-left">Profiles Count</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.name} className="table-row">
                <td className="p-3 text-purplex font-semibold">{g.name}</td>
                <td className="p-3 text-slate-300">{g.count}</td>
                <td className="p-3 text-right">
                  <button className="btn-blue !px-3 !py-1 text-xs mr-2" onClick={() => editG(g)}>EDIT</button>
                  <button className="btn-red !px-3 !py-1 text-xs" onClick={() => delG(g)}>DELETE</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-4">SYSTEM PREFERENCES</div>
        <Row label="Headless Mode" desc="Run browser invisibly in the background">
          <input type="checkbox" className="w-5 h-5 accent-cyan-400" checked={settings.headless_mode === 'true'}
                 onChange={e => update('headless_mode', e.target.checked ? 'true' : 'false')} />
        </Row>
        <Row label="Page Load Timeout" desc="Maximum time to wait for a page to load (seconds)">
          <input className="input w-24" type="number" value={settings.page_load_timeout || 60}
                 onChange={e => update('page_load_timeout', e.target.value)} />
        </Row>
        <Row label="Concurrent Profiles" desc="How many browsers can run in parallel">
          <input className="input w-24" type="number" value={settings.concurrent_profiles || 3}
                 onChange={e => update('concurrent_profiles', e.target.value)} />
        </Row>
        <Row label="Action Delay (ms)" desc="Delay between profile actions in a task">
          <input className="input w-32" type="number" value={settings.action_delay_ms || 800}
                 onChange={e => update('action_delay_ms', e.target.value)} />
        </Row>
        <Row label="Default Start URL" desc="Where every browser opens by default (per-profile URL overrides this)">
          <input className="input w-96" value={settings.default_start_url || 'https://www.facebook.com/'}
                 onChange={e => update('default_start_url', e.target.value)} placeholder="https://www.facebook.com/" />
        </Row>
        <Row label="Username" desc="Displayed in the header">
          <input className="input w-64" value={settings.username || ''} onChange={e => update('username', e.target.value)} />
        </Row>
        <Row label="License Days Left" desc="Shown in the header (informational)">
          <input className="input w-24" type="number" value={settings.license_days_left || 0}
                 onChange={e => update('license_days_left', e.target.value)} />
        </Row>
        <Row label="Export Reports" desc="Export all profiles + statuses to CSV">
          <button className="btn-blue" onClick={exportCsv}>EXPORT CSV</button>
        </Row>

        <div className="flex justify-end mt-4">
          <button className="btn-green" onClick={save}>Save Settings</button>
        </div>
      </div>

      {toast && (
        <div className={`fixed bottom-5 right-5 px-4 py-2 rounded-lg shadow-xl text-sm z-50
          ${toast.type==='error' ? 'bg-rose-600' : toast.type==='success' ? 'bg-emerald-600' : 'bg-slate-700'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Row({ label, desc, children }) {
  return (
    <div className="flex items-center gap-4 py-4 border-b border-border last:border-b-0">
      <div className="flex-1">
        <div className="text-white font-semibold">{label}</div>
        <div className="text-muted text-xs">{desc}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}
