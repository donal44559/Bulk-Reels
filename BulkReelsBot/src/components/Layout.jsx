import React from 'react';
import api from '../api.js';

const NAV = [
  { key: 'dashboard', label: 'Dashboard & Filters', icon: '🏠' },
  { key: 'terminal',  label: 'Live Terminal',       icon: '💻' },
  { key: 'profiles',  label: 'Profile Management',  icon: '👥' },
  { key: 'accounts',  label: 'Account Management',  icon: '💼' },
  { key: 'loginTools',label: 'FB Login Tools',       icon: '🔐' },
  { key: 'admin',     label: 'Admin Panel',          icon: '👑', adminOnly: true },
  { key: 'settings',  label: 'Settings',            icon: '⚙' },
];

export default function Layout({ page, onNavigate, children, title, headerExtra, settings, onRefresh }) {
  // Filter out admin-only items for non-admin users. This is the single
  // gate for hiding the Admin Panel entry from regular users. The IPC
  // handlers on the main-process side additionally verify the admin
  // password before doing any privileged operation, so even a tampered
  // renderer can't create/delete users without the password.
  const visibleNav = NAV.filter(n => !n.adminOnly || settings?._is_admin);

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <aside className="w-64 bg-panel border-r border-border flex flex-col">
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-2">
            <div className="text-2xl">📱</div>
            <div>
              <div className="text-[15px] font-extrabold leading-tight bg-gradient-to-r from-cyanx to-pinkx bg-clip-text text-transparent">
                Bulk Reels Upload<br/>Pro
              </div>
            </div>
          </div>
        </div>

        <nav className="px-2 flex-1 overflow-auto">
          {visibleNav.map(n => (
            <button key={n.key}
              onClick={() => onNavigate(n.key)}
              className={`side-item ${page === n.key ? 'active' : ''}`}>
              <span className="text-base w-5 text-center">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-3">
          <div className="mx-1 px-3 py-2 rounded-md border border-cyanx/40 text-cyanx text-[11px] font-bold tracking-wider text-center">
            DEVELOPED BY : RAKIB | V1.5
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header card */}
        <div className="p-5 pb-4">
          <div className="panel px-5 py-4 flex items-center gap-4">
            <h1 className="h-title">{title}</h1>
            {headerExtra}
            <div className="flex-1" />
            <button className="btn-ghost" onClick={onRefresh}>
              <span>🔄</span> REFRESH DATA
            </button>
            <div className="flex items-center gap-2 text-sm text-purplex ml-2">
              <span>👤</span>
              <span className="font-semibold">{settings?._user_name || settings?.username || 'User'}</span>
            </div>
            <div className="text-slate-500">|</div>
            <div className="text-muted text-sm">EXPIRE</div>
            <div className={`font-bold text-sm ${
              (settings?._user_days_left ?? 30) <= 3 ? 'text-redx' :
              (settings?._user_days_left ?? 30) <= 7 ? 'text-orangex' : 'text-greenx'
            }`}>{settings?._user_days_left ?? 30} Days Left</div>
            <button className="btn-red" onClick={() => settings?._on_logout && settings._on_logout()}>LOGOUT</button>
          </div>
        </div>

        <div className="px-5 pb-5 flex-1 overflow-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
