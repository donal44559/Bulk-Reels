// main.js — Electron main process
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ---- Crash logging (write any startup error to a file the user can find) ----
// If the app crashes before showing a window (e.g. a require fails), we log
// the stack to <userData>/startup-error.log AND show a native dialog so the
// user isn't left with a silent flash-and-die.
const _writeCrashLog = (label, err) => {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const line = `\n[${new Date().toISOString()}] ${label}\n${(err && err.stack) || err}\n`;
    fs.appendFileSync(path.join(dir, 'startup-error.log'), line);
  } catch (_) {}
};
process.on('uncaughtException', (err) => {
  _writeCrashLog('uncaughtException', err);
  try { dialog.showErrorBox('Bulk Reels Upload Pro — Crash', String((err && err.stack) || err)); } catch (_) {}
});
process.on('unhandledRejection', (err) => {
  _writeCrashLog('unhandledRejection', err);
  try { dialog.showErrorBox('Bulk Reels Upload Pro — Unhandled Promise Rejection', String((err && err.stack) || err)); } catch (_) {}
});

// IMPORTANT: chromiumBootstrap sets PLAYWRIGHT_BROWSERS_PATH env var, which
// MUST be set BEFORE anything requires('playwright'). That's why bot.js is
// loaded LATER (inside app.whenReady, after bootstrap runs).
let chromiumBootstrap;
try {
  chromiumBootstrap = require('./src/chromiumBootstrap.js');
} catch (e) {
  _writeCrashLog('require chromiumBootstrap failed', e);
  try { dialog.showErrorBox('Startup Failed', 'Could not load chromiumBootstrap module:\n\n' + ((e && e.stack) || e)); } catch (_) {}
  app.quit();
}

let getProfiles, getProfile, upsertProfile, deleteProfile, deleteProfiles;
let getGroups, addGroup, renameGroup, deleteGroup, setProfilesGroup;
let getSettings, saveSettings;
let getImportHistory, addImportRecord;
let getStats, exportCsv;
try {
  const db = require('./src/database.js');
  ({
    getProfiles, getProfile, upsertProfile, deleteProfile, deleteProfiles,
    getGroups, addGroup, renameGroup, deleteGroup, setProfilesGroup,
    getSettings, saveSettings,
    getImportHistory, addImportRecord,
    getStats, exportCsv,
  } = db);
} catch (e) {
  _writeCrashLog('require database failed', e);
  try { dialog.showErrorBox('Startup Failed', 'Could not load database module:\n\n' + ((e && e.stack) || e)); } catch (_) {}
  app.quit();
}

// Lazy handles for bot.js — filled in AFTER Chromium bootstrap completes
let openProfile, closeProfile, closeAll;
let runTask, stopTask, pauseTask, resumeTask;
let TASK_TYPES = [];

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) mainWindow.loadFile(indexPath);
  else mainWindow.loadURL('data:text/html,<h1 style="color:#fff;background:#0b1220;padding:20px">Run `npm run build` first</h1>');

  // Broadcast log lines coming from bot.js
  const { onLog } = require('./src/bot.js');
  onLog((line) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:log', line);
  });
  const { onTaskUpdate } = require('./src/bot.js');
  onTaskUpdate((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:update', state);
  });
}

app.whenReady().then(async () => {
  // Step 0: app is ready now, so re-resolve the browsers dir using the real
  // userData path (before ready we could only guess the folder name).
  try { chromiumBootstrap.refreshBrowsersDir(); } catch (_) {}

  // Step 1: Ensure Chromium is downloaded (first launch only, shows progress UI)
  const ok = await chromiumBootstrap.ensureChromiumWithUi();
  if (!ok) return; // app.quit() already called on failure

  // Step 2: NOW load bot.js — it requires('playwright'), which reads
  // PLAYWRIGHT_BROWSERS_PATH env var set by the bootstrap.
  const bot = require('./src/bot.js');
  openProfile  = bot.openProfile;
  closeProfile = bot.closeProfile;
  closeAll     = bot.closeAll;
  runTask      = bot.runTask;
  stopTask     = bot.stopTask;
  pauseTask    = bot.pauseTask;
  resumeTask   = bot.resumeTask;
  TASK_TYPES   = bot.TASK_TYPES;

  // Step 3: Open main window (its inline require('./src/bot.js') gets the
  // already-loaded cached module — no duplicate listeners)
  createWindow();

  // ------- Profiles -------
  ipcMain.handle('profiles:list',   async () => await getProfiles());
  ipcMain.handle('profiles:get',    async (_e, uid) => await getProfile(uid));
  ipcMain.handle('profiles:upsert', async (_e, data) => {
    try { await upsertProfile(data); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('profiles:delete', async (_e, uid) => {
    try { await deleteProfile(uid); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('profiles:deleteMany', async (_e, uids) => {
    try { await deleteProfiles(uids); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('profiles:setGroup', async (_e, uids, group) => {
    try { await setProfilesGroup(uids, group); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  // ------- Groups -------
  ipcMain.handle('groups:list',   async () => await getGroups());
  ipcMain.handle('groups:add',    async (_e, name) => { try { await addGroup(name); return { success: true }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('groups:rename', async (_e, oldName, newName) => { try { await renameGroup(oldName, newName); return { success: true }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('groups:delete', async (_e, name) => { try { await deleteGroup(name); return { success: true }; } catch (e) { return { success: false, error: e.message }; } });

  // ------- Settings -------
  ipcMain.handle('settings:get',  async () => await getSettings());
  ipcMain.handle('settings:save', async (_e, s) => { try { await saveSettings(s); return { success: true }; } catch (e) { return { success: false, error: e.message }; } });

  // ------- Import history -------
  ipcMain.handle('history:list', async () => await getImportHistory());

  // ------- Stats -------
  ipcMain.handle('stats:get', async () => await getStats());

  // ------- Browser control -------
  ipcMain.handle('browser:open',  async (_e, uid) => {
    try { const p = await getProfile(uid); if (!p) throw new Error('Profile not found'); return await openProfile(p); }
    catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('browser:close', async (_e, uid) => await closeProfile(uid));
  ipcMain.handle('browser:openMany', async (_e, uids) => {
    // Open ALL selected profiles IN PARALLEL (bulk open).
    // Previously this was a sequential for..await loop: profile #2 only
    // started AFTER profile #1's whole open (launch + login + navigation)
    // finished — so "Open Selection" opened one browser at a time, and if the
    // user closed the current window mid-open the pending ops threw and the
    // loop moved to the next profile (looked like "close one → next opens").
    // Now EVERY selected profile launches at the SAME time — NO cap, the user
    // decides how many browsers they want open. Per-profile failures are
    // isolated so one bad profile can't break the batch.
    const list = Array.isArray(uids) ? uids : [];
    const openOne = async (uid) => {
      try {
        const p = await getProfile(uid);
        if (!p) return { uid, success: false, error: 'Profile not found' };
        return { uid, ...(await openProfile(p)) };
      } catch (e) {
        // Isolate per-profile failures so one bad profile can't break the batch
        return { uid, success: false, error: (e && e.message) || String(e) };
      }
    };
    const results = await Promise.all(list.map((uid) => openOne(uid)));
    return results;
  });
  ipcMain.handle('browser:closeMany', async (_e, uids) => {
    const results = [];
    for (const uid of uids) results.push({ uid, ...(await closeProfile(uid)) });
    return results;
  });
  ipcMain.handle('browser:closeAll', async () => await closeAll());

  // ------- Tasks -------
  ipcMain.handle('task:types', async () => TASK_TYPES);
  ipcMain.handle('task:run',   async (_e, cfg) => { try { return await runTask(cfg); } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('task:stop',  async () => stopTask());
  ipcMain.handle('task:pause', async () => pauseTask());
  ipcMain.handle('task:resume',async () => resumeTask());

  // ------- Matched Reels file (Auto Comments Targeted) -------
  ipcMain.handle('matched:read', async () => {
    try {
      const fs2 = require('fs');
      const p = require('path').join(require('electron').app.getPath('userData'), 'matched_reels.txt');
      if (!fs2.existsSync(p)) return { success: true, path: p, content: '', exists: false };
      const content = fs2.readFileSync(p, 'utf8');
      return { success: true, path: p, content, exists: true };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('matched:open', async () => {
    try {
      const p = require('path').join(require('electron').app.getPath('userData'), 'matched_reels.txt');
      const { shell } = require('electron');
      await shell.showItemInFolder(p);
      return { success: true, path: p };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('matched:clear', async () => {
    try {
      const fs2 = require('fs');
      const p = require('path').join(require('electron').app.getPath('userData'), 'matched_reels.txt');
      if (fs2.existsSync(p)) fs2.unlinkSync(p);
      return { success: true, path: p };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ------- Import from Excel (direct save, no validation) -------
  ipcMain.handle('import:excel', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Excel/CSV file',
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv'] }],
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(result.filePaths[0]);
      const sh = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sh, { defval: '' });
      // Normalize headers — supports: Uid/UID/uid/id, Pass/Password/pass, Cookies/cookies/cookie, etc.
      const pick = (r, ...keys) => {
        for (const k of keys) {
          for (const rk of Object.keys(r)) {
            if (rk.toLowerCase().trim() === k.toLowerCase()) {
              const v = r[rk];
              if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
            }
          }
        }
        return '';
      };
      const rows = raw.map(r => ({
        uid:        pick(r, 'uid', 'UID', 'id', 'user_id', 'facebook_uid'),
        name:       pick(r, 'name', 'full_name'),
        group_name: pick(r, 'group', 'group_name') || 'Default',
        password:   pick(r, 'pass', 'password', 'pwd'),
        two_fa:     pick(r, '2fa', 'twofa', 'two_fa', '2fa_secret', 'totp'),
        cookies:    pick(r, 'cookies', 'cookie', 'cookie_string'),
        proxy:      pick(r, 'proxy'),
        notes:      pick(r, 'notes', 'note', 'remark'),
      })).filter(r => r.uid);

      if (!rows.length) {
        return { success: false, error: 'No valid rows found (need at least a "uid" column)' };
      }

      // PHASE 1: Real browser login test — like V1.4
      // Each row: spawn browser → inject cookies → verify login → close
      // Runs 3 in parallel, headless (invisible) for speed
      const bot = require('./src/bot.js');
      const logToTerminal = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:log', `[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${msg}`);
        }
      };
      const validation = await bot.bulkImportWithBrowserLogin(rows, {
        concurrency: 3,
        headless: true,
        onProgress: (p) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('import:progress', p);
          }
        },
        onLog: logToTerminal,
      });

      // PHASE 1.5: Post-check the "valid" (logged-in) accounts for suspend /
      // checkpoint / restrictions. bulkImportWithBrowserLogin only verifies
      // that the c_user cookie exists after login — it does NOT know that FB
      // is showing a "your account is suspended" page. This filter runs
      // detectFacebookState() on each supposedly-valid row and moves any
      // restricted/suspended/checkpointed account out of validRows and into
      // deadRows, so they end up in dead_accounts.xlsx (the fail file) and
      // are NOT saved to the DB / opened in a browser.
      let restrictedRows = [];
      if (validation.validRows && validation.validRows.length) {
        try {
          const post = await bot.filterOutRestrictedAccounts(validation.validRows, {
            concurrency: 3,
            onLog: logToTerminal,
            onProgress: (p) => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('import:progress', { ...p, phase: 'restriction-check' });
              }
            },
          });
          // Overwrite validRows with only the truly-clean ones. Merge the
          // restricted ones into deadRows so they land in dead_accounts.xlsx.
          validation.validRows = post.keepRows;
          restrictedRows = post.restrictedRows || [];
          if (restrictedRows.length) {
            validation.deadRows = (validation.deadRows || []).concat(restrictedRows);
          }
        } catch (e) {
          logToTerminal(`⚠ Post-check failed (${e.message || e}) — keeping all logged-in accounts as valid`);
        }
      }

      // PHASE 2: Save only accounts that actually logged in AND are unrestricted
      let imported = 0;
      for (const r of validation.validRows) {
        await upsertProfile({
          uid: r.uid,
          name: r.name || `Profile ${r.uid}`,
          group_name: r.group_name,
          password: r.password,
          two_fa: r.two_fa,
          cookies: r.cookies,
          proxy: r.proxy,
          notes: r.notes,
        });
        imported++;
      }

      await addImportRecord(imported, path.basename(result.filePaths[0]));

      // Save valid + dead lists to a timestamped folder for user reference
      let importDir = null, validFile = null, deadFile = null;
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        importDir = path.join(app.getPath('userData'), 'imports', stamp);
        fs.mkdirSync(importDir, { recursive: true });

        const writeXlsx = (rowsToWrite, filename) => {
          if (!rowsToWrite || !rowsToWrite.length) return null;
          const cleaned = rowsToWrite.map(r => {
            const o = { ...r };
            delete o._fresh_cookies;
            return o;
          });
          const ws = XLSX.utils.json_to_sheet(cleaned);
          const wbOut = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wbOut, ws, 'accounts');
          const fp = path.join(importDir, filename);
          XLSX.writeFile(wbOut, fp);
          return fp;
        };

        validFile = writeXlsx(validation.validRows, 'valid_accounts.xlsx');
        deadFile  = writeXlsx(validation.deadRows,  'dead_accounts.xlsx');

        const summary = [
          `Import summary — ${new Date().toString()}`,
          `Source file    : ${result.filePaths[0]}`,
          `Total rows     : ${rows.length}`,
          `Valid (saved)  : ${validation.validRows.length}`,
          `Dead (skipped) : ${validation.deadRows.length}`,
          '',
          '── VALID ACCOUNTS ──',
          ...validation.validRows.map(r => `  ✓ ${r.uid}  ${r.name || ''}`),
          '',
          '── DEAD ACCOUNTS ──',
          ...validation.deadRows.map(r => `  ✗ ${r.uid}  ${r.name || ''}   [${r._dead_reason || 'unknown'}]`),
        ].join('\n');
        fs.writeFileSync(path.join(importDir, 'summary.txt'), summary, 'utf8');
      } catch (e) {
        console.error('Failed to write import folder:', e);
      }

      return {
        success: true,
        imported,
        total: rows.length,
        valid: validation.validRows.length,
        dead: validation.deadRows.length,
        importDir,
        validFile,
        deadFile,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ------- Open the import folder in file explorer -------
  ipcMain.handle('import:openFolder', async (_e, folderPath) => {
    try {
      if (!folderPath) folderPath = path.join(app.getPath('userData'), 'imports');
      if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
      shell.openPath(folderPath);
      return { success: true, path: folderPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ------- List all past import folders -------
  ipcMain.handle('import:listFolders', async () => {
    try {
      const root = path.join(app.getPath('userData'), 'imports');
      if (!fs.existsSync(root)) return { success: true, folders: [] };
      const folders = fs.readdirSync(root)
        .filter(d => fs.statSync(path.join(root, d)).isDirectory())
        .sort((a, b) => b.localeCompare(a));
      return { success: true, folders, root };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // FACEBOOK LOGIN TOOLS — Standalone feature (independent)
  // ═══════════════════════════════════════════════════════════════
  ipcMain.handle('loginTools:runFromExcel', async (_e, userOpts = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Excel/CSV file with uid, pass, cookies',
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv'] }],
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(result.filePaths[0]);
      const sh = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sh, { defval: '' });

      const pick = (r, ...keys) => {
        for (const k of keys) {
          for (const rk of Object.keys(r)) {
            if (rk.toLowerCase().trim() === k.toLowerCase()) {
              const v = r[rk];
              if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
            }
          }
        }
        return '';
      };

      const rows = raw.map(r => ({
        uid:     pick(r, 'uid', 'UID', 'id', 'user_id', 'facebook_uid', 'email'),
        pass:    pick(r, 'pass', 'password', 'pwd'),
        cookies: pick(r, 'cookies', 'cookie', 'cookie_string'),
      })).filter(r => r.uid);

      if (!rows.length) {
        return { success: false, error: 'No valid rows found (need at least a "uid" column)' };
      }

      const bot = require('./src/bot.js');
      const concurrency = Math.max(1, Math.min(20, parseInt(userOpts.concurrency) || 3));
      const headless = userOpts.headless !== false;   // default true
      const speed = userOpts.speed === 'fast' ? 'fast' : 'safe';   // default safe
      const outcome = await bot.runLoginTools(rows, {
        concurrency,
        headless,
        speed,
        onProgress: (p) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('loginTools:progress', p);
          }
        },
        onLog: (msg) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal:log', `[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${msg}`);
          }
        },
      });

      // Save to timestamped folder
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outDir = path.join(app.getPath('userData'), 'login_tools', stamp);
      fs.mkdirSync(outDir, { recursive: true });

      const writeSheet = (data, name) => {
        if (!data || !data.length) return null;
        const ws = XLSX.utils.json_to_sheet(data);
        const wbOut = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wbOut, ws, 'accounts');
        const fp = path.join(outDir, name);
        XLSX.writeFile(wbOut, fp);
        return fp;
      };

      const successFile = writeSheet(outcome.successRows, 'Login_Success.xlsx');
      const failedFile  = writeSheet(outcome.failedRows,  'Login_Failed.xlsx');

      const summary = [
        `FB Login Tools — ${new Date().toString()}`,
        `Source file : ${result.filePaths[0]}`,
        `Total rows  : ${rows.length}`,
        `Success     : ${outcome.successRows.length}`,
        `Failed      : ${outcome.failedRows.length}`,
        outcome.stopped ? '(stopped by user)' : '',
        '',
        '── SUCCESS ──',
        ...outcome.successRows.map(r => `  ✓ ${r.uid}  [${r.method}]`),
        '',
        '── FAILED ──',
        ...outcome.failedRows.map(r => `  ✗ ${r.uid}   [${r.fail_reason}]`),
      ].join('\n');
      fs.writeFileSync(path.join(outDir, 'summary.txt'), summary, 'utf8');

      return {
        success: true,
        total: rows.length,
        successCount: outcome.successRows.length,
        failedCount: outcome.failedRows.length,
        stopped: !!outcome.stopped,
        outDir,
        successFile,
        failedFile,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('loginTools:stop', async () => {
    try {
      const bot = require('./src/bot.js');
      bot.stopLoginTools();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('loginTools:openFolder', async (_e, folderPath) => {
    try {
      if (!folderPath) folderPath = path.join(app.getPath('userData'), 'login_tools');
      if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
      shell.openPath(folderPath);
      return { success: true, path: folderPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ------- Reels config: browse folder / file pickers -------
  // Used ONLY by the Auto Upload Reels config panel — lets user click
  // Browse instead of typing an absolute path. Returns the picked path
  // or '' if canceled. No side-effects.
  ipcMain.handle('reels:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Reels folder (contains .mp4 / .mov / .m4v / .webm)',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return '';
    return res.filePaths[0];
  });
  ipcMain.handle('reels:pickDescriptionsFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select descriptions file (Discription.txt)',
      properties: ['openFile'],
      filters: [
        { name: 'Text', extensions: ['txt', 'md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return '';
    return res.filePaths[0];
  });

  // ------- Export CSV -------
  ipcMain.handle('export:csv', async () => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export profiles as CSV',
      defaultPath: `profiles_${Date.now()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return { success: false, canceled: true };
    try { await exportCsv(res.filePath); return { success: true, path: res.filePath }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  // ============================================================
  // AUTH / ADMIN PANEL IPC
  // ============================================================
  const auth = require('./src/auth/authService.js');

  ipcMain.handle('auth:verify',   async () => await auth.verifyStoredAuth());
  ipcMain.handle('auth:activate', async (_e, payload) => await auth.activateUser(payload || {}));
  ipcMain.handle('auth:logout',   async () => auth.logoutUser());

  ipcMain.handle('admin:login',           async (_e, p) => await auth.adminLogin(p || {}));
  ipcMain.handle('admin:logout',          async () => auth.adminLogout());
  ipcMain.handle('admin:isUnlocked',      async () => ({ unlocked: auth.isAdminUnlocked() }));
  ipcMain.handle('admin:listUsers',       async () => { try { return { success: true, users: await auth.adminListUsers() }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:createUser',      async (_e, p) => { try { return { success: true, user: await auth.adminCreateUser(p || {}) }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:extendUser',      async (_e, p) => { try { return { success: true, user: await auth.adminExtendUser(p || {}) }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:setBlocked',      async (_e, p) => { try { return { success: true, user: await auth.adminSetBlocked(p || {}) }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:resetDevice',     async (_e, p) => { try { return { success: true, user: await auth.adminResetDevice(p || {}) }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:deleteUser',      async (_e, p) => { try { return await auth.adminDeleteUser(p || {}); } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:changePassword',  async (_e, p) => { try { return await auth.adminChangePassword(p || {}); } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:setIsAdmin',       async (_e, p) => { try { return { success: true, user: await auth.adminSetIsAdmin(p || {}) }; } catch (e) { return { success: false, error: e.message }; } });

  // ---------- Update / Version Management ----------
  const updater = require('./src/auth/updateService.js');
  ipcMain.handle('update:current',     async () => ({ version: updater.getCurrentVersion() }));
  ipcMain.handle('update:check',       async () => await updater.checkForUpdates());
  ipcMain.handle('update:openDownload',async (_e, url) => {
    try { await shell.openExternal(String(url)); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  // Admin-only version CRUD (require admin unlock via auth.isAdminUnlocked)
  const requireAdmin = () => { if (!auth.isAdminUnlocked()) throw new Error('Admin panel is locked'); };
  ipcMain.handle('admin:listVersions',  async () => { try { requireAdmin(); return { success: true, versions: await updater.adminListVersions() }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:addVersion',    async (_e, p) => { try { requireAdmin(); return { success: true, version: await updater.adminAddVersion(p || {}) }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:updateVersion', async (_e, p) => { try { requireAdmin(); return { success: true, version: await updater.adminUpdateVersion(p || {}) }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('admin:deleteVersion', async (_e, p) => { try { requireAdmin(); return await updater.adminDeleteVersion(p || {}); } catch (e) { return { success: false, error: e.message }; } });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', async () => { try { await closeAll(); } catch (_) {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
