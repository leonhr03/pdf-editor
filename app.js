(() => {
  const detectPlatform = () => {
    const data = navigator.userAgentData;
    const platform = ((data && data.platform) || navigator.platform || '').toLowerCase();
    if (/mac/.test(platform)) return 'mac';
    if (/win/.test(platform)) return 'win';
    if (/linux|cros/.test(platform)) return 'linux';

    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod|android/.test(ua)) return 'mobile';
    if (ua.includes('mac os x')) return 'mac';
    if (ua.includes('windows')) return 'win';
    if (ua.includes('linux')) return 'linux';
    return '';
  };

  const detectIntelMac = async () => {
    const data = navigator.userAgentData;
    if (data && typeof data.getHighEntropyValues === 'function') {
      try {
        const values = await data.getHighEntropyValues(['architecture', 'bitness']);
        const arch = String(values.architecture || '').toLowerCase();
        return arch === 'x86' || arch === 'x64' || arch === 'x86_64';
      } catch (_) {}
    }
    const arch = String((data && data.architecture) || '').toLowerCase();
    return arch === 'x86' || arch === 'x64' || arch === 'x86_64';
  };

  let heroKey = '';
  let downloadsData = null;

  const updateHeroDownload = () => {
    const cta = document.getElementById('heroDownload');
    if (!cta || !heroKey || !downloadsData) return;
    const item = downloadsData.files && downloadsData.files[heroKey];
    if (!item) return;
    cta.href = item.url || item.file;
    cta.setAttribute('download', '');
  };

  const selectIntelMac = () => {
    const arm = document.querySelector('[data-download="macArm"]');
    const intel = document.querySelector('[data-download="macIntel"]');
    if (arm && intel) {
      arm.classList.remove('main');
      intel.classList.add('main');
    }
    heroKey = 'macIntel';
    const cta = document.getElementById('heroDownload');
    if (cta) cta.textContent = 'Für macOS (Intel) herunterladen';
    updateHeroDownload();
  };

  const platform = detectPlatform();
  const labels = {
    mac: 'Für macOS herunterladen',
    win: 'Für Windows herunterladen',
    linux: 'Für Linux herunterladen',
    mobile: 'Downloads ansehen'
  };

  if (platform) {
    const card = document.querySelector('[data-platform="' + platform + '"]');
    if (card) {
      card.classList.add('is-recommended');
      const badge = card.querySelector('.recommend');
      if (badge) badge.hidden = false;
    }

    const cta = document.getElementById('heroDownload');
    if (cta && labels[platform]) cta.textContent = labels[platform];

    if (platform === 'mac') heroKey = 'macArm';
    if (platform === 'win') heroKey = 'win';
    if (platform === 'linux') heroKey = 'linuxAppImage';
  }

  if (platform === 'mac') {
    detectIntelMac().then((intelMac) => {
      if (intelMac) selectIntelMac();
    });
  }

  const formatSize = (bytes) => Math.round(bytes / 1e6) + ' MB';

  const typeFor = (file) => {
    const ext = file.split('.').pop().toLowerCase();
    if (ext === 'appimage') return 'AppImage';
    if (ext === 'deb') return 'DEB';
    return ext.toUpperCase();
  };

  fetch('downloads.json', { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error('downloads.json');
      return response.json();
    })
    .then((data) => {
      downloadsData = data;
      updateHeroDownload();

      if (data.version) {
        document.querySelectorAll('[data-version]').forEach((node) => {
          node.textContent = node.classList.contains('version') ? 'Version ' + data.version : data.version;
        });
      }

      document.querySelectorAll('[data-download]').forEach((link) => {
        const item = data.files && data.files[link.dataset.download];
        if (!item) return;
        link.href = item.url || item.file;
        const size = link.querySelector('[data-size]');
        if (size) size.textContent = typeFor(item.file) + ' · ' + formatSize(item.size);
      });
    })
    .catch(() => {});
})();
