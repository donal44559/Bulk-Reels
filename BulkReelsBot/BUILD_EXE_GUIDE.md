# 🚀 Build .exe — Step-by-Step Guide

Ei guide follow korle tomar tool er ekta **standalone Windows EXE** toiri hobe (portable — user er install korte hobe na, shudhu double-click kore cholbe). No npm, no commands user er jonno.

---

## ⚡ Easiest Way: One-Click Build (Windows)

Project folder e **`BUILD_EXE.bat`** file ta ache. **Double-click** korlei build hoye jabe. Script e sob thik kora ache (node/npm check, `npm install`, `npm run pack:win`, output path).

Manual way (nichhe) o same kaj kore.

---

## Ki Toiri Hobe

**Output file (portable):** `release\BulkReelsUploadPro-1.4.6.exe`
- Size: ~80-100 MB
- First launch e: Chromium engine (~170 MB) auto-download (one-time), Playwright-এর registry API diye
- **Total disk usage after first launch:** ~370 MB

---

## Requirements (One-time Setup)

### 1. Node.js Install (jodi na thake)
- Download: https://nodejs.org (LTS version, 20.x ba 22.x)
- Install koro, default settings

### 2. Verify Install
CMD/PowerShell kholo:
```
node --version
npm --version
```
Duita version number ashle ok.

---

## Build Steps (Manual)

### Step 1: Project Prepare Koro
Terminal e project folder e jao:
```
cd C:\path\to\BulkReelsBot
```

### Step 2: Dependencies Install
```
npm install
```
⏳ 3-5 min. Sob packages download hobe — **playwright 1.59.0** o. **Browser engine download HOBE NA** (ami config theke soriye diyechi — user first launch e registry API diye nibe). **better-sqlite3**-er jonno internet lagbe (prebuilt binary), na thakle compiler (Visual Studio Build Tools) lagbe.

### Step 3: Build the Portable EXE 🎯
```
npm run pack:win
```
⏳ **10-20 min** first time e (Electron binary ~100 MB download hobe).

Success hole output:
```
release\BulkReelsUploadPro-1.4.6.exe
```

### Step 4: EXE File Find Koro
```
release\
├── BulkReelsUploadPro-1.4.6.exe    ← EI TA USER KE DAO ✅
├── win-unpacked/                    ← Ignore
└── builder-effective-config.yaml    ← Ignore
```

---

## User Perspective (jokhon cholabe)

1. `BulkReelsUploadPro-1.4.6.exe` double-click → Windows SmartScreen warning ashte pare (unsigned exe — "More info" → "Run anyway")
2. **First Launch:** "🚀 First-time Setup" window ashbe → Chromium engine (~170 MB) download
   - ⏳ Internet speed depending — 2-10 min
3. **Activation Screen** → username + activation key
4. Dashboard chalu!

**Next launches:** No download, direct activation check → dashboard.

---

## Troubleshooting

### "electron-builder command not found"
```
npm install
```
Re-run kore dekho `node_modules/.bin/electron-builder` ache kina.

### better-sqlite3 build error (Visual Studio node-gyp)
- `npm install` er somoy prebuilt binary download na hole ei error ase.
- Fix: **Visual Studio Build Tools** (Desktop development with C++) install kora, ba internet thik thakle `npm install` re-run.

### Build atkache "downloading electron... 0%"
Slow internet ba VPN try koro, tarpor `npm run pack:win` re-run.

### First launch Setup Failed popup
User er internet check koro. Chromium download er jonno ~170 MB internet lagbe.

### Antivirus "Trojan detected"
False positive — electron packagers ke sometimes AV bhul kore. Whitelist add koro (Windows Defender → Exclusions).

---

## Version Update Kore Notun exe Publish

1. `package.json` e version bump (e.g. `1.4.6` → `1.5.0`)
2. Rebuild: `npm run pack:win`
3. Output: `release\BulkReelsUploadPro-1.5.0.exe`
4. Upload + Admin Panel → App Updates → Publish

---

## Quick Reference (Copy-Paste)

**Full build (first time):**
```
cd C:\path\to\BulkReelsBot
npm install
npm run pack:win
```

**Easiest:** Double-click **`BUILD_EXE.bat`**

**Just test locally (no exe build):**
```
npm start
```

**Find output:**
```
release\BulkReelsUploadPro-1.4.6.exe
```

---

**Kono issue hole full error message pathao — ami help korbo!** 🚀
