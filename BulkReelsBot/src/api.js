// src/api.js — uses window.api in Electron, falls back to localStorage mock in browser preview

const isElectron = typeof window !== 'undefined' && !!window.api;

// -------- Mock helpers (browser preview only) --------
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

function seedMock() {
  if (LS.get('_seeded')) return;
  const groups = [{ name: 'Default', count: 0 }, { name: 'News 1', count: 72 }, { name: 'News 2', count: 117 }];
  const profileStatuses = ['Active', 'Active', 'Limited', 'At Risk', 'Active', 'Suspended', 'Active', 'Limited', 'Active', 'Active'];
  const pageStatuses = ['Page has some issues', 'Page has no issues', 'Page has no issues', 'Page has no issues', 'Page has no issues'];
  const names = ['Sharmika Nupur','Oindita Mahi','Farzana Lubna','Madhusha Rupa','Rishita Jui','Anwita Piya','Nusrat Jahan','Tania Rahman','Sadia Islam','Mim Chowdhury'];
  const rows = [];
  for (let i = 0; i < 189; i++) {
    rows.push({
      uid: `1000${(16105712398 + i * 137).toString().slice(0, 11)}`,
      name: names[i % names.length],
      group_name: i < 72 ? 'News 1' : 'News 2',
      profile_status: profileStatuses[i % profileStatuses.length],
      page_status: pageStatuses[i % pageStatuses.length],
      page_name: names[i % names.length],
      pages_count: (i % 3) + 1,
      upload_status: 'Upload Success',
      proxy: '', notes: '',
      last_used: null,
    });
  }
  LS.set('_profiles', rows);
  LS.set('_groups', groups);
  LS.set('_settings', {
    headless_mode: 'true', page_load_timeout: '60',
    concurrent_profiles: '3', action_delay_ms: '800',
    username: 'member110_A34', license_days_left: '30',
  });
  LS.set('_history', [
    { id: 1, imported_at: '16-08-2026 07:19:58', profiles_imported: 68, source_file: 'batch1.xlsx' },
    { id: 2, imported_at: '15-08-2026 12:47:05', profiles_imported: 49, source_file: 'batch2.xlsx' },
    { id: 3, imported_at: '15-08-2026 12:27:07', profiles_imported: 45, source_file: 'batch3.xlsx' },
  ]);
  LS.set('_seeded', true);
}
if (!isElectron) seedMock();

function computeStats(profiles) {
  const c = {};
  const pg = { 'Page has some issues': 0, 'Page has no issues': 0, 'No Page Create': 0, 'Checkpoint': 0 };
  let allPages = 0;
  for (const p of profiles) {
    const s = p.profile_status || 'Unknown';
    c[s] = (c[s] || 0) + 1;
    pg[p.page_status] = (pg[p.page_status] || 0) + 1;
    allPages += Number(p.pages_count) || 0;
  }
  const restrictedTotal = (c['Restricted']||0) + (c['Limited']||0) + (c['At Risk']||0) + (c['Suspended']||0);
  const goodTotal = (c['No restrictions']||0) + (c['Active']||0);
  return {
    profile_status: {
      all_profiles: profiles.length,
      restricted: restrictedTotal,
      no_restrictions: goodTotal,
      login_failed: c['Login Failed'] || 0,
      unknown: (c['Unknown'] || 0),
      active: goodTotal,
      limited: c['Limited'] || 0,
      at_risk: c['At Risk'] || 0,
      suspended: c['Suspended'] || 0,
    },
    page_status: {
      all_pages: allPages,
      page_some_issues: pg['Page has some issues'] || 0,
      page_no_issues: pg['Page has no issues'] || 0,
      no_page_create: pg['No Page Create'] || 0,
      checkpoint: pg['Checkpoint'] || 0,
    },
    groups: Object.entries(profiles.reduce((a, p) => (a[p.group_name] = (a[p.group_name] || 0) + 1, a), {}))
      .map(([group_name, c]) => ({ group_name, c })),
  };
}

const TASK_TYPES = [
  'Check Profiles Status',
  'Check Page Status',
  'Auto Upload Reels',
  'Auto Page Creation',
  'Page Create & Reels',
  'Auto Interaction',
  'Auto Upload Story',
  'Story and Reels Upload',
  'Auto Join Groups',
  'Auto Post to Groups',
  'Auto Comments (Random)',
  'Auto Comments (Targeted)',
];

// -------- Public API --------
const api = isElectron ? window.api : {
  // Profiles
  listProfiles: async () => LS.get('_profiles', []),
  getProfile:   async (uid) => LS.get('_profiles', []).find(p => p.uid === uid) || null,
  upsertProfile: async (d) => {
    const list = LS.get('_profiles', []);
    const i = list.findIndex(p => p.uid === d.uid);
    const row = { ...(list[i] || {}), ...d };
    if (i >= 0) list[i] = row; else list.push(row);
    LS.set('_profiles', list); return { success: true };
  },
  deleteProfile: async (uid) => { LS.set('_profiles', LS.get('_profiles', []).filter(p => p.uid !== uid)); return { success: true }; },
  deleteProfiles: async (uids) => { const s = new Set(uids); LS.set('_profiles', LS.get('_profiles', []).filter(p => !s.has(p.uid))); return { success: true }; },
  setProfilesGroup: async (uids, group) => {
    const s = new Set(uids);
    LS.set('_profiles', LS.get('_profiles', []).map(p => s.has(p.uid) ? { ...p, group_name: group } : p));
    return { success: true };
  },
  // Groups
  listGroups: async () => {
    const gs = LS.get('_groups', [{ name: 'Default' }]);
    const profs = LS.get('_profiles', []);
    return gs.map(g => ({ ...g, count: profs.filter(p => p.group_name === g.name).length }));
  },
  addGroup: async (name) => { const gs = LS.get('_groups', []); if (!gs.find(g => g.name === name)) gs.push({ name }); LS.set('_groups', gs); return { success: true }; },
  renameGroup: async (o, n) => {
    LS.set('_groups', LS.get('_groups', []).map(g => g.name === o ? { name: n } : g));
    LS.set('_profiles', LS.get('_profiles', []).map(p => p.group_name === o ? { ...p, group_name: n } : p));
    return { success: true };
  },
  deleteGroup: async (name) => {
    if (name === 'Default') return { success: false, error: 'Cannot delete Default' };
    LS.set('_groups', LS.get('_groups', []).filter(g => g.name !== name));
    LS.set('_profiles', LS.get('_profiles', []).map(p => p.group_name === name ? { ...p, group_name: 'Default' } : p));
    return { success: true };
  },
  // Settings
  getSettings:  async () => LS.get('_settings', {}),
  saveSettings: async (s) => { LS.set('_settings', { ...LS.get('_settings', {}), ...s }); return { success: true }; },
  // History
  importHistory: async () => LS.get('_history', []),
  // Stats
  getStats: async () => computeStats(LS.get('_profiles', [])),
  // Browser (stubs in preview)
  openBrowser:  async () => ({ success: true, message: 'Preview mode' }),
  closeBrowser: async () => ({ success: true }),
  openMany:     async () => ([]),
  closeMany:    async () => ([]),
  closeAll:     async () => ({ success: true }),
  // Tasks (simulated)
  taskTypes: async () => TASK_TYPES,
  runTask: async (cfg) => {
    // simulate progress via listeners
    const profs = cfg.profiles || [];
    let ok = 0, fail = 0;
    const emit = (state) => window.dispatchEvent(new CustomEvent('__mock_task', { detail: state }));
    const logEmit = (line) => window.dispatchEvent(new CustomEvent('__mock_log', { detail: line }));
    logEmit(`━━━ Starting: ${cfg.taskName} · ${profs.length} profiles (preview) ━━━`);
    for (let i = 0; i < profs.length; i++) {
      await new Promise(r => setTimeout(r, 250));
      const p = profs[i];
      const success = Math.random() > 0.15;
      success ? ok++ : fail++;
      logEmit(`[preview] ${success ? '✓' : '✗'} ${p.name} (${p.uid})`);
      emit({ running: true, totalActive: profs.length, remaining: profs.length - i - 1, success: ok, failed: fail, taskName: cfg.taskName,
             results: [{ uid: p.uid, name: p.name, ok: success, ms: 250 }] });
    }
    emit({ running: false, totalActive: profs.length, remaining: 0, success: ok, failed: fail, taskName: cfg.taskName, results: [] });
    logEmit(`━━━ Done: ${ok} ok, ${fail} failed ━━━`);
    return { success: true, ok, failed: fail };
  },
  stopTask: async () => ({ success: true }),
  pauseTask: async () => ({ success: true }),
  resumeTask: async () => ({ success: true }),
  importExcel:       async () => ({ success: false, error: 'Only available in the desktop app' }),
  importOpenFolder:  async () => ({ success: false, error: 'Only available in the desktop app' }),
  importListFolders: async () => ({ success: true, folders: [] }),
  onImportProgress:  (_cb) => (() => {}),
  exportCsv:         async () => ({ success: false, error: 'Only available in the desktop app' }),
  loginToolsRun:        async (_opts) => ({ success: false, error: 'Only available in the desktop app' }),
  loginToolsStop:       async () => ({ success: true }),
  loginToolsOpenFolder: async () => ({ success: false, error: 'Only available in the desktop app' }),
  onLoginToolsProgress: (_cb) => (() => {}),
  matchedRead:  async () => ({ success: true, content: '', exists: false, path: '(desktop only)' }),
  matchedOpen:  async () => ({ success: false, error: 'Only available in the desktop app' }),
  matchedClear: async () => ({ success: false, error: 'Only available in the desktop app' }),
  onLog: (cb) => { const h = (e) => cb(e.detail); window.addEventListener('__mock_log', h); return () => window.removeEventListener('__mock_log', h); },
  onTaskUpdate: (cb) => { const h = (e) => cb(e.detail); window.addEventListener('__mock_task', h); return () => window.removeEventListener('__mock_task', h); },
  // Browser-preview auth stubs — always "logged in" as a mock user in preview
  auth: {
    verify:   async () => ({ success: true, user: { username: 'preview', full_name: 'Preview Mode', expires_at: new Date(Date.now() + 30*86400*1000).toISOString() }, offline: true }),
    activate: async () => ({ success: false, error: 'Activation only works in the desktop app' }),
    logout:   async () => ({ success: true }),
  },
  admin: {
    login:          async () => ({ success: false, error: 'Admin panel only works in the desktop app' }),
    logout:         async () => ({ success: true }),
    isUnlocked:     async () => ({ unlocked: false }),
    listUsers:      async () => ({ success: false, error: 'Desktop only' }),
    createUser:     async () => ({ success: false, error: 'Desktop only' }),
    extendUser:     async () => ({ success: false, error: 'Desktop only' }),
    setBlocked:     async () => ({ success: false, error: 'Desktop only' }),
    resetDevice:    async () => ({ success: false, error: 'Desktop only' }),
    deleteUser:     async () => ({ success: false, error: 'Desktop only' }),
    changePassword: async () => ({ success: false, error: 'Desktop only' }),
    setIsAdmin:     async () => ({ success: false, error: 'Desktop only' }),
    listVersions:   async () => ({ success: false, error: 'Desktop only' }),
    addVersion:     async () => ({ success: false, error: 'Desktop only' }),
    updateVersion:  async () => ({ success: false, error: 'Desktop only' }),
    deleteVersion:  async () => ({ success: false, error: 'Desktop only' }),
  },
  updater: {
    current:      async () => ({ version: '1.4.0' }),
    check:        async () => ({ success: true, hasUpdate: false, currentVersion: '1.4.0' }),
    openDownload: async () => ({ success: false, error: 'Desktop only' }),
  },
};

// Make `window.api` available even in browser preview so components that
// call it directly (App.jsx auth flow) don't crash.
if (typeof window !== 'undefined' && !window.api) {
  try { window.api = api; } catch {}
}

export default api;
export { TASK_TYPES, isElectron };
