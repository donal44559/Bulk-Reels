import React, { useEffect, useState } from 'react';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import LiveTerminal from './pages/LiveTerminal.jsx';
import ProfileManagement from './pages/ProfileManagement.jsx';
import AccountManagement from './pages/AccountManagement.jsx';
import LoginTools from './pages/LoginTools.jsx';
import Settings from './pages/Settings.jsx';
import ActivationScreen from './pages/ActivationScreen.jsx';
import AdminPanel from './pages/AdminPanel.jsx';
import UpdateNotifier from './components/UpdateNotifier.jsx';
import api from './api.js';

const TITLES = {
  dashboard: 'Dashboard Overview',
  terminal:  'Live Terminal',
  profiles:  'Profile Management',
  accounts:  'Account Management',
  loginTools:'Facebook Login Tools',
  settings:  'Application Settings',
  admin:     'Admin Panel',
};

export default function App() {
  // ---------- AUTH GATE STATE ----------
  // authState: 'checking' | 'needs-activation' | 'active'
  const [authState, setAuthState] = useState('checking');
  const [authUser, setAuthUser]   = useState(null);
  const [authError, setAuthError] = useState('');

  const doVerify = async () => {
    try {
      const res = await window.api.auth.verify();
      if (res.success) {
        setAuthUser(res.user);
        setAuthState('active');
        setAuthError('');
      } else {
        setAuthUser(null);
        setAuthState('needs-activation');
        setAuthError(res.error || '');
      }
    } catch (e) {
      setAuthUser(null);
      setAuthState('needs-activation');
      setAuthError(e.message || 'Verification failed');
    }
  };

  useEffect(() => { doVerify(); }, []);

  // Background re-verify every 30 minutes to catch admin-side block/expiry
  useEffect(() => {
    if (authState !== 'active') return;
    const id = setInterval(() => { doVerify(); }, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [authState]);

  const handleLogout = async () => {
    await window.api.auth.logout();
    // Also lock admin panel if it was unlocked
    try { await window.api.admin.logout(); } catch {}
    setAuthUser(null);
    setAuthState('needs-activation');
    setAuthError('');
  };

  // ---------- APP STATE ----------
  const [page, setPage] = useState('dashboard');
  const [profileFilter, setProfileFilter] = useState('all');
  const [settings, setSettings] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (authState === 'active') api.getSettings().then(setSettings);
  }, [authState]);

  // Compute days-left for header display
  const daysLeft = authUser?.expires_at
    ? Math.max(0, Math.ceil((new Date(authUser.expires_at).getTime() - Date.now()) / 86400000))
    : 0;

  // Enrich settings passed to Layout with real user info so the header renders it
  const settingsWithUser = {
    ...settings,
    _user_name:      authUser?.full_name || authUser?.username || 'User',
    _user_days_left: daysLeft,
    _is_admin:       !!authUser?.is_admin,
    _on_logout:      handleLogout,
  };

  // Guard: non-admin user should never see admin page even if page state
  // somehow becomes 'admin' (persisted state, dev tools, etc.). Silently
  // redirect back to dashboard.
  useEffect(() => {
    if (authState === 'active' && page === 'admin' && !authUser?.is_admin) {
      setPage('dashboard');
    }
  }, [authState, page, authUser]);

  const onNavigate = (key) => setPage(key);
  const onFilterNavigate = (filter) => { setProfileFilter(filter); setPage('profiles'); };
  const onRefresh = () => setRefreshKey(k => k + 1);

  const headerExtra = page === 'profiles' ? (
    <div className="flex items-center gap-2 ml-3">
      <span className="chip">Filter: {
        profileFilter === 'all' ? 'All' :
        (typeof profileFilter === 'string' && profileFilter.startsWith('group:'))
          ? `Group — ${profileFilter.slice('group:'.length)}`
          : profileFilter
      }</span>
    </div>
  ) : null;

  // ---------- RENDER ----------
  if (authState === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center"
           style={{ background: 'linear-gradient(135deg, #0b1220 0%, #1e293b 100%)' }}>
        <div className="text-center">
          <div className="inline-block w-12 h-12 border-4 border-cyanx border-t-transparent rounded-full animate-spin mb-4"></div>
          <div className="text-slate-400">Verifying license...</div>
        </div>
      </div>
    );
  }

  if (authState === 'needs-activation') {
    return <ActivationScreen error={authError} onActivated={(u) => { setAuthUser(u); setAuthState('active'); setAuthError(''); }} />;
  }

  return (
    <>
      <UpdateNotifier />
      <Layout page={page} onNavigate={onNavigate} title={TITLES[page]}
              headerExtra={headerExtra} settings={settingsWithUser} onRefresh={onRefresh}>
        {page === 'dashboard' && <Dashboard key={'d'+refreshKey} onFilterNavigate={onFilterNavigate} />}
        {page === 'terminal'  && <LiveTerminal key={'t'+refreshKey} />}
        {page === 'profiles'  && <ProfileManagement key={'p'+refreshKey} initialFilter={profileFilter} onNavigate={onNavigate} />}
        {page === 'accounts'  && <AccountManagement key={'a'+refreshKey} />}
        {page === 'loginTools'&& <LoginTools key={'l'+refreshKey} />}
        {page === 'settings'  && <Settings key={'s'+refreshKey} onChanged={setSettings} />}
        {page === 'admin'     && <AdminPanel key={'ad'+refreshKey} />}
      </Layout>
    </>
  );
}
