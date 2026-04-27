import { PANELS as DOTS } from '../config.js';



const SERVICES = [
  { host: 'jellyfin',                 name: 'Jellyfin',                    desc: 'Media player & library' },
  { host: 'jellyfin-force-transcode', name: 'Jellyfin — force transcode',  desc: 'HEVC-stripped proxy for Android TV' },
  { host: 'sonarr',                   name: 'Sonarr',                      desc: 'TV show management' },
  { host: 'radarr',                   name: 'Radarr',                      desc: 'Movie management' },
  { host: 'prowlarr',                 name: 'Prowlarr',                    desc: 'Indexer management' },
  { host: 'qbittorrent',              name: 'qBittorrent',                 desc: 'Download client' },
  { host: 'bazarr',                   name: 'Bazarr',                      desc: 'Subtitle management' },
  { host: 'navidrome',                name: 'Navidrome',                   desc: 'Music streaming server' },
  { host: 'ha',                       name: 'Home Assistant',              desc: 'Floodlights, sirens, automations' },
  { host: 'pihole',                   name: 'Pi-hole',                     desc: 'Network-wide DNS ad-blocker', path: '/admin/' },
  { host: 'tubearchivist',            name: 'Tube Archivist',              desc: 'YouTube archiver (kids YT shows)' },
];

const DOMAIN = 'office-computer-online-worldwide.org';

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function spawnBonusBee(zone) {
  const bee = document.createElement('div');
  bee.textContent = '🐝';
  bee.className = 'bee critter';
  const dur = 4 + Math.random() * 4;
  const name = `bonusbee${Date.now()}`;
  const kf = `
    @keyframes ${name} {
      0%   { left:${Math.random() * 80}%; top:${Math.random() * 60}%; transform: rotate(0deg); }
      25%  { left:${Math.random() * 80}%; top:${Math.random() * 60}%; transform: rotate(${(Math.random() - 0.5) * 20}deg) translateY(-3px); }
      50%  { left:${Math.random() * 80}%; top:${Math.random() * 60}%; transform: rotate(${(Math.random() - 0.5) * 20}deg) translateY(2px); }
      75%  { left:${Math.random() * 80}%; top:${Math.random() * 60}%; transform: rotate(${(Math.random() - 0.5) * 20}deg) translateY(-2px); }
      100% { left:${Math.random() * 80}%; top:${Math.random() * 60}%; transform: rotate(0deg); }
    }
  `;
  const style = document.createElement('style');
  style.textContent = kf;
  document.head.appendChild(style);
  bee.style.animation = `${name} ${dur}s ease-in-out infinite`;
  zone.appendChild(bee);
}

function mount() {
  const root = document.createElement('div');
  root.className = 'panel panel-links scrollable';
  root.id = 'panelLinks';
  const links = SERVICES.map(s => `
    <a class="service-link" href="https://${s.host}.${DOMAIN}${s.path || ''}" target="_blank" rel="noopener noreferrer">
      <div class="service-info">
        <div class="service-name">${s.name}</div>
        <div class="service-host">${s.host}.${DOMAIN}</div>
      </div>
      <div class="service-arrow">→</div>
    </a>
  `).join('');
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone">
        <div class="bee critter bee-0">🐝</div>
        <div class="bee critter bee-1">🐝</div>
      </div>
      <div class="section-title-yellow">SERVICES</div>
      ${links}
      <div class="dots">${dots()}</div>
    </div>
  `;
  return root;
}

function onShow() {
  // Spawn one extra bee per show, for flair
  const zone = document.querySelector('#panelLinks .critter-zone');
  if (zone) spawnBonusBee(zone);
}

export default { id: 'links', mount, onShow };
