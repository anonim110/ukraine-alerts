const GEO_URL = 'https://cdn.jsdelivr.net/gh/darmat1/ukraine-geo-data@main/geodata/Ukraine.geojson';
const ALERTS_URL = 'https://tryvoha.online/api/v1/alerts';
const REFRESH_MS = 30_000;

const OBLAST_NAMES = {
  vinnytska: 'Вінницька область',
  volynska: 'Волинська область',
  dnipropetrovska: 'Дніпропетровська область',
  donetska: 'Донецька область',
  zhytomyrska: 'Житомирська область',
  zakarpatska: 'Закарпатська область',
  zaporizka: 'Запорізька область',
  'ivano-frankivska': 'Івано-Франківська область',
  kyivska: 'Київська область',
  kirovohradska: 'Кіровоградська область',
  luhanska: 'Луганська область',
  lvivska: 'Львівська область',
  kyiv: 'Київ',
  mykolaivska: 'Миколаївська область',
  odeska: 'Одеська область',
  poltavska: 'Полтавська область',
  rivnenska: 'Рівненська область',
  sumska: 'Сумська область',
  ternopilska: 'Тернопільська область',
  kharkivska: 'Харківська область',
  khersonska: 'Херсонська область',
  khmelnytska: 'Хмельницька область',
  cherkaska: 'Черкаська область',
  chernivetska: 'Чернівецька область',
  chernihivska: 'Чернігівська область',
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

const elements = {
  activeCount: document.getElementById('activeCount'),
  regionList: document.getElementById('regionList'),
  notice: document.getElementById('notice'),
  updatedAt: document.getElementById('updatedAt'),
  refreshButton: document.getElementById('refreshButton'),
  searchInput: document.getElementById('searchInput'),
  liveState: document.getElementById('liveState'),
  liveText: document.getElementById('liveText'),
  soundButton: document.getElementById('soundButton'),
  regionTemplate: document.getElementById('regionTemplate'),
};

const map = L.map('map', {
  zoomControl: true,
  attributionControl: true,
  minZoom: 5,
  maxZoom: 9,
  scrollWheelZoom: true,
  zoomSnap: 0.25,
  preferCanvas: true,
});

map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution('Межі: darmat1/ukraine-geo-data');
map.fitBounds([[44.0, 21.5], [53.0, 41.5]], { padding: [10, 10] });

function normalizeName(value = '') {
  return String(value)
    .toLowerCase()
    .replaceAll('’', "'")
    .replaceAll('ʼ', "'")
    .replace(/^м\.\s*/, 'місто ')
    .replace(/автономна республіка крим/g, 'крим')
    .replace(/область/g, '')
    .replace(/місто/g, '')
    .replace(/[^а-яіїєґa-z0-9]/g, '')
    .trim();
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
      regions.set(name, {
        name,
        level: 'partial',
        alerts: [],
        startedAt: alert.started_at || null,
        types: [],
      });
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

  const normalizedRegions = [...regions.values()]
    .map((region) => ({
      ...region,
      types: [region.level === 'danger' ? 'air_raid' : 'district_air_raid'],
      alertCount: region.alerts.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'));

  return {
    ok: true,
    source: 'Tryvoha.online',
    updatedAt: apiJson?.updated_at || new Date().toISOString(),
    activeRegionCount: normalizedRegions.length,
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
  const fillColor = level === 'danger' ? '#c8322d' : level === 'partial' ? '#b87a23' : '#d5d0c7';

  return {
    color: '#111111',
    weight: 1,
    opacity: 1,
    fillColor,
    fillOpacity: level === 'safe' ? 0.9 : 0.92,
  };
}

function onEachFeature(feature, layer) {
  const name = featureName(feature);
  state.regionLayers.set(normalizeName(name), layer);

  layer.bindTooltip(() => {
    const status = statusForRegion(name);
    const label = status.level === 'danger'
      ? 'ТРИВОГА В ОБЛАСТІ'
      : status.level === 'partial'
        ? 'ТРИВОГА В РАЙОНІ'
        : 'БЕЗ АКТИВНИХ';
    return `${name} · ${label}`;
  }, { className: 'region-tooltip', sticky: true, direction: 'top' });

  layer.on({
    mouseover(event) {
      event.target.setStyle({ weight: 2.2 });
      event.target.bringToFront();
    },
    mouseout(event) {
      if (state.geoLayer) state.geoLayer.resetStyle(event.target);
    },
    click(event) {
      map.fitBounds(event.target.getBounds(), { padding: [45, 45], maxZoom: 7.5 });
    },
  });
}

async function loadGeo() {
  try {
    const response = await fetch(GEO_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`GeoJSON ${response.status}`);
    state.geo = await response.json();
    renderMap();
  } catch (error) {
    console.error(error);
    showNotice('Не вдалося завантажити межі областей. Перевірте підключення до інтернету.');
  }
}

function renderMap() {
  if (!state.geo) return;
  state.regionLayers.clear();
  if (state.geoLayer) state.geoLayer.remove();
  state.geoLayer = L.geoJSON(state.geo, { style: styleFeature, onEachFeature }).addTo(map);
  map.fitBounds(state.geoLayer.getBounds(), { padding: [14, 14] });
}

function setConnection(kind, text) {
  elements.liveState.classList.remove('ok', 'error');
  if (kind) elements.liveState.classList.add(kind);
  elements.liveText.textContent = text;
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.classList.remove('hidden');
}

function hideNotice() {
  elements.notice.classList.add('hidden');
}

function formatDuration(startedAt) {
  if (!startedAt) return '—';
  const diff = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const mins = Math.floor(diff / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}г ${m}хв` : `${m}хв`;
}

function typeLabel(type) {
  if (type === 'air_raid') return 'Повітряна тривога';
  if (type === 'district_air_raid') return 'Тривога в районі';
  return type;
}

function renderList() {
  const query = state.filter.trim().toLowerCase();
  const regions = [...(state.alerts?.regions || [])]
    .sort((a, b) => {
      const priorityA = a.level === 'danger' ? 2 : 1;
      const priorityB = b.level === 'danger' ? 2 : 1;
      return priorityB - priorityA || a.name.localeCompare(b.name, 'uk');
    })
    .filter((region) => region.name.toLowerCase().includes(query));

  elements.regionList.replaceChildren();

  if (!regions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.alerts?.activeRegionCount === 0
      ? 'Наразі активних повітряних тривог немає.'
      : 'За вашим пошуком нічого не знайдено.';
    elements.regionList.appendChild(empty);
    return;
  }

  regions.forEach((region, index) => {
    const node = elements.regionTemplate.content.cloneNode(true);
    const row = node.querySelector('.region-row');
    node.querySelector('.region-index').textContent = String(index + 1).padStart(2, '0');
    node.querySelector('h3').textContent = region.name;
    node.querySelector('.region-duration').textContent = formatDuration(region.startedAt);

    const typeWrap = node.querySelector('.region-types');
    region.types.forEach((type) => {
      const chip = document.createElement('span');
      chip.className = `type-chip ${type === 'air_raid' ? 'air' : 'other'}`;
      chip.textContent = typeLabel(type);
      typeWrap.appendChild(chip);
    });

    const locate = node.querySelector('.locate-button');
    locate.addEventListener('click', () => focusRegion(region.name));
    row.dataset.region = region.name;
    elements.regionList.appendChild(node);
  });
}

function focusRegion(name) {
  const layer = state.regionLayers.get(normalizeName(name));
  if (!layer?.getBounds) return;
  map.fitBounds(layer.getBounds(), { padding: [45, 45], maxZoom: 7.5 });
  layer.openTooltip();
}

function beep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch (error) {
    console.warn('Audio unavailable', error);
  }
}

function maybeNotifyNewAlerts() {
  const currentDanger = new Set(
    (state.alerts?.regions || []).map((region) => normalizeName(region.name))
  );

  if (state.hasLoadedOnce && state.soundEnabled) {
    const hasNew = [...currentDanger].some((name) => !state.previousDangerRegions.has(name));
    if (hasNew) beep();
  }

  state.previousDangerRegions = currentDanger;
  state.hasLoadedOnce = true;
}

async function loadAlerts(manual = false) {
  if (manual) elements.refreshButton.disabled = true;
  setConnection('', 'Оновлення');

  try {
    const response = await fetch(ALERTS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Tryvoha API ${response.status}`);

    const data = buildAlertPayload(await response.json());
    state.alerts = data;
    elements.activeCount.textContent = data.activeRegionCount;
    elements.updatedAt.textContent = `Оновлення: ${new Intl.DateTimeFormat('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(data.updatedAt))}`;

    hideNotice();
    setConnection('ok', 'Наживо');
    maybeNotifyNewAlerts();
    renderList();
    renderMap();
  } catch (error) {
    console.error(error);
    showNotice('Джерело даних тимчасово недоступне. Перевірте мережу та спробуйте оновити сторінку.');
    setConnection('error', 'Помилка');
  } finally {
    elements.refreshButton.disabled = false;
  }
}

elements.searchInput.addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderList();
});

elements.refreshButton.addEventListener('click', () => loadAlerts(true));

elements.soundButton.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  elements.soundButton.setAttribute('aria-pressed', String(state.soundEnabled));
  elements.soundButton.textContent = `ЗВУК: ${state.soundEnabled ? 'УВІМК' : 'ВИМК'}`;
  if (state.soundEnabled) beep();
});

loadGeo();
loadAlerts();
setInterval(() => loadAlerts(false), REFRESH_MS);
setInterval(renderList, 60_000);
