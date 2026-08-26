// ============================================================
// Auth service — all user activation + admin panel operations.
// Lives in the main process (Electron). Renderer talks to it via
// preload.js → IPC → this file. Never expose the admin client to
// the renderer directly.
// ============================================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { app } = require('electron');
const { getAnonClient, getAdminClient } = require('./supabaseClient.js');

// ---------- Local auth cache (survives updates/reinstalls) ----------
// Stored in userData folder — Electron guarantees this is OUTSIDE the
// install folder, so app updates and reinstalls preserve it.
function authFilePath() {
  return path.join(app.getPath('userData'), 'auth.json');
}

// Machine fingerprint — soft device lock (prevents 1 key on 100 PCs)
function getMachineId() {
  const nets = os.networkInterfaces();
  const macs = [];
  for (const k of Object.keys(nets)) {
    for (const n of (nets[k] || [])) {
      if (n.mac && n.mac !== '00:00:00:00:00:00' && !n.internal) macs.push(n.mac);
    }
  }
  const raw = (macs[0] || '') + '|' + os.hostname() + '|' + os.platform();
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function readAuthCache() {
  try {
    const p = authFilePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function writeAuthCache(obj) {
  try {
    const p = authFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[auth] cache write failed:', e.message);
    return false;
  }
}

function clearAuthCache() {
  try { fs.unlinkSync(authFilePath()); } catch {}
}

// ============================================================
// USER OPERATIONS
// ============================================================

// Called from Activation screen (first run or after logout)
async function activateUser({ username, activation_key }) {
  if (!username || !activation_key) {
    return { success: false, error: 'Username and activation key required' };
  }
  const client = getAnonClient();
  const uname = String(username).trim().toLowerCase();
  const key   = String(activation_key).trim();

  const { data, error } = await client
    .from('tool_users')
    .select('*')
    .eq('username', uname)
    .eq('activation_key', key)
    .maybeSingle();

  if (error) return { success: false, error: 'Network error: ' + error.message };
  if (!data)  return { success: false, error: 'Invalid username or activation key' };
  if (data.is_blocked) return { success: false, error: 'Your account has been blocked. Contact admin.' };

  const expiresAt = new Date(data.expires_at);
  if (expiresAt.getTime() < Date.now()) {
    return { success: false, error: `License expired on ${expiresAt.toLocaleDateString()}` };
  }

  const machineId = getMachineId();
  // Device lock — if a machine_id is set and doesn't match, reject
  if (data.machine_id && data.machine_id !== machineId) {
    return { success: false, error: 'This license is already activated on another device.' };
  }

  // Update last_seen + bind machine_id (if not set)
  const patch = { last_seen_at: new Date().toISOString() };
  if (!data.machine_id) patch.machine_id = machineId;
  await client.from('tool_users').update(patch).eq('id', data.id);

  const cache = {
    user_id:        data.id,
    username:       data.username,
    activation_key: data.activation_key,
    full_name:      data.full_name || '',
    is_admin:       !!data.is_admin,
    expires_at:     data.expires_at,
    activated_at:   new Date().toISOString(),
    machine_id:     machineId,
  };
  writeAuthCache(cache);

  return { success: true, user: cache };
}

// Called on every app launch AND every 30 min in background
async function verifyStoredAuth() {
  const cache = readAuthCache();
  if (!cache) return { success: false, error: 'not activated', needsActivation: true };

  // Local expiry short-circuit (works offline)
  const expiresAt = new Date(cache.expires_at);
  if (expiresAt.getTime() < Date.now()) {
    return { success: false, error: 'License expired', expired: true };
  }

  // Try live check — if network fails, allow offline as long as local expiry is OK
  try {
    const client = getAnonClient();
    const { data, error } = await client
      .from('tool_users')
      .select('username, activation_key, expires_at, is_blocked, machine_id, full_name, is_admin')
      .eq('id', cache.user_id)
      .maybeSingle();

    if (error) {
      // Network error → allow offline based on cache
      return { success: true, user: cache, offline: true };
    }
    if (!data) {
      // User deleted from server
      clearAuthCache();
      return { success: false, error: 'License revoked', needsActivation: true };
    }
    if (data.is_blocked) {
      clearAuthCache();
      return { success: false, error: 'Your account has been blocked', blocked: true };
    }
    // Device changed?
    const currentMachine = getMachineId();
    if (data.machine_id && data.machine_id !== currentMachine) {
      clearAuthCache();
      return { success: false, error: 'License bound to a different device', needsActivation: true };
    }
    // Refresh cache with server truth (expiry might have been extended by admin)
    const fresh = {
      ...cache,
      full_name:  data.full_name || cache.full_name,
      is_admin:   !!data.is_admin,
      expires_at: data.expires_at,
    };
    writeAuthCache(fresh);
    // Update last_seen (best effort)
    client.from('tool_users').update({ last_seen_at: new Date().toISOString() }).eq('id', cache.user_id).then(() => {}, () => {});
    return { success: true, user: fresh, offline: false };
  } catch (e) {
    // Network broken — offline mode is fine as long as local cache is not expired
    return { success: true, user: cache, offline: true };
  }
}

function logoutUser() {
  clearAuthCache();
  return { success: true };
}

// ============================================================
// ADMIN OPERATIONS (require admin password unlock first)
// ============================================================

let _adminUnlocked = false;

async function adminLogin({ password }) {
  if (!password) return { success: false, error: 'Password required' };
  try {
    const client = getAnonClient();
    const { data, error } = await client
      .from('admin_config')
      .select('value')
      .eq('key', 'admin_password_hash')
      .maybeSingle();
    if (error || !data) return { success: false, error: 'Cannot reach server' };
    const ok = bcrypt.compareSync(String(password), data.value);
    if (!ok) return { success: false, error: 'Wrong admin password' };
    _adminUnlocked = true;
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || 'Login failed' };
  }
}

function adminLogout() { _adminUnlocked = false; return { success: true }; }
function isAdminUnlocked() { return _adminUnlocked; }

function requireAdmin() {
  if (!_adminUnlocked) throw new Error('Admin panel is locked. Enter admin password first.');
}

async function adminListUsers() {
  requireAdmin();
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('tool_users')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

function _randomKey(prefix = 'USER') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  const seg = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${prefix}-${seg(4)}-${seg(4)}-${seg(4)}-${new Date().getFullYear()}`;
}

async function adminCreateUser({ username, full_name, days, notes, activation_key, is_admin }) {
  requireAdmin();
  const admin = getAdminClient();
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) throw new Error('username required');
  const key = String(activation_key || '').trim() || _randomKey(uname.toUpperCase().slice(0, 6).replace(/[^A-Z0-9]/g, 'X'));
  const dayNum = Math.max(1, parseInt(days || 30, 10));
  const expires_at = new Date(Date.now() + dayNum * 86400 * 1000).toISOString();

  const { data, error } = await admin
    .from('tool_users')
    .insert({
      username: uname,
      activation_key: key,
      full_name: String(full_name || '').trim(),
      expires_at,
      notes: String(notes || '').trim(),
      is_admin: !!is_admin,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function adminSetIsAdmin({ id, is_admin }) {
  requireAdmin();
  const adminC = getAdminClient();
  const { data, error } = await adminC
    .from('tool_users')
    .update({ is_admin: !!is_admin })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function adminExtendUser({ id, days }) {
  requireAdmin();
  const admin = getAdminClient();
  const dayNum = Math.max(1, parseInt(days || 30, 10));

  // Find current expiry
  const { data: existing, error: e1 } = await admin
    .from('tool_users').select('expires_at').eq('id', id).maybeSingle();
  if (e1 || !existing) throw new Error(e1?.message || 'User not found');

  // If already expired, start from now; else extend from current expiry
  const base = Math.max(Date.now(), new Date(existing.expires_at).getTime());
  const newExpiry = new Date(base + dayNum * 86400 * 1000).toISOString();

  const { data, error } = await admin
    .from('tool_users')
    .update({ expires_at: newExpiry, is_blocked: false })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function adminSetBlocked({ id, blocked }) {
  requireAdmin();
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('tool_users')
    .update({ is_blocked: !!blocked })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function adminResetDevice({ id }) {
  requireAdmin();
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('tool_users')
    .update({ machine_id: '' })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function adminDeleteUser({ id }) {
  requireAdmin();
  const admin = getAdminClient();
  const { error } = await admin.from('tool_users').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function adminChangePassword({ newPassword }) {
  requireAdmin();
  if (!newPassword || String(newPassword).length < 6) throw new Error('Password must be at least 6 characters');
  const hash = bcrypt.hashSync(String(newPassword), 10);
  const admin = getAdminClient();
  const { error } = await admin
    .from('admin_config')
    .upsert({ key: 'admin_password_hash', value: hash });
  if (error) throw new Error(error.message);
  return { success: true };
}

module.exports = {
  // User
  activateUser,
  verifyStoredAuth,
  logoutUser,
  readAuthCache,
  getMachineId,
  // Admin
  adminLogin,
  adminLogout,
  isAdminUnlocked,
  adminListUsers,
  adminCreateUser,
  adminExtendUser,
  adminSetBlocked,
  adminResetDevice,
  adminDeleteUser,
  adminChangePassword,
  adminSetIsAdmin,
};
