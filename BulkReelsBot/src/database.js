// src/database.js — SQLite persistence (better-sqlite3 backend)
//
// NOTE: Migrated sqlite3 → better-sqlite3 to avoid native-compile issues on
// Windows (no MSVC / Python-build-tools requirement). better-sqlite3 ships
// prebuilt binaries for Electron + Node LTS, so `electron-builder` can rebuild
// it without invoking node-gyp on the user's machine.
//
// Public API (all exported functions) is UNCHANGED — every function still
// returns a Promise, so callers in bot.js / main.js keep working as-is.
// Internally we use better-sqlite3's synchronous API and wrap results in
// Promise.resolve for compatibility.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const Database = require('better-sqlite3');

const dataDir = app ? app.getPath('userData') : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const PROFILE_ROOT = path.join(dataDir, 'profiles');
if (!fs.existsSync(PROFILE_ROOT)) fs.mkdirSync(PROFILE_ROOT, { recursive: true });

const DB_PATH = path.join(dataDir, 'bulkreels.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS profiles (
    uid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_name TEXT DEFAULT 'Default',
    password TEXT DEFAULT '',
    two_fa TEXT DEFAULT '',
    cookies TEXT DEFAULT '',
    proxy TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    profile_status TEXT DEFAULT 'Unknown',
    page_status TEXT DEFAULT 'No Page Create',
    page_name TEXT DEFAULT '',
    pages_count INTEGER DEFAULT 0,
    upload_status TEXT DEFAULT '',
    comment_status TEXT DEFAULT '',
    start_url TEXT DEFAULT '',
    user_data_dir TEXT NOT NULL,
    last_used DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS import_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    profiles_imported INTEGER DEFAULT 0,
    source_file TEXT DEFAULT ''
  );
`);

// Safe ALTERs for older DBs (better-sqlite3 throws on duplicate col → swallow)
const safeAlter = (sql) => { try { db.exec(sql); } catch (_) {} };
safeAlter(`ALTER TABLE profiles ADD COLUMN start_url TEXT DEFAULT ''`);
safeAlter(`ALTER TABLE profiles ADD COLUMN comment_status TEXT DEFAULT ''`);

// Seed default groups + settings (idempotent)
const seedGroup = db.prepare(`INSERT OR IGNORE INTO groups (name) VALUES (?)`);
['Default', 'News 1', 'News 2'].forEach((g) => seedGroup.run(g));

const seedSetting = db.prepare(
  `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
);
const defaults = {
  headless_mode: 'true',
  page_load_timeout: '60',
  concurrent_profiles: '3',
  action_delay_ms: '800',
  username: 'member110_A34',
  license_days_left: '30',
  default_start_url: 'https://www.facebook.com/',
};
for (const [k, v] of Object.entries(defaults)) seedSetting.run(k, v);

// ---------- Promise-compat helpers ----------
// The old sqlite3 API was async (callbacks → Promises). Callers await these
// helpers, so we return real Promises to keep the exact contract even though
// better-sqlite3 runs synchronously under the hood.
const run = (sql, p = []) => {
  try {
    const stmt = db.prepare(sql);
    const info = stmt.run(...p);
    return Promise.resolve({ lastID: info.lastInsertRowid, changes: info.changes });
  } catch (e) {
    return Promise.reject(e);
  }
};
const all = (sql, p = []) => {
  try {
    return Promise.resolve(db.prepare(sql).all(...p));
  } catch (e) {
    return Promise.reject(e);
  }
};
const get = (sql, p = []) => {
  try {
    return Promise.resolve(db.prepare(sql).get(...p));
  } catch (e) {
    return Promise.reject(e);
  }
};

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_\-]/g, '_');

// ---------- Groups ----------
async function getGroups() {
  return await all(`SELECT g.name, g.created_at,
      (SELECT COUNT(*) FROM profiles p WHERE p.group_name = g.name) AS count
      FROM groups g ORDER BY g.name ASC`);
}
async function addGroup(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Group name required');
  await run(`INSERT OR IGNORE INTO groups (name) VALUES (?)`, [name]);
}
async function renameGroup(oldName, newName) {
  newName = String(newName || '').trim();
  if (!newName) throw new Error('New name required');
  if (oldName === 'Default') throw new Error('Cannot rename Default');
  await run(`UPDATE groups SET name=? WHERE name=?`, [newName, oldName]);
  await run(`UPDATE profiles SET group_name=? WHERE group_name=?`, [newName, oldName]);
}
async function deleteGroup(name) {
  if (name === 'Default') throw new Error('Cannot delete Default group');
  await run(`UPDATE profiles SET group_name='Default' WHERE group_name=?`, [name]);
  await run(`DELETE FROM groups WHERE name=?`, [name]);
}

// ---------- Profiles ----------
async function getProfiles() {
  // ASC = oldest first, newest last (fresh imports append to the bottom).
  return await all(`SELECT * FROM profiles ORDER BY created_at ASC, rowid ASC`);
}
async function getProfile(uid) {
  return await get(`SELECT * FROM profiles WHERE uid=?`, [uid]);
}
async function upsertProfile(d) {
  if (!d.uid) throw new Error('uid required');
  if (!d.name) d.name = `Profile ${d.uid}`;
  const userDataDir = path.join(PROFILE_ROOT, sanitize(d.uid));
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  // Status columns must never be overwritten by edit-form saves or Excel
  // re-imports — only tasks update them. Passing undefined leaves DB value.
  const hasStatus = (v) => v !== undefined && v !== null;

  const insProfileStatus = hasStatus(d.profile_status) ? d.profile_status : 'Unknown';
  const insPageStatus    = hasStatus(d.page_status)    ? d.page_status    : 'No Page Create';
  const insPageName      = hasStatus(d.page_name)      ? d.page_name      : '';
  const insPagesCount    = hasStatus(d.pages_count)    ? d.pages_count    : 0;
  const insUploadStatus  = hasStatus(d.upload_status)  ? d.upload_status  : '';
  const insCommentStatus = hasStatus(d.comment_status) ? d.comment_status : '';

  const updProfileStatus = hasStatus(d.profile_status) ? d.profile_status : null;
  const updPageStatus    = hasStatus(d.page_status)    ? d.page_status    : null;
  const updPageName      = hasStatus(d.page_name)      ? d.page_name      : null;
  const updPagesCount    = hasStatus(d.pages_count)    ? d.pages_count    : null;
  const updUploadStatus  = hasStatus(d.upload_status)  ? d.upload_status  : null;
  const updCommentStatus = hasStatus(d.comment_status) ? d.comment_status : null;

  await run(`INSERT INTO profiles
    (uid, name, group_name, password, two_fa, cookies, proxy, notes,
     profile_status, page_status, page_name, pages_count, upload_status, comment_status, start_url, user_data_dir)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET
      name=excluded.name,
      group_name=excluded.group_name,
      password=excluded.password,
      two_fa=excluded.two_fa,
      cookies=CASE WHEN excluded.cookies='' THEN profiles.cookies ELSE excluded.cookies END,
      proxy=excluded.proxy,
      notes=excluded.notes,
      start_url=COALESCE(NULLIF(excluded.start_url,''), profiles.start_url),
      profile_status = COALESCE(?, profiles.profile_status),
      page_status    = COALESCE(?, profiles.page_status),
      page_name      = COALESCE(?, profiles.page_name),
      pages_count    = COALESCE(?, profiles.pages_count),
      upload_status  = COALESCE(?, profiles.upload_status),
      comment_status = COALESCE(?, profiles.comment_status)`,
    [
      // INSERT values
      d.uid, d.name, d.group_name || 'Default', d.password || '', d.two_fa || '',
      d.cookies || '', d.proxy || '', d.notes || '',
      insProfileStatus, insPageStatus, insPageName, insPagesCount, insUploadStatus, insCommentStatus,
      d.start_url || '', userDataDir,
      // UPDATE-branch COALESCE args (in order)
      updProfileStatus, updPageStatus, updPageName, updPagesCount, updUploadStatus, updCommentStatus,
    ]);

  if (d.group_name) await run(`INSERT OR IGNORE INTO groups (name) VALUES (?)`, [d.group_name]);
}
async function deleteProfile(uid) {
  const p = await getProfile(uid);
  await run(`DELETE FROM profiles WHERE uid=?`, [uid]);
  if (p && p.user_data_dir && fs.existsSync(p.user_data_dir)) {
    try { fs.rmSync(p.user_data_dir, { recursive: true, force: true }); } catch (_) {}
  }
}
async function deleteProfiles(uids) {
  for (const u of uids || []) await deleteProfile(u);
}
async function setProfilesGroup(uids, group) {
  await run(`INSERT OR IGNORE INTO groups (name) VALUES (?)`, [group]);
  for (const u of uids || []) await run(`UPDATE profiles SET group_name=? WHERE uid=?`, [group, u]);
}
async function updateProfileStatus(uid, patch) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k}=?`); vals.push(v);
  }
  if (!cols.length) return;
  vals.push(uid);
  await run(`UPDATE profiles SET ${cols.join(', ')} WHERE uid=?`, vals);
}
async function markUsed(uid) {
  await run(`UPDATE profiles SET last_used=CURRENT_TIMESTAMP WHERE uid=?`, [uid]);
}

// ---------- Settings ----------
async function getSettings() {
  const rows = await all(`SELECT key, value FROM settings`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function saveSettings(obj) {
  for (const [k, v] of Object.entries(obj || {})) {
    await run(`INSERT INTO settings (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [k, String(v)]);
  }
}

// ---------- Import history ----------
async function getImportHistory() {
  return await all(`SELECT id, imported_at, profiles_imported, source_file
                    FROM import_history ORDER BY imported_at DESC LIMIT 100`);
}
async function addImportRecord(count, source) {
  await run(`INSERT INTO import_history (profiles_imported, source_file) VALUES (?, ?)`,
    [count, source || '']);
}

// ---------- Stats ----------
async function getStats() {
  const all_profiles      = (await get(`SELECT COUNT(*) c FROM profiles`)).c;
  const restricted        = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status IN ('Restricted','Limited','At Risk','Suspended')`)).c;
  const no_restrictions   = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status IN ('No restrictions','Active')`)).c;
  const login_failed      = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status='Login Failed'`)).c;
  const unknown           = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status='Unknown' OR profile_status IS NULL OR profile_status=''`)).c;

  const active_count      = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status IN ('No restrictions','Active')`)).c;
  const limited_count     = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status='Limited'`)).c;
  const at_risk_count     = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status='At Risk'`)).c;
  const suspended_count   = (await get(`SELECT COUNT(*) c FROM profiles WHERE profile_status='Suspended'`)).c;

  const all_pages         = (await get(`SELECT COALESCE(SUM(pages_count),0) c FROM profiles`)).c;
  const page_some_issues  = (await get(`SELECT COUNT(*) c FROM profiles WHERE page_status='Page has some issues'`)).c;
  const page_no_issues    = (await get(`SELECT COUNT(*) c FROM profiles WHERE page_status='Page has no issues'`)).c;
  const no_page_create    = (await get(`SELECT COUNT(*) c FROM profiles WHERE page_status='No Page Create' OR page_status IS NULL OR page_status=''`)).c;
  const checkpoint        = (await get(`SELECT COUNT(*) c FROM profiles WHERE page_status='Checkpoint'`)).c;

  const groups = await all(`SELECT group_name, COUNT(*) c FROM profiles GROUP BY group_name ORDER BY c DESC`);

  return {
    profile_status: { all_profiles, restricted, no_restrictions, login_failed, unknown,
                      active: active_count, limited: limited_count, at_risk: at_risk_count, suspended: suspended_count },
    page_status:    { all_pages, page_some_issues, page_no_issues, no_page_create, checkpoint },
    groups,
  };
}

// ---------- CSV Export ----------
async function exportCsv(filePath) {
  const rows = await getProfiles();
  const header = ['uid','name','group_name','profile_status','page_status','page_name','pages_count','upload_status','comment_status','proxy','notes','last_used','created_at'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map(h => esc(r[h])).join(','));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

module.exports = {
  PROFILE_ROOT, DB_PATH,
  getGroups, addGroup, renameGroup, deleteGroup,
  getProfiles, getProfile, upsertProfile, deleteProfile, deleteProfiles,
  setProfilesGroup, updateProfileStatus, markUsed,
  getSettings, saveSettings,
  getImportHistory, addImportRecord,
  getStats, exportCsv,
};
