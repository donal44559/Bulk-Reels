// ============================================================
// Update / Version Check Service
// Talks to Supabase `app_versions` table to find the latest version.
// Compares against the currently installed version (package.json).
//
// Data preservation guarantee:
//   All user data lives in Electron's userData folder, which is OUTSIDE
//   the install folder. Installing a new version over the old one only
//   replaces app code — profiles.db, auth.json, settings.json, cookies,
//   etc. remain untouched. This is enforced by electron-builder config
//   in package.json:  "deleteAppDataOnUninstall": false
// ============================================================

const { app } = require('electron');
const { getAnonClient, getAdminClient } = require('./supabaseClient.js');

function getCurrentVersion() {
  try {
    // In packaged app, app.getVersion() reads from package.json
    return app.getVersion() || require('../../package.json').version || '0.0.0';
  } catch {
    try { return require('../../package.json').version || '0.0.0'; } catch { return '0.0.0'; }
  }
}

// Semver compare: returns positive if a > b, negative if a < b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Called by renderer on app launch AND every 30 min in background
async function checkForUpdates() {
  const current = getCurrentVersion();
  try {
    const client = getAnonClient();
    const { data, error } = await client
      .from('app_versions')
      .select('*')
      .eq('is_active', true)
      .order('published_at', { ascending: false })
      .limit(1);

    if (error) return { success: false, error: error.message, currentVersion: current };
    const latest = Array.isArray(data) ? data[0] : data;
    if (!latest) return { success: true, hasUpdate: false, currentVersion: current };

    const cmp = compareVersions(latest.version, current);
    const hasUpdate = cmp > 0;

    // Force update if:
    //   - the row itself is marked force, OR
    //   - current version is below min_version required
    let mustForce = false;
    if (hasUpdate) {
      if (latest.is_force) mustForce = true;
      if (latest.min_version && compareVersions(current, latest.min_version) < 0) mustForce = true;
    }

    return {
      success: true,
      hasUpdate,
      forceUpdate: mustForce,
      currentVersion: current,
      latestVersion: latest.version,
      downloadUrl:   latest.download_url,
      releaseNotes:  latest.release_notes || '',
      publishedAt:   latest.published_at,
    };
  } catch (e) {
    return { success: false, error: e.message || 'Update check failed', currentVersion: current };
  }
}

// ---------- Admin operations (require admin panel unlock) ----------

async function adminListVersions() {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('app_versions')
    .select('*')
    .order('published_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function adminAddVersion({ version, download_url, release_notes, is_force, min_version }) {
  if (!version) throw new Error('version required');
  if (!download_url) throw new Error('download URL required');
  const admin = getAdminClient();

  // Deactivate all previous versions — only newest active row is served
  await admin.from('app_versions').update({ is_active: false }).eq('is_active', true);

  const { data, error } = await admin
    .from('app_versions')
    .insert({
      version: String(version).trim(),
      download_url: String(download_url).trim(),
      release_notes: String(release_notes || '').trim(),
      is_force: !!is_force,
      min_version: String(min_version || '').trim(),
      is_active: true,
    })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function adminUpdateVersion({ id, patch }) {
  const admin = getAdminClient();
  const clean = {};
  const allowed = ['version', 'download_url', 'release_notes', 'is_force', 'min_version', 'is_active'];
  for (const k of allowed) if (k in (patch || {})) clean[k] = patch[k];
  const { data, error } = await admin
    .from('app_versions')
    .update(clean)
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function adminDeleteVersion({ id }) {
  const admin = getAdminClient();
  const { error } = await admin.from('app_versions').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { success: true };
}

module.exports = {
  getCurrentVersion,
  checkForUpdates,
  compareVersions,
  adminListVersions,
  adminAddVersion,
  adminUpdateVersion,
  adminDeleteVersion,
};
