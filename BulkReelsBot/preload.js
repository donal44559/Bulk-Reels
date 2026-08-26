const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // profiles
  listProfiles:      () => ipcRenderer.invoke('profiles:list'),
  getProfile:        (uid) => ipcRenderer.invoke('profiles:get', uid),
  upsertProfile:     (data) => ipcRenderer.invoke('profiles:upsert', data),
  deleteProfile:     (uid) => ipcRenderer.invoke('profiles:delete', uid),
  deleteProfiles:    (uids) => ipcRenderer.invoke('profiles:deleteMany', uids),
  setProfilesGroup:  (uids, group) => ipcRenderer.invoke('profiles:setGroup', uids, group),
  // groups
  listGroups:   () => ipcRenderer.invoke('groups:list'),
  addGroup:     (name) => ipcRenderer.invoke('groups:add', name),
  renameGroup:  (o, n) => ipcRenderer.invoke('groups:rename', o, n),
  deleteGroup:  (name) => ipcRenderer.invoke('groups:delete', name),
  // settings
  getSettings:  () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  // history & stats
  importHistory: () => ipcRenderer.invoke('history:list'),
  getStats:      () => ipcRenderer.invoke('stats:get'),
  // browser
  openBrowser:   (uid) => ipcRenderer.invoke('browser:open', uid),
  closeBrowser:  (uid) => ipcRenderer.invoke('browser:close', uid),
  openMany:      (uids) => ipcRenderer.invoke('browser:openMany', uids),
  closeMany:     (uids) => ipcRenderer.invoke('browser:closeMany', uids),
  closeAll:      () => ipcRenderer.invoke('browser:closeAll'),
  // tasks
  taskTypes:  () => ipcRenderer.invoke('task:types'),
  runTask:    (cfg) => ipcRenderer.invoke('task:run', cfg),
  stopTask:   () => ipcRenderer.invoke('task:stop'),
  pauseTask:  () => ipcRenderer.invoke('task:pause'),
  resumeTask: () => ipcRenderer.invoke('task:resume'),
  // import/export
  importExcel:        () => ipcRenderer.invoke('import:excel'),
  importOpenFolder:   (p) => ipcRenderer.invoke('import:openFolder', p),
  importListFolders:  () => ipcRenderer.invoke('import:listFolders'),
  exportCsv:          () => ipcRenderer.invoke('export:csv'),

  // Reels config Browse pickers (returns picked absolute path, or '' if canceled)
  pickReelsFolder:            () => ipcRenderer.invoke('reels:pickFolder'),
  pickReelsDescriptionsFile:  () => ipcRenderer.invoke('reels:pickDescriptionsFile'),
  onImportProgress:   (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('import:progress', h); return () => ipcRenderer.removeListener('import:progress', h); },
  // FB Login Tools (standalone)
  loginToolsRun:         (opts) => ipcRenderer.invoke('loginTools:runFromExcel', opts || {}),
  loginToolsStop:        () => ipcRenderer.invoke('loginTools:stop'),
  loginToolsOpenFolder:  (p) => ipcRenderer.invoke('loginTools:openFolder', p),
  onLoginToolsProgress:  (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('loginTools:progress', h); return () => ipcRenderer.removeListener('loginTools:progress', h); },
  // matched reels (Auto Comments Targeted)
  matchedRead:  () => ipcRenderer.invoke('matched:read'),
  matchedOpen:  () => ipcRenderer.invoke('matched:open'),
  matchedClear: () => ipcRenderer.invoke('matched:clear'),
  // events
  onLog:        (cb) => { const h = (_e, l) => cb(l); ipcRenderer.on('terminal:log', h); return () => ipcRenderer.removeListener('terminal:log', h); },
  onTaskUpdate: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('task:update', h); return () => ipcRenderer.removeListener('task:update', h); },

  // -------------------- AUTH / ADMIN PANEL --------------------
  auth: {
    verify:   () => ipcRenderer.invoke('auth:verify'),
    activate: (p) => ipcRenderer.invoke('auth:activate', p),
    logout:   () => ipcRenderer.invoke('auth:logout'),
  },
  admin: {
    login:          (p) => ipcRenderer.invoke('admin:login', p),
    logout:         () => ipcRenderer.invoke('admin:logout'),
    isUnlocked:     () => ipcRenderer.invoke('admin:isUnlocked'),
    listUsers:      () => ipcRenderer.invoke('admin:listUsers'),
    createUser:     (p) => ipcRenderer.invoke('admin:createUser', p),
    extendUser:     (p) => ipcRenderer.invoke('admin:extendUser', p),
    setBlocked:     (p) => ipcRenderer.invoke('admin:setBlocked', p),
    resetDevice:    (p) => ipcRenderer.invoke('admin:resetDevice', p),
    deleteUser:     (p) => ipcRenderer.invoke('admin:deleteUser', p),
    changePassword: (p) => ipcRenderer.invoke('admin:changePassword', p),
    setIsAdmin:     (p) => ipcRenderer.invoke('admin:setIsAdmin', p),
    // Version management (admin panel unlock required)
    listVersions:   () => ipcRenderer.invoke('admin:listVersions'),
    addVersion:     (p) => ipcRenderer.invoke('admin:addVersion', p),
    updateVersion:  (p) => ipcRenderer.invoke('admin:updateVersion', p),
    deleteVersion:  (p) => ipcRenderer.invoke('admin:deleteVersion', p),
  },
  updater: {
    current:      () => ipcRenderer.invoke('update:current'),
    check:        () => ipcRenderer.invoke('update:check'),
    openDownload: (url) => ipcRenderer.invoke('update:openDownload', url),
  },
});
