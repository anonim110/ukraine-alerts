const GEO_URL = 'https://cdn.jsdelivr.net/gh/darmat1/ukraine-geo-data@main/geodata/Ukraine.geojson';
const ALERTS_URL = 'https://tryvoha.online/api/v1/alerts';
const REFRESH_MS = 30_000;

const OBLAST_NAMES = {
  vinnytska: 'Вінницька область', volynska: 'Волинська область',
  dnipropetrovska: 'Дніпропетровська область', donetska: 'Донецька область',
  zhytomyrska: 'Житомирська область', zakarpatska: 'Закарпатська область',
  zaporizka: 'Запорізька область', 'ivano-frankivska': 'Івано-Франківська область',
  kyivska: 'Київська область', kirovohradska: 'Кіровоградська область',
  luhanska: 'Луганська область', lvivska: 'Львівська область', kyiv: 'Київ',
  mykolaivska: 'Миколаївська область', odeska: 'Одеська область',
  poltavska: 'Полтавська область', rivnenska: 'Рівненська область',
  sumska: 'Сумська область', ternopilska: 'Тернопільська область',
  kharkivska: 'Харківська область', khersonska: 'Херсонська область',
  khmelnytska: 'Хмельницька область', cherkaska: 'Черкаська область',
  chernivetska: 'Чернівецька область', chernihivska: 'Чернігівська область',
  krym: 'Автономна Республіка Крим', crimea: 'Автономна Республіка Крим',
};

const state = {
  alerts: null,
  geo: null,
  geoLayer: null,
  regionLayers: new Map(),
  filter: '',
  soundEnabled: false,
  previousDangerRegions: new Set(),
  hasLoadedOnce: false,
};

const $ = (id) => document.getElementById(id);
const elements = {
  activeCount: $('activeCount'), districtCount: $('districtCount'),
  topActiveCount: $('topActiveCount'), topDistrictCount: $('topDistrictCount'),
  regionList: $('regionList'), notice: $('notice'), updatedAt: $('updatedAt'),
  refreshButton: $('refreshButton'), searchInput: $('searchInput'),
  liveState: $('liveState'), liveText: $('liveText'), soundButton: $('soundButton'),
  regionTemplate: $('regionTemplate'),
};

const map = L.map('map', {
  zoomControl: true,
  attributionControl: true,
  minZoom: 5,
  maxZoom: 9,
  scrollWheelZoom: true,
  doubleClickZoom: false,
  boxZoom: false,
  zoomSnap: 0.25,
  preferCanvas: true,
});

map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution('Межі: darmat1/ukraine-geo-data');
map.fitBounds([[44.0, 21.5], [53.0, 41.5]], { padding: [10, 10] });

// Забороняємо подвійний тап/клік для зуму, але залишаємо звичайні жести карти.
document.addEventListener('dblclick', (event) => event.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (event) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300 && !event.target.closest('.leaflet-control-zoom')) event.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

function normalizeName(value = '') {
  return String(value).toLowerCase()
    .replaceAll('’', "'").replaceAll('ʼ', "'")
    .replace(/^м\.\s*/, 'місто ')
    .replace(/автономна республіка крим/g, 'крим')
    .replace(/область/g, '').replace(/місто/g, '')
    .replace(/[^а-яіїєґa-z0-9]/g, '').trim();
}

function featureName(feature) {
  const p = feature?.properties || {};
  return p.name || p.NAME_1 || p.NAME || p.shapeName || p.region || 'Невідомий регіон';
}

function buildAlertPayload(apiJson) {
  const rawAlerts = Array.isArray(apiJson?.alerts) ? apiJson.alerts : [];
  const regions = new Map();

  for (const alert of rawAlerts) {
    const isState = alert.type === 'state';
    const oblastSlug = isState ? alert.slug : alert.oblast_slug;
    const name = isState ? alert.name_uk : OBLAST_NAMES[oblastSlug];
    if (!name) continue;

    if (!regions.has(name)) {
      regions.set(name, { name, level: 'partial', alerts: [], startedAt: alert.started_at || null });
    }

    const region = regions.get(name);
    region.alerts.push({
      slug: alert.slug,
      location: alert.name_uk,
      locationType: alert.type,
      startedAt: alert.started_at || null,
    });

    if (isState) region.level = 'danger';
    if (alert.started_at && (!region.startedAt || new Date(alert.started_at) < new Date(region.startedAt))) {
      region.startedAt = alert.started_at;
    }
  }

  const normalizedRegions = [...regions.values()].map((region) => {
    const districtsBySlug = new Map();
    for (const alert of region.alerts) {
      if (alert.locationType !== 'district') continue;
      districtsBySlug.set(alert.slug, {
        slug: alert.slug,
        name: alert.location,
        startedAt: alert.startedAt,
      });
    }
    return {
      ...region,
      districts: [...districtsBySlug.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk')),
      alertCount: region.alerts.length,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'uk'));

  const districtCount = normalizedRegions.reduce((sum, region) => sum + region.districts.length, 0);
  return {
    ok: true,
    source: 'Tryvoha.online',
    updatedAt: apiJson?.updated_at || new Date().toISOString(),
    activeRegionCount: normalizedRegions.length,
    activeDistrictCount: districtCount,
    activeAlertCount: rawAlerts.length,
    regions: normalizedRegions,
  };
}

function statusForRegion(name) {
  const normalized = normalizeName(name);
  const region = (state.alerts?.regions || []).find((item) => normalizeName(item.name) === normalized);
  return region ? { level: region.level, region } : { level: 'safe', region: null };
}

function styleFeature(feature) {
  const { level } = statusForRegion(featureName(feature));
  return {
    color: '#111111',
    weight: 1,
    opacity: 1,
    fillColor: level === 'danger' ? '#c6332d' : level === 'partial' ? '#b97a24' : '#d4cec3',
    fillOpacity: level === 'safe' ? 0.9 : 0.94,
  };
}

function onEachFeature(feature, layer) {
  const name = featureName(feature);
  state.regionLayers.set(normalizeName(name), layer);

  layer.bindTooltip(() => {
    const status = statusForRegion(name);
    if (status.level === 'safe') return `${name} · БЕЗ АКТИВНИХ`;
    const districts = status.region?.districts?.length || 0;
    return status.level === 'danger'
      ? `${name} · ТРИВОГА · ${districts} РАЙ.`
      : `${name} · ${districts} РАЙ. ПІД ТРИВОГОЮ`;
  }, { className: 'region-tooltip', sticky: true, direction: 'top' });

  layer.on({
    mouseover(e) { e.target.setStyle({ weight: 2.2 }); e.target.bringToFront(); },
    mouseout(e) { if (state.geoLayer) state.geoLayer.resetStyle(e.target); },
    click(e) { map.fitBounds(e.target.getBounds(), { padding: [40, 40], maxZoom: 7.25 }); },
  });
}

async function loadGeo() {
  try {
    const response = await fetch(GEO_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`GeoJSON ${response.status}`);
    state.geo = await response.json();
    renderMap(true);
  } catch (error) {
    console.error(error);
    showNotice('Не вдалося завантажити межі областей. Перевірте інтернет.');
  }
}

function renderMap(fit = false) {
  if (!state.geo) return;
  const previousCenter = map.getCenter();
  const previousZoom = map.getZoom();
  state.regionLayers.clear();
  if (state.geoLayer) state.geoLayer.remove();
  state.geoLayer = L.geoJSON(state.geo, { style: styleFeature, onEachFeature }).addTo(map);
  if (fit) map.fitBounds(state.geoLayer.getBounds(), { padding: [12, 12] });
  else map.setView(previousCenter, previousZoom, { animate: false });
}

function setConnection(kind, text) {
  elements.liveState.classList.remove('ok', 'error');
  if (kind) elements.liveState.classList.add(kind);
  elements.liveText.textContent = text;
}
function showNotice(message) { elements.notice.textContent = message; elements.notice.classList.remove('hidden'); }
function hideNotice() { elements.notice.classList.add('hidden'); }

function formatDuration(startedAt) {
  if (!startedAt) return '—';
  const diff = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const mins = Math.floor(diff / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}г ${m}хв` : `${m}хв`;
}

function renderList() {
  const query = state.filter.trim().toLowerCase();
  const regions = [...(state.alerts?.regions || [])]
    .sort((a, b) => (b.level === 'danger') - (a.level === 'danger') || b.districts.length - a.districts.length || a.name.localeCompare(b.name, 'uk'))
    .filter((region) => region.name.toLowerCase().includes(query) || region.districts.some((district) => district.name.toLowerCase().includes(query)));

  elements.regionList.replaceChildren();

  if (!regions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.alerts?.activeRegionCount === 0 ? 'Наразі активних повітряних тривог немає.' : 'За вашим пошуком нічого не знайдено.';
    elements.regionList.appendChild(empty);
    return;
  }

  regions.forEach((region, index) => {
    const node = elements.regionTemplate.content.cloneNode(true);
    const row = node.querySelector('.region-row');
    row.classList.add(region.level);
    node.querySelector('.region-index').textContent = String(index + 1).padStart(2, '0');
    node.querySelector('h3').textContent = region.name;
    node.querySelector('.region-duration').textContent = formatDuration(region.startedAt);
    node.querySelector('.status-word').textContent = region.level === 'danger' ? 'Тривога в області' : 'Районна тривога';
    node.querySelector('.district-summary').textContent = region.districts.length
      ? `${region.districts.length} ${region.districts.length === 1 ? 'район' : 'районів'}`
      : 'вся область';

    const districtList = node.querySelector('.district-list');
    const visibleDistricts = query
      ? region.districts.filter((district) => district.name.toLowerCase().includes(query) || region.name.toLowerCase().includes(query))
      : region.districts;

    visibleDistricts.forEach((district) => {
      const item = document.createElement('div');
      item.className = 'district-item';
      item.innerHTML = '<span class="district-dot"></span><span class="district-name"></span><span class="district-time"></span>';
      item.querySelector('.district-name').textContent = district.name;
      item.querySelector('.district-time').textContent = formatDuration(district.startedAt);
      districtList.appendChild(item);
    });

    if (!region.districts.length && region.level === 'danger') {
      const item = document.createElement('div');
      item.className = 'district-item';
      item.innerHTML = '<span class="district-dot"></span><span class="district-name">Тривога оголошена для всієї області</span><span class="district-time"></span>';
      districtList.appendChild(item);
    }

    node.querySelector('.locate-button').addEventListener('click', () => focusRegion(region.name));
    row.addEventListener('dblclick', (event) => event.preventDefault());
    elements.regionList.appendChild(node);
  });
}

function focusRegion(name) {
  const layer = state.regionLayers.get(normalizeName(name));
  if (!layer?.getBounds) return;
  map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 7.25 });
  layer.openTooltip();
}

function beep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
    osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.26);
  } catch (error) { console.warn('Audio unavailable', error); }
}

function maybeNotifyNewAlerts() {
  const currentDanger = new Set((state.alerts?.regions || []).map((region) => normalizeName(region.name)));
  if (state.hasLoadedOnce && state.soundEnabled) {
    if ([...currentDanger].some((name) => !state.previousDangerRegions.has(name))) beep();
  }
  state.previousDangerRegions = currentDanger;
  state.hasLoadedOnce = true;
}

function updateCounters(data) {
  elements.activeCount.textContent = data.activeRegionCount;
  elements.districtCount.textContent = data.activeDistrictCount;
  elements.topActiveCount.textContent = data.activeRegionCount;
  elements.topDistrictCount.textContent = data.activeDistrictCount;
}

async function loadAlerts(manual = false) {
  if (manual) elements.refreshButton.disabled = true;
  setConnection('', 'Оновлення');
  try {
    const response = await fetch(ALERTS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Tryvoha API ${response.status}`);
    const data = buildAlertPayload(await response.json());
    state.alerts = data;
    updateCounters(data);
    elements.updatedAt.textContent = `Оновлення: ${new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(data.updatedAt))}`;
    hideNotice(); setConnection('ok', 'Наживо'); maybeNotifyNewAlerts(); renderList(); renderMap(false);
  } catch (error) {
    console.error(error);
    showNotice('Джерело даних тимчасово недоступне. Спробуйте оновити сторінку.');
    setConnection('error', 'Помилка');
  } finally { elements.refreshButton.disabled = false; }
}

elements.searchInput.addEventListener('input', (event) => { state.filter = event.target.value; renderList(); });
elements.refreshButton.addEventListener('click', () => loadAlerts(true));
elements.soundButton.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  elements.soundButton.setAttribute('aria-pressed', String(state.soundEnabled));
  elements.soundButton.textContent = `ЗВУК ${state.soundEnabled ? 'УВІМК' : 'ВИМК'}`;
  if (state.soundEnabled) beep();
});

loadGeo();
loadAlerts();
setInterval(() => loadAlerts(false), REFRESH_MS);
setInterval(renderList, 60_000);
window.addEventListener('resize', () => map.invalidateSize({ pan: false }));
