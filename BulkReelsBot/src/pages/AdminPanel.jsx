import React, { useEffect, useState } from 'react';
import Modal from '../components/Modal.jsx';

export default function AdminPanel() {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [busy, setBusy]         = useState(false);

  useEffect(() => {
    window.api.admin.isUnlocked().then(r => setUnlocked(!!r.unlocked));
  }, []);

  const unlock = async (e) => {
    e && e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await window.api.admin.login({ password });
      if (res.success) { setUnlocked(true); setPassword(''); }
      else setError(res.error || 'Login failed');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const lock = async () => {
    await window.api.admin.logout();
    setUnlocked(false);
  };

  if (!unlocked) {
    return (
      <div className="max-w-md mx-auto mt-10">
        <div className="panel p-8 rounded-2xl text-center">
          <div className="text-5xl mb-4">🔐</div>
          <h2 className="text-2xl font-bold text-white mb-2">Admin Panel</h2>
          <p className="text-sm text-slate-400 mb-6">Enter admin password to unlock user management.</p>
          <form onSubmit={unlock} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Admin password"
              autoFocus
              disabled={busy}
              className="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:border-cyanx"
            />
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                ⚠ {error}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full py-3 rounded-lg font-semibold text-white transition disabled:opacity-50"
              style={{ background: busy ? '#475569' : 'linear-gradient(90deg, #06b6d4, #a855f7)' }}
            >
              {busy ? 'Verifying...' : 'Unlock Admin Panel'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <AdminDashboard onLock={lock} />;
}

function AdminDashboard({ onLock }) {
  const [tab, setTab]       = useState('users'); // 'users' | 'updates'
  const [users, setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [toast, setToast]   = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [extendFor, setExtendFor]   = useState(null);
  const [showChangePw, setShowChangePw] = useState(false);

  const pushToast = (msg, type='info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await window.api.admin.listUsers();
      if (res.success) setUsers(res.users || []);
      else setError(res.error || 'Failed to load users');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  const doDelete = async (u) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    const res = await window.api.admin.deleteUser({ id: u.id });
    if (res.success) { pushToast(`Deleted ${u.username}`, 'success'); refresh(); }
    else pushToast(res.error || 'Delete failed', 'error');
  };

  const doBlock = async (u) => {
    const res = await window.api.admin.setBlocked({ id: u.id, blocked: !u.is_blocked });
    if (res.success) { pushToast(u.is_blocked ? 'Unblocked' : 'Blocked', 'success'); refresh(); }
    else pushToast(res.error || 'Failed', 'error');
  };

  const doResetDevice = async (u) => {
    if (!confirm(`Reset device lock for "${u.username}"? They can activate on a new device.`)) return;
    const res = await window.api.admin.resetDevice({ id: u.id });
    if (res.success) { pushToast('Device lock reset', 'success'); refresh(); }
    else pushToast(res.error || 'Failed', 'error');
  };

  const doToggleAdmin = async (u) => {
    const msg = u.is_admin
      ? `Revoke admin access from "${u.username}"? They will lose access to the Admin Panel.`
      : `Grant admin access to "${u.username}"? They will see the Admin Panel in their sidebar and be able to manage other users.`;
    if (!confirm(msg)) return;
    const res = await window.api.admin.setIsAdmin({ id: u.id, is_admin: !u.is_admin });
    if (res.success) { pushToast(u.is_admin ? 'Admin revoked' : 'Made admin', 'success'); refresh(); }
    else pushToast(res.error || 'Failed', 'error');
  };

  const daysLeft = (iso) => {
    const ms = new Date(iso).getTime() - Date.now();
    return Math.ceil(ms / 86400000);
  };

  return (
    <div className="space-y-4">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-semibold ${
          toast.type === 'success' ? 'bg-green-500/90 text-white' :
          toast.type === 'error'   ? 'bg-red-500/90 text-white'   : 'bg-blue-500/90 text-white'
        }`}>{toast.msg}</div>
      )}

      <div className="panel p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-white">👑 Admin Panel</h1>
            <p className="text-sm text-slate-400">Manage licensed users and app updates.</p>
          </div>
          <div className="flex gap-2">
            {tab === 'users' && (<>
              <button onClick={() => setShowCreate(true)} className="btn-blue">+ Add User</button>
              <button onClick={refresh} className="btn-ghost">↻ Refresh</button>
            </>)}
            <button onClick={() => setShowChangePw(true)} className="btn-ghost">🔑 Change Password</button>
            <button onClick={onLock} className="btn-red">Lock Panel</button>
          </div>
        </div>
        {/* Tab bar */}
        <div className="flex gap-1 border-b border-border">
          <TabBtn active={tab==='users'} onClick={() => setTab('users')} icon="👥" label="Users" />
          <TabBtn active={tab==='updates'} onClick={() => setTab('updates')} icon="🚀" label="App Updates" />
        </div>
      </div>

      {error && tab === 'users' && (
        <div className="panel p-4 bg-red-500/10 border-red-500/30 text-red-300">⚠ {error}</div>
      )}

      {tab === 'updates' ? (
        <UpdatesTab pushToast={pushToast} />
      ) : (
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted border-b border-border">
            <tr>
              <th className="p-3 text-left">#</th>
              <th className="p-3 text-left">Username</th>
              <th className="p-3 text-left">Full Name</th>
              <th className="p-3 text-left">Activation Key</th>
              <th className="p-3 text-left">Expires</th>
              <th className="p-3 text-center">Status</th>
              <th className="p-3 text-left">Last Seen</th>
              <th className="p-3 text-left">Device</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="9" className="p-10 text-center text-muted">Loading...</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan="9" className="p-10 text-center text-muted">No users yet. Click "+ Add User" to create one.</td></tr>
            ) : users.map((u, i) => {
              const dl = daysLeft(u.expires_at);
              const expired = dl <= 0;
              return (
                <tr key={u.id} className="table-row border-b border-border/50">
                  <td className="p-3 text-slate-300">{i + 1}</td>
                  <td className="p-3 text-white font-semibold">
                    {u.username}
                    {u.is_admin && (
                      <span className="ml-2 chip bg-purple-500/20 text-purplex border-purple-500/30 text-[10px]" title="Has Admin Panel access">👑 ADMIN</span>
                    )}
                  </td>
                  <td className="p-3 text-slate-300">{u.full_name || '—'}</td>
                  <td className="p-3">
                    <code className="text-xs text-cyanx font-mono">{u.activation_key}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(u.activation_key); pushToast('Key copied', 'success'); }}
                      className="ml-2 text-xs text-slate-400 hover:text-white" title="Copy">📋</button>
                  </td>
                  <td className="p-3 text-slate-300">
                    <div className="text-xs">{new Date(u.expires_at).toLocaleDateString()}</div>
                    <div className={`text-xs font-semibold ${expired ? 'text-redx' : dl <= 7 ? 'text-orangex' : 'text-greenx'}`}>
                      {expired ? `Expired ${-dl}d ago` : `${dl} days left`}
                    </div>
                  </td>
                  <td className="p-3 text-center">
                    {u.is_blocked
                      ? <span className="chip bg-red-500/20 text-redx border-red-500/30">Blocked</span>
                      : expired
                      ? <span className="chip bg-orange-500/20 text-orangex border-orange-500/30">Expired</span>
                      : <span className="chip bg-green-500/20 text-greenx border-green-500/30">Active</span>}
                  </td>
                  <td className="p-3 text-xs text-slate-400">
                    {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—'}
                  </td>
                  <td className="p-3 text-xs text-slate-400">
                    {u.machine_id
                      ? <span title={u.machine_id}>🔒 {u.machine_id.slice(0, 8)}…</span>
                      : <span className="text-slate-600">unbound</span>}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button onClick={() => setExtendFor(u)} className="btn-blue !px-2 !py-1 text-xs mr-1" title="Extend expiry">+Days</button>
                    <button onClick={() => doBlock(u)} className={`!px-2 !py-1 text-xs mr-1 ${u.is_blocked ? 'btn-blue' : 'btn-orange'}`}>
                      {u.is_blocked ? 'Unblock' : 'Block'}
                    </button>
                    {u.machine_id && (
                      <button onClick={() => doResetDevice(u)} className="btn-ghost !px-2 !py-1 text-xs mr-1" title="Allow re-activation on new device">Reset Dev</button>
                    )}
                    <button onClick={() => doToggleAdmin(u)}
                            className={`!px-2 !py-1 text-xs mr-1 ${u.is_admin ? 'btn-ghost' : 'btn-purple'}`}
                            title={u.is_admin ? 'Revoke admin access' : 'Grant admin access'}>
                      {u.is_admin ? '−Admin' : '+Admin'}
                    </button>
                    <button onClick={() => doDelete(u)} className="btn-red !px-2 !py-1 text-xs">Del</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={(u) => { pushToast(`Created ${u.username}`, 'success'); refresh(); }} />}
      {extendFor && <ExtendModal user={extendFor} onClose={() => setExtendFor(null)} onExtended={() => { pushToast('Expiry extended', 'success'); refresh(); }} />}
      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} onDone={() => pushToast('Password changed', 'success')} />}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [days, setDays]         = useState(30);
  const [notes, setNotes]       = useState('');
  const [customKey, setCustomKey] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [created, setCreated]   = useState(null);

  const submit = async (e) => {
    e && e.preventDefault();
    if (!username.trim()) { setError('Username required'); return; }
    setBusy(true); setError('');
    try {
      const res = await window.api.admin.createUser({
        username: username.trim(),
        full_name: fullName.trim(),
        days: parseInt(days, 10),
        notes: notes.trim(),
        activation_key: customKey.trim() || undefined,
        is_admin: makeAdmin,
      });
      if (res.success) {
        setCreated(res.user);
        onCreated && onCreated(res.user);
      } else {
        setError(res.error || 'Failed');
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={created ? 'User Created ✓' : 'Add New User'}>
      {created ? (
        <div className="space-y-4 max-w-md">
          <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30">
            <div className="text-greenx font-semibold mb-2">✓ Send these to the user:</div>
            <div className="space-y-2 text-sm">
              <div><span className="text-slate-400">Username:</span> <code className="text-white font-mono">{created.username}</code></div>
              <div><span className="text-slate-400">Activation Key:</span></div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-cyanx font-mono text-sm p-2 rounded bg-black/30 break-all">{created.activation_key}</code>
                <button onClick={() => { navigator.clipboard.writeText(created.activation_key); }} className="btn-blue !px-3 !py-2 text-xs">Copy</button>
              </div>
              <div><span className="text-slate-400">Valid until:</span> <span className="text-white">{new Date(created.expires_at).toLocaleString()}</span></div>
            </div>
          </div>
          <button onClick={onClose} className="btn-blue w-full">Done</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3 max-w-md">
          <Field label="Username *"><input value={username} onChange={e=>setUsername(e.target.value)} autoFocus disabled={busy} className="input-dark" placeholder="e.g. rahim_ahmed" /></Field>
          <Field label="Full Name"><input value={fullName} onChange={e=>setFullName(e.target.value)} disabled={busy} className="input-dark" placeholder="Rahim Ahmed" /></Field>
          <Field label="Validity (days)">
            <div className="flex gap-2">
              {[7, 15, 30, 90].map(d => (
                <button type="button" key={d} onClick={() => setDays(d)}
                        className={`px-3 py-2 rounded-lg text-sm font-semibold border transition ${days == d ? 'bg-cyanx/20 border-cyanx text-cyanx' : 'border-border text-slate-300 hover:bg-white/5'}`}>
                  {d} days
                </button>
              ))}
              <input type="number" min="1" value={days} onChange={e=>setDays(e.target.value)} disabled={busy} className="input-dark flex-1" />
            </div>
          </Field>
          <Field label="Custom Activation Key (optional — auto-generated if blank)">
            <input value={customKey} onChange={e=>setCustomKey(e.target.value)} disabled={busy} className="input-dark font-mono text-sm" placeholder="Leave blank for auto" />
          </Field>
          <Field label="Notes"><input value={notes} onChange={e=>setNotes(e.target.value)} disabled={busy} className="input-dark" placeholder="Optional notes" /></Field>
          <label className="flex items-center gap-2 p-3 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:bg-white/10 transition">
            <input type="checkbox" checked={makeAdmin} onChange={e=>setMakeAdmin(e.target.checked)} disabled={busy} className="w-4 h-4" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-white">👑 Grant Admin Panel access</div>
              <div className="text-xs text-slate-400">This user will see the Admin Panel in their sidebar and can manage other users.</div>
            </div>
          </label>
          {error && <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm">⚠ {error}</div>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
            <button type="submit" disabled={busy} className="btn-blue flex-1">{busy ? 'Creating...' : 'Create User'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function ExtendModal({ user, onClose, onExtended }) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e && e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await window.api.admin.extendUser({ id: user.id, days: parseInt(days, 10) });
      if (res.success) { onExtended && onExtended(); onClose(); }
      else setError(res.error || 'Failed');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={`Extend "${user.username}"`}>
      <form onSubmit={submit} className="space-y-4 max-w-md">
        <div className="text-sm text-slate-400">
          Current expiry: <span className="text-white">{new Date(user.expires_at).toLocaleString()}</span>
        </div>
        <Field label="Extend by (days)">
          <div className="flex gap-2 flex-wrap">
            {[7, 15, 30, 90].map(d => (
              <button type="button" key={d} onClick={() => setDays(d)}
                      className={`px-3 py-2 rounded-lg text-sm font-semibold border transition ${days == d ? 'bg-cyanx/20 border-cyanx text-cyanx' : 'border-border text-slate-300 hover:bg-white/5'}`}>
                +{d} days
              </button>
            ))}
            <input type="number" min="1" value={days} onChange={e=>setDays(e.target.value)} disabled={busy} className="input-dark flex-1" />
          </div>
        </Field>
        <div className="text-xs text-slate-500">
          Note: If already expired, extension starts from today. Otherwise added on top of current expiry.
          Extending automatically unblocks the user.
        </div>
        {error && <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm">⚠ {error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button type="submit" disabled={busy} className="btn-blue flex-1">{busy ? 'Extending...' : `Extend +${days} days`}</button>
        </div>
      </form>
    </Modal>
  );
}

function ChangePasswordModal({ onClose, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e && e.preventDefault();
    if (pw.length < 6) { setError('At least 6 characters'); return; }
    if (pw !== pw2) { setError('Passwords do not match'); return; }
    setBusy(true); setError('');
    try {
      const res = await window.api.admin.changePassword({ newPassword: pw });
      if (res.success) { onDone && onDone(); onClose(); }
      else setError(res.error || 'Failed');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title="Change Admin Password">
      <form onSubmit={submit} className="space-y-3 max-w-md">
        <Field label="New Password"><input type="password" value={pw} onChange={e=>setPw(e.target.value)} autoFocus disabled={busy} className="input-dark" /></Field>
        <Field label="Confirm Password"><input type="password" value={pw2} onChange={e=>setPw2(e.target.value)} disabled={busy} className="input-dark" /></Field>
        {error && <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm">⚠ {error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button type="submit" disabled={busy} className="btn-blue flex-1">{busy ? 'Saving...' : 'Change Password'}</button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1 font-semibold">{label}</label>
      {children}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick}
      className={`px-4 py-2 text-sm font-semibold border-b-2 transition ${
        active ? 'border-cyanx text-cyanx' : 'border-transparent text-slate-400 hover:text-white'
      }`}>
      <span className="mr-1">{icon}</span>{label}
    </button>
  );
}

// ============================================================
// UPDATES TAB — manage app_versions rows
// ============================================================
function UpdatesTab({ pushToast }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [showAdd, setShowAdd]   = useState(false);
  const [currentVersion, setCurrentVersion] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [listRes, cur] = await Promise.all([
        window.api.admin.listVersions(),
        window.api.updater.current(),
      ]);
      if (listRes.success) setVersions(listRes.versions || []);
      else setError(listRes.error || 'Failed to load versions');
      setCurrentVersion(cur?.version || '');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const toggleActive = async (v) => {
    const res = await window.api.admin.updateVersion({ id: v.id, patch: { is_active: !v.is_active } });
    if (res.success) { pushToast(v.is_active ? 'Deactivated' : 'Activated', 'success'); refresh(); }
    else pushToast(res.error || 'Failed', 'error');
  };
  const toggleForce = async (v) => {
    const res = await window.api.admin.updateVersion({ id: v.id, patch: { is_force: !v.is_force } });
    if (res.success) { pushToast(v.is_force ? 'Force removed' : 'Force update ON', 'success'); refresh(); }
    else pushToast(res.error || 'Failed', 'error');
  };
  const doDelete = async (v) => {
    if (!confirm(`Delete version ${v.version}? Users won't be notified about it anymore.`)) return;
    const res = await window.api.admin.deleteVersion({ id: v.id });
    if (res.success) { pushToast(`Deleted v${v.version}`, 'success'); refresh(); }
    else pushToast(res.error || 'Failed', 'error');
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="panel p-4 bg-red-500/10 border-red-500/30 text-red-300">⚠ {error}</div>
      )}

      <div className="panel p-4 flex items-center justify-between">
        <div className="text-sm">
          <span className="text-slate-400">Installed version:</span>{' '}
          <span className="text-cyanx font-mono font-bold">v{currentVersion || '?'}</span>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-blue">🚀 Publish New Update</button>
      </div>

      <div className="panel p-4 bg-blue-500/5 border-blue-500/20 text-xs text-blue-200 space-y-1">
        <div className="font-semibold text-blue-300">📖 How to publish an update</div>
        <ol className="list-decimal ml-5 space-y-0.5">
          <li>Build a new installer: <code className="text-cyanx">npm run pack:win</code> → gives <code className="text-cyanx">release/BulkReelsUploadPro-Setup-x.x.x.exe</code></li>
          <li>Upload the .exe to Google Drive / Mega / any file host and get a direct-download link</li>
          <li>Click "🚀 Publish New Update" above and paste the link</li>
          <li>All users get notified within 30 min (or on next app launch)</li>
          <li>User data (profiles, cookies, settings, license) is automatically preserved on install</li>
        </ol>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted border-b border-border">
            <tr>
              <th className="p-3 text-left">Version</th>
              <th className="p-3 text-left">Download URL</th>
              <th className="p-3 text-center">Status</th>
              <th className="p-3 text-center">Force</th>
              <th className="p-3 text-left">Published</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" className="p-10 text-center text-muted">Loading...</td></tr>
            ) : versions.length === 0 ? (
              <tr><td colSpan="6" className="p-10 text-center text-muted">No versions yet. Click "Publish New Update" to add one.</td></tr>
            ) : versions.map(v => (
              <tr key={v.id} className="table-row border-b border-border/50">
                <td className="p-3">
                  <div className="font-mono font-bold text-white">v{v.version}</div>
                  {v.release_notes && <div className="text-xs text-slate-400 max-w-xs truncate" title={v.release_notes}>{v.release_notes}</div>}
                </td>
                <td className="p-3">
                  <a href="#" onClick={(e) => { e.preventDefault(); window.api.updater.openDownload(v.download_url); }}
                     className="text-cyanx text-xs hover:underline break-all">{v.download_url.slice(0, 60)}{v.download_url.length > 60 ? '…' : ''}</a>
                </td>
                <td className="p-3 text-center">
                  {v.is_active
                    ? <span className="chip bg-green-500/20 text-greenx border-green-500/30">🟢 Active</span>
                    : <span className="chip bg-slate-500/20 text-slate-400 border-slate-500/30">⚫ Inactive</span>}
                </td>
                <td className="p-3 text-center">
                  {v.is_force
                    ? <span className="chip bg-red-500/20 text-redx border-red-500/30">🔒 Forced</span>
                    : <span className="text-slate-600 text-xs">optional</span>}
                </td>
                <td className="p-3 text-xs text-slate-400">{new Date(v.published_at).toLocaleString()}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  <button onClick={() => toggleActive(v)} className={`!px-2 !py-1 text-xs mr-1 ${v.is_active ? 'btn-ghost' : 'btn-blue'}`}>
                    {v.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button onClick={() => toggleForce(v)} className={`!px-2 !py-1 text-xs mr-1 ${v.is_force ? 'btn-ghost' : 'btn-orange'}`}>
                    {v.is_force ? '−Force' : '+Force'}
                  </button>
                  <button onClick={() => doDelete(v)} className="btn-red !px-2 !py-1 text-xs">Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && <AddVersionModal
        currentVersion={currentVersion}
        onClose={() => setShowAdd(false)}
        onAdded={(v) => { pushToast(`Published v${v.version}`, 'success'); refresh(); }}
      />}
    </div>
  );
}

function AddVersionModal({ currentVersion, onClose, onAdded }) {
  const [version, setVersion] = useState('');
  const [url, setUrl]         = useState('');
  const [notes, setNotes]     = useState('');
  const [isForce, setIsForce] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');

  const submit = async (e) => {
    e && e.preventDefault();
    if (!version.trim()) { setError('Version required (e.g. 1.5.0)'); return; }
    if (!url.trim()) { setError('Download URL required'); return; }
    setBusy(true); setError('');
    try {
      const res = await window.api.admin.addVersion({
        version: version.trim(),
        download_url: url.trim(),
        release_notes: notes.trim(),
        is_force: isForce,
      });
      if (res.success) { onAdded && onAdded(res.version); onClose(); }
      else setError(res.error || 'Failed');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title="🚀 Publish New Update">
      <form onSubmit={submit} className="space-y-3 max-w-lg">
        <div className="text-xs text-slate-400">
          Current installed: <span className="text-cyanx font-mono">v{currentVersion || '?'}</span> · New version must be higher.
        </div>
        <Field label="Version Number * (semver: MAJOR.MINOR.PATCH)">
          <input value={version} onChange={e=>setVersion(e.target.value)} autoFocus disabled={busy}
                 className="input-dark font-mono" placeholder="e.g. 1.5.0" />
        </Field>
        <Field label="Download URL * (Google Drive direct link / Mega / etc.)">
          <input value={url} onChange={e=>setUrl(e.target.value)} disabled={busy}
                 className="input-dark font-mono text-xs" placeholder="https://drive.google.com/uc?export=download&id=..." />
        </Field>
        <Field label="Release Notes (what's new — shown to users)">
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} disabled={busy} rows="5"
                 className="input-dark text-sm"
                 placeholder="• Fixed comment bot timeout&#10;• Added new group filter&#10;• Improved upload speed" />
        </Field>
        <label className="flex items-center gap-2 p-3 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:bg-white/10 transition">
          <input type="checkbox" checked={isForce} onChange={e=>setIsForce(e.target.checked)} disabled={busy} className="w-4 h-4" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-white">🔒 Force update (blocking)</div>
            <div className="text-xs text-slate-400">Users won't be able to use the app until they install this update. Use only for critical fixes.</div>
          </div>
        </label>
        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-200">
          ⚠ Publishing this will DEACTIVATE all previous versions. Only this new version will be served to users.
        </div>
        {error && <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm">⚠ {error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button type="submit" disabled={busy} className="btn-blue flex-1">{busy ? 'Publishing...' : '🚀 Publish Update'}</button>
        </div>
      </form>
    </Modal>
  );
}
