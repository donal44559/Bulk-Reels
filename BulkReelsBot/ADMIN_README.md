# Admin & User System — Bulk Reels Upload Pro

## First-time Setup

### 1. Supabase (already done)
- Project: `bulk-reels-upload-pro`
- URL: `https://tcfpfvzjhguxpdhncnel.supabase.co`
- SQL schema installed via `supabase_setup.sql`

### 2. Owner Login (your account)
- **Username:** `eusuf`
- **Activation Key:** `EUSUF-OWNER-9K7X-MASTER-2026`
- Expiry: 10 years from schema install

### 3. Admin Panel Password
- **Default password:** `Abc123@#$Eusuf2026`
- **CHANGE IT** after first login: Admin Panel → 🔑 Change Password

---

## How It Works

### For End Users
1. Open app → Activation Screen appears
2. Enter username + activation key
3. On success → data cached locally in `%APPDATA%/bulk-reels-upload-pro/auth.json`
4. Next launches → auto-verify silently (works offline for cached expiry)
5. Background check every 30 min → catches admin block/extension in real-time
6. LOGOUT button clears the cache → must re-activate next launch

### For You (Admin)
1. Sidebar → **👑 Admin Panel** → enter admin password
2. See all users with expiry, status, device lock
3. **+ Add User** → generate a new license (7/15/30/90 days or custom)
4. **+Days** → extend an existing user's validity
5. **Block/Unblock** → disable a user instantly (they get logged out on next check)
6. **Reset Dev** → let a user re-activate on a new computer
7. **Del** → permanently delete a user

### Device Lock
- First activation binds the license to that PC's hardware fingerprint (MAC + hostname)
- Same license cannot activate on another PC unless admin clicks **Reset Dev**
- Prevents license sharing

### Data Preservation on Updates
- All user data lives in Electron's `userData` folder:
  - `profiles.db` — profile database
  - `auth.json` — license cache
  - `settings.json` — app settings
  - Profile browser sessions (cookies, extensions, etc.)
- Install folder gets replaced on updates → user data stays intact
- NSIS installer configured with `deleteAppDataOnUninstall: false`

---

## Building the .exe

```bash
npm install
npm run build          # compile React
npm run pack:win       # produces release/BulkReelsUploadPro-1.5.0.exe (portable)
```

The exe is a self-contained installer. Users just download & install.
