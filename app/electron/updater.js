'use strict';
// Update-Prüfung über die downloads.json der Website.
// Ablauf: check() → download() → install(). Fortschritt kommt über onStatus.

const { app, net, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const WEBSITE = 'https://leonhr03.github.io/pdf-editor/';
const FEED_URL = process.env.PDF_EDITOR_UPDATE_URL || WEBSITE + 'downloads.json';

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Welche Datei aus downloads.json passt zu diesem Rechner?
function platformKey() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macArm' : 'macIntel';
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'linuxAppImage' : 'linuxDeb';
  return '';
}

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message += stderr ? '\n' + stderr : '';
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

class Updater {
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.state = { phase: 'idle', current: app.getVersion() };
    this.latest = null;
    this.file = '';
    this.busy = false;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onStatus(this.state);
  }

  async check() {
    if (this.busy) return this.state;
    this.set({ phase: 'checking', error: '', progress: 0 });
    try {
      const res = await net.fetch(FEED_URL + (FEED_URL.includes('?') ? '&' : '?') + 't=' + Date.now(), {
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('Server antwortet mit ' + res.status);
      const data = await res.json();
      const key = platformKey();
      const item = data && data.files && data.files[key];
      if (!data || !parseVersion(data.version)) throw new Error('Die Versionsdatei der Website ist ungültig.');
      this.latest = { version: data.version, item: item || null, key };
      if (!isNewer(data.version, app.getVersion())) {
        this.set({ phase: 'current', latest: data.version, checkedAt: Date.now() });
      } else if (!item || !item.url) {
        this.set({ phase: 'manual', latest: data.version, checkedAt: Date.now() });
      } else {
        this.set({ phase: 'available', latest: data.version, size: item.size || 0, checkedAt: Date.now() });
      }
    } catch (error) {
      this.set({ phase: 'error', error: 'Prüfung fehlgeschlagen: ' + error.message });
    }
    return this.state;
  }

  async download() {
    if (this.busy) return this.state;
    if (!this.latest || !this.latest.item) await this.check();
    if (this.state.phase !== 'available') return this.state;
    const { item, version } = this.latest;
    this.busy = true;
    this.set({ phase: 'downloading', progress: 0 });
    try {
      const dir = path.join(app.getPath('temp'), 'pdf-editor-update');
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      const name = path.basename(new URL(item.url).pathname) || 'update';
      const file = path.join(dir, name);

      const res = await net.fetch(item.url);
      if (!res.ok || !res.body) throw new Error('Download fehlgeschlagen (' + res.status + ')');
      const total = Number(res.headers.get('content-length')) || item.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      const reader = res.body.getReader();
      let got = 0;
      let lastSent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (total && now - lastSent > 120) {
          lastSent = now;
          this.set({ progress: Math.min(1, got / total) });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

      if (item.size && got !== item.size) throw new Error('Die heruntergeladene Datei ist unvollständig.');
      if (item.sha256 && hash.digest('hex') !== String(item.sha256).toLowerCase()) {
        throw new Error('Prüfsumme stimmt nicht – Update wurde verworfen.');
      }
      this.file = file;
      this.set({ phase: 'ready', progress: 1, latest: version });
    } catch (error) {
      this.set({ phase: 'error', error: error.message });
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  async install() {
    if (this.state.phase !== 'ready' || !this.file) return this.state;
    if (!app.isPackaged) {
      this.set({ phase: 'error', error: 'Installieren geht nur in der fertig installierten App.' });
      return this.state;
    }
    this.busy = true;
    this.set({ phase: 'installing' });
    try {
      if (process.platform === 'darwin') await this.installMac();
      else if (process.platform === 'win32') this.installWindows();
      else await this.installLinux();
    } catch (error) {
      this.busy = false;
      this.set({ phase: 'error', error: 'Installation fehlgeschlagen: ' + error.message });
    }
    return this.state;
  }

  // macOS: DMG einhängen, App kopieren, nach dem Beenden austauschen und neu starten.
  async installMac(targetOverride) {
    const target = targetOverride || path.resolve(process.execPath, '..', '..', '..');
    if (!target.endsWith('.app')) throw new Error('App-Pfad nicht gefunden.');
    const parent = path.dirname(target);
    try {
      fs.accessSync(parent, fs.constants.W_OK);
      fs.accessSync(target, fs.constants.W_OK);
    } catch (_) {
      // Keine Schreibrechte (z. B. Standardbenutzer): DMG öffnen, Nutzer zieht die App selbst.
      await shell.openPath(this.file);
      this.busy = false;
      this.set({ phase: 'manual-install' });
      return;
    }

    const work = path.dirname(this.file);
    const mount = path.join(work, 'mnt');
    const staged = path.join(work, 'staged', path.basename(target));
    await fsp.mkdir(mount, { recursive: true });
    await execFileP('hdiutil', ['attach', this.file, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
    try {
      const appName = (await fsp.readdir(mount)).find((n) => n.endsWith('.app'));
      if (!appName) throw new Error('Keine App im Update gefunden.');
      await fsp.mkdir(path.dirname(staged), { recursive: true });
      await execFileP('ditto', [path.join(mount, appName), staged]);
    } finally {
      await execFileP('hdiutil', ['detach', mount, '-quiet', '-force']).catch(() => {});
    }
    await execFileP('codesign', ['--verify', '--deep', '--strict', staged]);
    await execFileP('xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});

    const script = path.join(work, 'install.sh');
    await fsp.writeFile(script, [
      '#!/bin/bash',
      'PID="$1"; TARGET="$2"; STAGED="$3"; RELAUNCH="$4"',
      'for i in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
      'rm -rf "$TARGET.old"',
      'if mv "$TARGET" "$TARGET.old" && mv "$STAGED" "$TARGET"; then',
      '  rm -rf "$TARGET.old"',
      'else',
      '  rm -rf "$TARGET"; mv "$TARGET.old" "$TARGET"',
      'fi',
      'touch "$TARGET"',
      '[ "$RELAUNCH" = "1" ] && open "$TARGET"',
      'exit 0',
      ''
    ].join('\n'), { mode: 0o755 });

    const relaunch = targetOverride ? '0' : '1';
    spawn('/bin/bash', [script, String(process.pid), target, staged, relaunch], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    if (!targetOverride) setTimeout(() => app.quit(), 300);
  }

  // Windows: NSIS-Installer still ausführen und danach die App wieder starten.
  installWindows() {
    spawn(this.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
  }

  // Linux: AppImage direkt austauschen, .deb über die Paketverwaltung öffnen.
  async installLinux() {
    const appImage = process.env.APPIMAGE;
    if (appImage && this.file.endsWith('.AppImage')) {
      const tmp = appImage + '.new';
      await fsp.copyFile(this.file, tmp);
      await fsp.chmod(tmp, 0o755);
      await fsp.rename(tmp, appImage);
      spawn(appImage, [], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 300);
      return;
    }
    await shell.openPath(this.file);
    this.busy = false;
    this.set({ phase: 'manual-install' });
  }
}

module.exports = { Updater, isNewer, parseVersion, platformKey, WEBSITE, FEED_URL };
