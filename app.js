(function () {
  'use strict';

  // ---- configuration --------------------------------------------------------
  var DEFAULT_API = 'https://cessna-live-api.onrender.com';
  var POLL_MS = 5000;
  var MIN_BACKOFF_MS = 5000;
  var MAX_BACKOFF_MS = 60000;
  var TRAIL_MAX = 200;
  var STALE_S = 60;              // seconds since the last position before "NOT SEEN"
  var WARM_TIMEOUT_MS = 12000;
  var COLD_TIMEOUT_MS = 75000;   // the free proxy may need to wake up on the first call
  var FIRST_FIX_ZOOM = 12;
  var LS = { reg: 'cessnaLive.reg', follow: 'cessnaLive.follow', style: 'cessnaLive.style', api: 'cessnaLive.api' };

  var params = new URLSearchParams(location.search);
  var apiBase = (params.get('api') || lsGet(LS.api) || DEFAULT_API).replace(/\/+$/, '');
  if (params.get('api')) lsSet(LS.api, apiBase);

  // ---- elements -------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  var el = {
    reg: $('reg'), type: $('type'), status: $('status'),
    alt: $('alt'), gs: $('gs'), trk: $('trk'), vr: $('vr'),
    age: $('age'), source: $('source'),
    followBtn: $('followBtn'), styleBtn: $('styleBtn'), changeBtn: $('changeBtn'),
    msg: $('msg'), setup: $('setup'), regForm: $('regForm'), regInput: $('regInput'), cancelBtn: $('cancelBtn')
  };

  // ---- state ----------------------------------------------------------------
  var state = {
    reg: '',
    follow: (lsGet(LS.follow) || 'on') === 'on',
    style: lsGet(LS.style) === 'light' ? 'light' : 'dark',
    timer: null,
    seq: 0,
    inflight: false,
    backoff: MIN_BACKOFF_MS,
    warmed: false,
    lastPosAt: null,
    lastLatLng: null,
    trail: [],
    wakeLock: null
  };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // ---- map ------------------------------------------------------------------
  var map = L.map('map', { zoomControl: false, worldCopyJump: true });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.setView([43.86, -79.37], 9);

  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  // One tile source: OpenStreetMap standard tiles. Dark mode is a CSS filter on the
  // tile pane (see style.css), so no tile provider API key is needed.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR }).addTo(map);
  var TRAIL_COLOR = { dark: '#4cc9f0', light: '#0077b6' };

  function applyStyle(name) {
    if (name !== 'light') name = 'dark';
    state.style = name;
    lsSet(LS.style, name);
    document.body.setAttribute('data-style', name);
    el.styleBtn.textContent = 'Map: ' + (name === 'dark' ? 'Dark' : 'Light');
    trail.setStyle({ color: TRAIL_COLOR[name] });
  }

  var trail = L.polyline([], { color: TRAIL_COLOR.dark, weight: 3, opacity: 0.9, lineJoin: 'round' }).addTo(map);

  var PLANE_PATH = 'M50 8 C54 8 55 14 55 20 L55 84 L45 84 L45 20 C45 14 46 8 50 8 Z ' +
                   'M45 40 L55 40 L92 56 L92 63 L55 54 L45 54 L8 63 L8 56 Z ' +
                   'M46 78 L54 78 L69 89 L69 93 L54 87 L46 87 L31 93 L31 89 Z';
  var planeIcon = L.divIcon({
    className: 'plane-icon',
    html: '<div class="plane-rot"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="' + PLANE_PATH + '"/></svg></div>',
    iconSize: [44, 44],
    iconAnchor: [22, 22]
  });
  var marker = null;

  function setPlane(latlng, track, stale) {
    var first = !marker;
    if (first) marker = L.marker(latlng, { icon: planeIcon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    else marker.setLatLng(latlng);
    var node = marker.getElement();
    if (node) {
      var rot = node.querySelector('.plane-rot');
      if (rot) rot.style.transform = 'rotate(' + (isFinite(track) ? track : 0) + 'deg)';
      node.classList.toggle('stale', !!stale);
    }
    return first;
  }

  function pushTrail(latlng) {
    var last = state.trail[state.trail.length - 1];
    if (last && Math.abs(last[0] - latlng[0]) < 1e-6 && Math.abs(last[1] - latlng[1]) < 1e-6) return;
    state.trail.push(latlng);
    if (state.trail.length > TRAIL_MAX) state.trail.splice(0, state.trail.length - TRAIL_MAX);
    trail.setLatLngs(state.trail);
  }

  function resetTrack() {
    state.trail = [];
    trail.setLatLngs([]);
    if (marker) { map.removeLayer(marker); marker = null; }
    state.lastPosAt = null;
    state.lastLatLng = null;
  }

  // ---- formatting -----------------------------------------------------------
  function pick(a, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = a[keys[i]];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }
  function fmtInt(v) { return (v == null) ? '--' : Math.round(v).toLocaleString('en-US'); }
  function fmtSigned(v) {
    if (v == null) return '--';
    var r = Math.round(v);
    return (r > 0 ? '+' : '') + r.toLocaleString('en-US');
  }
  function fmtTrack(v) {
    if (v == null) return '--';
    var d = Math.round(v) % 360;
    if (d < 0) d += 360;
    if (d === 0) d = 360;
    return (d < 10 ? '00' : d < 100 ? '0' : '') + d;
  }
  function fmtAge(s) {
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    return Math.floor(s / 3600) + ' h ago';
  }

  function setStatus(kind, text) {
    el.status.className = 'status status-' + kind;
    el.status.textContent = text;
  }
  function clearStats() {
    el.alt.textContent = '--';
    el.gs.textContent = '--';
    el.trk.textContent = '--';
    el.vr.textContent = '--';
  }

  // ---- rendering ------------------------------------------------------------
  function render(ac, upstream) {
    el.reg.textContent = state.reg;
    el.source.textContent = upstream ? 'via ' + upstream : '';

    if (!ac) {
      setStatus('notseen', 'NOT SEEN');
      el.type.textContent = state.lastLatLng ? 'Signal lost, showing last position' : 'Not currently received by the ADS-B network';
      clearStats();
      if (marker && marker.getElement()) marker.getElement().classList.add('stale');
      return;
    }

    var hasPos = typeof ac.lat === 'number' && typeof ac.lon === 'number';
    var seenPos = (typeof ac.seen_pos === 'number') ? ac.seen_pos : ((typeof ac.seen === 'number') ? ac.seen : 0);
    var onGround = ac.alt_baro === 'ground';
    var stale = seenPos > STALE_S;
    var track = pick(ac, ['track', 'calc_track', 'true_heading', 'nav_heading', 'mag_heading']);

    if (hasPos) {
      var ll = [ac.lat, ac.lon];
      state.lastLatLng = ll;
      state.lastPosAt = Date.now() - seenPos * 1000;
      var first = setPlane(ll, track, stale);
      pushTrail(ll);
      if (first) map.setView(ll, Math.max(map.getZoom(), FIRST_FIX_ZOOM), { animate: true });
      else if (state.follow) map.panTo(ll, { animate: true, duration: 0.5 });
    }

    if (!hasPos) {
      setStatus('notseen', 'NO POSITION');
    } else if (stale) {
      setStatus('notseen', 'NOT SEEN');
    } else if (onGround) {
      setStatus('ground', 'ON GROUND');
    } else {
      setStatus('air', 'AIRBORNE');
    }

    var callsign = (ac.flight || '').trim();
    var typeBits = [];
    if (ac.t) typeBits.push(ac.t);
    if (ac.desc) typeBits.push(ac.desc);
    var typeLine = typeBits.join('  ');
    if (callsign && callsign !== state.reg.replace('-', '')) typeLine += (typeLine ? '  /  ' : '') + callsign;
    if (ac.squawk) typeLine += (typeLine ? '  /  sq ' : 'sq ') + ac.squawk;
    el.type.textContent = typeLine || 'Aircraft';

    el.alt.textContent = onGround ? 'GND' : fmtInt(pick(ac, ['alt_baro', 'alt_geom']));
    el.gs.textContent = fmtInt(pick(ac, ['gs']));
    el.trk.textContent = fmtTrack(track);
    el.vr.textContent = onGround ? '0' : fmtSigned(pick(ac, ['baro_rate', 'geom_rate']));
    tickAge();
  }

  function tickAge() {
    if (!state.lastPosAt) { el.age.textContent = 'Last position: --'; return; }
    var s = Math.max(0, Math.round((Date.now() - state.lastPosAt) / 1000));
    el.age.textContent = 'Last position: ' + fmtAge(s);
    if (s > STALE_S && marker && marker.getElement()) marker.getElement().classList.add('stale');
  }
  setInterval(tickAge, 1000);

  // ---- messages -------------------------------------------------------------
  function showMsg(text) { el.msg.textContent = text; el.msg.classList.remove('hidden'); }
  function hideMsg() { el.msg.classList.add('hidden'); }

  // ---- polling --------------------------------------------------------------
  function schedule(ms) {
    clearTimeout(state.timer);
    if (document.hidden) return;
    state.timer = setTimeout(poll, ms);
  }

  function poll() {
    if (!state.reg || state.inflight) return;
    var reg = state.reg;
    var seq = ++state.seq;
    state.inflight = true;
    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, state.warmed ? WARM_TIMEOUT_MS : COLD_TIMEOUT_MS);
    if (!state.warmed) showMsg('Connecting to the data service. The first load can take up to a minute.');

    fetch(apiBase + '/v2/reg/' + encodeURIComponent(reg), { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 429) {
          var ra = parseInt(r.headers.get('Retry-After') || '', 10);
          throw { retryMs: (isNaN(ra) ? 15 : Math.max(5, ra)) * 1000, text: 'Rate limited, slowing down' };
        }
        if (!r.ok) throw { text: r.status === 502 ? 'Data sources unavailable, retrying' : 'Data service error ' + r.status + ', retrying' };
        var upstream = r.headers.get('X-Upstream') || '';
        return r.json().then(function (j) { return { j: j, upstream: upstream }; });
      })
      .then(function (res) {
        if (seq !== state.seq || reg !== state.reg) return;   // a newer request superseded this one
        state.warmed = true;
        state.backoff = MIN_BACKOFF_MS;
        hideMsg();
        var ac = (res.j && Array.isArray(res.j.ac) && res.j.ac.length) ? res.j.ac[0] : null;
        render(ac, res.upstream);
        requestWakeLock();
        schedule(POLL_MS);
      })
      .catch(function (e) {
        if (seq !== state.seq || reg !== state.reg) return;
        var text;
        if (e && e.text) text = e.text;
        else if (e && e.name === 'AbortError') text = state.warmed ? 'Data service is slow, retrying' : 'Still waking the data service, retrying';
        else text = 'No connection, retrying';
        var wait = (e && e.retryMs) || state.backoff;
        state.backoff = Math.min(MAX_BACKOFF_MS, state.backoff * 2);
        showMsg(text + ' in ' + Math.round(wait / 1000) + ' s');
        schedule(wait);
      })
      .then(function () {
        clearTimeout(timeout);
        if (seq === state.seq) state.inflight = false;
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearTimeout(state.timer);
    } else {
      state.backoff = MIN_BACKOFF_MS;
      if (!state.inflight) poll();
      requestWakeLock();
    }
  });

  // ---- keep the screen on while tracking -----------------------------------
  function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.hidden || state.wakeLock) return;
    try {
      navigator.wakeLock.request('screen').then(function (lock) {
        state.wakeLock = lock;
        lock.addEventListener('release', function () { state.wakeLock = null; });
      }, function () { /* not granted, ignore */ });
    } catch (e) { /* unsupported */ }
  }

  // ---- registration ---------------------------------------------------------
  function normalizeReg(raw) {
    var s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return '';
    // Canadian marks typed without the hyphen: CFEUS -> C-FEUS
    if (/^C[FGI][A-Z0-9]{3}$/.test(s)) s = 'C-' + s.slice(1);
    return s;
  }
  function validReg(s) { return /^[A-Z0-9-]{2,12}$/.test(s); }

  function setReg(reg) {
    state.reg = reg;
    lsSet(LS.reg, reg);
    document.title = reg + ' | Cessna Live';
    resetTrack();
    state.backoff = MIN_BACKOFF_MS;
    state.seq++;             // invalidate any in-flight request for the old aircraft
    state.inflight = false;
    el.reg.textContent = reg;
    el.type.textContent = 'Waiting for data';
    el.source.textContent = '';
    setStatus('unknown', 'NO DATA');
    clearStats();
    tickAge();
    clearTimeout(state.timer);
    poll();
  }

  function showSetup(cancelable) {
    el.setup.classList.remove('hidden');
    el.cancelBtn.classList.toggle('hidden', !cancelable);
    el.regInput.value = state.reg;
    el.regInput.classList.remove('bad');
    setTimeout(function () { el.regInput.focus(); }, 50);
  }
  function hideSetup() { el.setup.classList.add('hidden'); }

  el.regForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var reg = normalizeReg(el.regInput.value);
    if (!validReg(reg)) { el.regInput.classList.add('bad'); el.regInput.focus(); return; }
    hideSetup();
    if (reg !== state.reg) setReg(reg);
  });
  el.cancelBtn.addEventListener('click', hideSetup);
  el.changeBtn.addEventListener('click', function () { showSetup(!!state.reg); });

  // ---- controls -------------------------------------------------------------
  function setFollow(on) {
    state.follow = !!on;
    lsSet(LS.follow, state.follow ? 'on' : 'off');
    el.followBtn.textContent = 'Follow: ' + (state.follow ? 'On' : 'Off');
    el.followBtn.setAttribute('aria-pressed', state.follow ? 'true' : 'false');
    el.followBtn.classList.toggle('active', state.follow);
  }
  el.followBtn.addEventListener('click', function () {
    setFollow(!state.follow);
    if (state.follow && state.lastLatLng) map.panTo(state.lastLatLng, { animate: true });
  });
  map.on('dragstart', function () { if (state.follow) setFollow(false); });
  el.styleBtn.addEventListener('click', function () { applyStyle(state.style === 'dark' ? 'light' : 'dark'); });

  // ---- start ----------------------------------------------------------------
  applyStyle(state.style);
  setFollow(state.follow);
  var urlReg = normalizeReg(params.get('reg'));
  var savedReg = normalizeReg(lsGet(LS.reg));
  if (urlReg && validReg(urlReg)) setReg(urlReg);
  else if (savedReg && validReg(savedReg)) setReg(savedReg);
  else showSetup(false);
})();
