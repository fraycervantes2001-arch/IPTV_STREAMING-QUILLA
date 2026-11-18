/* =========================================================================
   IPTV QUILLA STREAMING — app.js
   Cliente IPTV con soporte para Xtream Codes API y listas M3U / M3U8.
   ========================================================================= */

(() => {
  'use strict';

  /* ---------- Estado global ---------- */
  const state = {
    mode: null,            // 'xtream' | 'm3u'
    xtream: null,          // { baseUrl, user, pass }
    categories: [],        // [{id, name, type}]
    items: [],             // canales / vods / series normalizados
    activeType: 'live',    // 'live' | 'movie' | 'series'
    activeCategoryId: null,
    searchTerm: '',
    hls: null,
    currentSeriesItem: null,     // serie abierta en el modal de temporadas/episodios
    currentSeriesEpisodes: {},   // { "1": [ep, ep, ...], "2": [...] }
    currentSeasonKey: null,
    favorites: [],                // se carga desde localStorage al iniciar
    progress: [],                  // "seguir viendo": posiciones guardadas de películas/episodios
    currentPlayback: null,         // metadata de lo que se está reproduciendo ahora, para guardar su progreso
    volumeBoost: 100,              // % de refuerzo de volumen (100 = normal, hasta 400)
  };

  const STORAGE_KEY = 'iptvQuillaConnections';
  const FAVORITES_KEY = 'iptvQuillaFavorites';
  const PROGRESS_KEY = 'iptvQuillaProgress';
  const VOLUME_BOOST_KEY = 'iptvQuillaVolumeBoost';

  /* =========================================================================
     CIFRADO LOCAL DE CONTRASEÑAS (conexiones Xtream guardadas)
     La contraseña se cifra con AES-GCM usando una clave NO EXTRAÍBLE que
     genera el propio navegador (crypto.subtle) y que se guarda en IndexedDB.
     Esto evita que quede como texto plano en localStorage (legible, por
     ejemplo, por cualquier extensión con permiso "storage"). No es
     protección contra un XSS real en el propio origen —esa clave sigue
     siendo utilizable por cualquier script que corra ahí—, pero eleva
     bastante la vara frente a los ataques más comunes y baratos.
     Requiere "contexto seguro" (HTTPS o localhost); si no está disponible,
     se cae de vuelta a guardar la contraseña como texto plano (igual que
     antes) y se avisa por consola.
     ========================================================================= */
  const CRYPTO_DB_NAME = 'iptvQuillaKeys';
  const CRYPTO_STORE = 'keys';
  const CRYPTO_KEY_ID = 'connKey';
  let cryptoKeyPromise = null;

  function openKeyDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB no disponible')); return; }
      const req = indexedDB.open(CRYPTO_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(CRYPTO_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getOrCreateCryptoKey() {
    if (!cryptoKeyPromise) {
      cryptoKeyPromise = (async () => {
        const db = await openKeyDb();
        const existing = await new Promise((resolve, reject) => {
          const tx = db.transaction(CRYPTO_STORE, 'readonly');
          const req = tx.objectStore(CRYPTO_STORE).get(CRYPTO_KEY_ID);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
        if (existing) return existing;
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await new Promise((resolve, reject) => {
          const tx = db.transaction(CRYPTO_STORE, 'readwrite');
          tx.objectStore(CRYPTO_STORE).put(key, CRYPTO_KEY_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        return key;
      })();
    }
    return cryptoKeyPromise;
  }

  function bufToBase64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function base64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Devuelve { enc:true, iv, data } (cifrado) o, si algo falla, el string
  // original sin tocar (formato "viejo", que decryptSecret sabe reconocer).
  async function encryptSecret(plainText) {
    try {
      const key = await getOrCreateCryptoKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainText));
      return { enc: true, iv: bufToBase64(iv), data: bufToBase64(cipherBuf) };
    } catch (e) {
      console.warn('No se pudo cifrar la contraseña; se guarda sin cifrar.', e);
      return plainText;
    }
  }

  // Acepta tanto el formato nuevo ({enc:true, iv, data}) como conexiones
  // guardadas ANTES de este cambio (string plano), para no romperlas.
  async function decryptSecret(value) {
    if (typeof value === 'string') return value;
    if (!value || !value.enc) return '';
    try {
      const key = await getOrCreateCryptoKey();
      const iv = new Uint8Array(base64ToBuf(value.iv));
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBuf(value.data));
      return new TextDecoder().decode(plainBuf);
    } catch (e) {
      console.warn('No se pudo descifrar la contraseña guardada.', e);
      return '';
    }
  }

  /* Web Audio: se crean una sola vez y quedan atados al <video>, incluso si cambia el src. */
  let audioCtx = null;
  let gainNode = null;
  let videoIsBoosted = false; // si el <video> actual ya está conectado al grafo de Web Audio

  /* ---------- Helpers DOM ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const screenLogin = $('#screen-login');
  const screenApp = $('#screen-app');
  let video = $('#video-player'); // se puede reemplazar por uno nuevo: ver recreateVideoElement()

  /* =========================================================================
     TABS DEL LOGIN (Xtream / M3U)
     ========================================================================= */
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      $$('.login-form').forEach((f) => f.classList.remove('is-active'));
      $('#' + tab.dataset.target).classList.add('is-active');
    });
  });

  /* Mostrar / ocultar contraseña */
  $$('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.for);
      const isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      btn.textContent = isPw ? '🙈' : '👁';
    });
  });

  /* =========================================================================
     CONEXIONES GUARDADAS
     ========================================================================= */
  function getSavedConnections() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  // Identifica una conexión sin depender de la contraseña (que ahora va
  // cifrada con un IV distinto cada vez, así que nunca sería igual a sí misma).
  function connectionDedupeKey(conn) {
    if (conn.mode === 'xtream') return `xtream|${conn.baseUrl}|${conn.user}`;
    if (conn.mode === 'm3u-file') return `m3u-file|${conn.name || ''}`;
    return `m3u|${conn.url}`;
  }

  async function saveConnection(conn) {
    let toStore = conn;
    if (conn.mode === 'xtream' && conn.pass) {
      toStore = { ...conn, pass: await encryptSecret(conn.pass) };
    }
    const list = getSavedConnections();
    const key = connectionDedupeKey(toStore);
    const filtered = list.filter((c) => connectionDedupeKey(c) !== key);
    filtered.unshift(toStore);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered.slice(0, 8)));
    renderSavedConnections();
  }

  function removeConnection(index) {
    const list = getSavedConnections();
    list.splice(index, 1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    renderSavedConnections();
  }

  function renderSavedConnections() {
    const list = getSavedConnections();
    const wrap = $('#saved-connections');
    const ul = $('#saved-connections-list');
    ul.innerHTML = '';
    if (!list.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    list.forEach((conn, i) => {
      const row = document.createElement('div');
      row.className = 'saved-conn';
      const label = conn.mode === 'xtream'
        ? (conn.name || (conn.user + '@' + stripProtocol(conn.baseUrl)))
        : conn.mode === 'm3u-file'
          ? (conn.name || 'Lista M3U (archivo)')
          : (conn.name || stripProtocol(conn.url));
      const typeLabel = conn.mode === 'xtream'
        ? 'XTREAM CODES'
        : conn.mode === 'm3u-file'
          ? 'ARCHIVO M3U'
          : 'LISTA M3U';
      row.innerHTML = `
        <div class="saved-conn__info">
          <span class="saved-conn__name">${escapeHtml(label)}</span>
          <span class="saved-conn__type">${typeLabel}</span>
        </div>
        <button class="saved-conn__remove" aria-label="Eliminar conexión" data-index="${i}">✕</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.saved-conn__remove')) return;
        connectWithSaved(conn);
      });
      row.querySelector('.saved-conn__remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeConnection(i);
      });
      ul.appendChild(row);
    });
  }

  function stripProtocol(url) {
    return (url || '').replace(/^https?:\/\//, '');
  }

  /* =========================================================================
     FAVORITOS
     Se identifican por tipo + streamUrl (live/movie) o tipo + seriesId (series),
     así sobreviven a un refresco de contenido sin depender del índice en la grilla.
     ========================================================================= */
  function loadFavorites() {
    try {
      return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function persistFavorites() {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
    } catch (e) {
      console.warn('No se pudieron guardar los favoritos.', e);
    }
  }

  function favoriteId(item) {
    return item.type + ':' + (item.type === 'series' ? item.seriesId : item.streamUrl);
  }

  function isFavorited(item) {
    const id = favoriteId(item);
    return state.favorites.some((f) => f.id === id);
  }

  function toggleFavorite(item) {
    const id = favoriteId(item);
    const idx = state.favorites.findIndex((f) => f.id === id);
    if (idx >= 0) {
      state.favorites.splice(idx, 1);
    } else {
      state.favorites.unshift({
        id,
        type: item.type,
        name: item.name,
        logo: item.logo || '',
        streamUrl: item.streamUrl || '',
        seriesId: item.seriesId,
        categoryId: item.categoryId,
      });
    }
    persistFavorites();
    renderGrid();
  }

  /* =========================================================================
     SEGUIR VIENDO (progreso de reproducción)
     Se guarda la posición cada pocos segundos mientras se reproduce una
     película o un episodio de serie (los canales en vivo no aplican).
     Se identifica por 'movie:'+streamUrl o 'episode:'+episodeId (id único
     que devuelve Xtream Codes), así el mismo ítem se reconoce sin importar
     desde qué pantalla se abrió.
     ========================================================================= */
  function loadProgress() {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function persistProgress() {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(state.progress));
    } catch (e) {
      console.warn('No se pudo guardar el progreso de reproducción.', e);
    }
  }

  function getProgress(id) {
    return state.progress.find((p) => p.id === id) || null;
  }

  function upsertProgress(entry) {
    const idx = state.progress.findIndex((p) => p.id === entry.id);
    if (idx >= 0) state.progress[idx] = entry;
    else state.progress.unshift(entry);
    state.progress = state.progress.slice(0, 60); // límite razonable
    persistProgress();
  }

  function removeProgressEntry(id) {
    const idx = state.progress.findIndex((p) => p.id === id);
    if (idx >= 0) {
      state.progress.splice(idx, 1);
      persistProgress();
    }
  }

  // Guarda (o descarta) la posición actual del <video> según cuánto se avanzó.
  function saveCurrentProgress() {
    const pb = state.currentPlayback;
    if (!pb || !pb.progressId) return;
    const duration = video.duration;
    const position = video.currentTime;
    if (!duration || !isFinite(duration) || !position) return;

    // Recién empezado: no vale la pena guardarlo (y si ya había uno viejo, se borra).
    if (position < 15) {
      removeProgressEntry(pb.progressId);
      return;
    }
    // Ya casi terminó: se considera visto y se saca de "seguir viendo".
    if (position > duration - 20) {
      removeProgressEntry(pb.progressId);
      return;
    }

    upsertProgress({
      id: pb.progressId,
      kind: pb.kind,               // 'movie' | 'episode'
      name: pb.title,
      logo: pb.logo || '',
      streamUrl: pb.url,
      position,
      duration,
      seriesName: pb.seriesName || '',
      seasonKey: pb.seasonKey || null,
      episodeNum: pb.episodeNum || null,
      updatedAt: Date.now(),
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function connectWithSaved(conn) {
    if (conn.mode === 'xtream') {
      const pass = await decryptSecret(conn.pass);
      connectXtream(conn.baseUrl, conn.user, pass, conn.name, false);
    } else if (conn.mode === 'm3u-file') {
      connectM3UFromSavedText(conn.content, conn.name);
    } else {
      connectM3U(conn.url, conn.name, false);
    }
  }

  /* =========================================================================
     LOGIN — XTREAM CODES
     ========================================================================= */
  $('#form-xtream').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#xt-url').value.trim().replace(/\/+$/, '');
    const user = $('#xt-user').value.trim();
    const pass = $('#xt-pass').value;
    const name = $('#xt-name').value.trim();
    const remember = $('#xt-remember').checked;
    if (!url || !user || !pass) return;
    await connectXtream(url, user, pass, name, remember);
  });

  async function connectXtream(baseUrl, user, pass, name, remember) {
    const errorEl = $('#xt-error');
    errorEl.hidden = true;
    setFormLoading('form-xtream', true);

    try {
      const normalizedUrl = baseUrl.match(/^https?:\/\//) ? baseUrl : 'http://' + baseUrl;
      const apiUrl = `${normalizedUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('No se pudo conectar con el servidor (HTTP ' + res.status + ')');
      const data = await res.json();

      if (!data || !data.user_info || data.user_info.auth !== 1) {
        throw new Error('Usuario o contraseña incorrectos, o cuenta inactiva');
      }

      state.mode = 'xtream';
      state.xtream = { baseUrl: normalizedUrl, user, pass };

      if (remember) await saveConnection({ mode: 'xtream', baseUrl: normalizedUrl, user, pass, name: name || '' });

      const expiry = data.user_info.exp_date
        ? new Date(data.user_info.exp_date * 1000).toLocaleDateString('es-ES')
        : 'Sin vencimiento';
      $('#conn-pill').textContent = `XTREAM · ${name || user} · vence ${expiry}`;

      await loadXtreamContent();
      enterApp();
    } catch (err) {
      console.error(err);
      errorEl.textContent = humanizeError(err);
      errorEl.hidden = false;
    } finally {
      setFormLoading('form-xtream', false);
    }
  }

  async function loadXtreamContent() {
    showLoading(true);
    const { baseUrl, user, pass } = state.xtream;
    const base = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

    const [liveCats, liveStreams, vodCats, vodStreams, seriesCats, seriesList] = await Promise.all([
      fetchJson(`${base}&action=get_live_categories`),
      fetchJson(`${base}&action=get_live_streams`),
      fetchJson(`${base}&action=get_vod_categories`),
      fetchJson(`${base}&action=get_vod_streams`),
      fetchJson(`${base}&action=get_series_categories`),
      fetchJson(`${base}&action=get_series`),
    ]);

    state.categories = [
      ...(liveCats || []).map((c) => ({ id: 'live-' + c.category_id, rawId: c.category_id, name: c.category_name, type: 'live' })),
      ...(vodCats || []).map((c) => ({ id: 'movie-' + c.category_id, rawId: c.category_id, name: c.category_name, type: 'movie' })),
      ...(seriesCats || []).map((c) => ({ id: 'series-' + c.category_id, rawId: c.category_id, name: c.category_name, type: 'series' })),
    ];

    state.items = [
      ...(liveStreams || []).map((s) => ({
        type: 'live',
        categoryId: 'live-' + s.category_id,
        name: s.name,
        logo: s.stream_icon || '',
        streamUrl: `${baseUrl}/live/${user}/${pass}/${s.stream_id}.m3u8`,
        streamId: s.stream_id,
      })),
      ...(vodStreams || []).map((s) => ({
        type: 'movie',
        categoryId: 'movie-' + s.category_id,
        name: s.name,
        logo: s.stream_icon || '',
        streamUrl: `${baseUrl}/movie/${user}/${pass}/${s.stream_id}.${s.container_extension || 'mp4'}`,
      })),
      ...(seriesList || []).map((s) => ({
        type: 'series',
        categoryId: 'series-' + s.category_id,
        name: s.name,
        logo: s.cover || '',
        seriesId: s.series_id,
        // las series requieren una segunda llamada para obtener episodios; se resuelve al hacer click
      })),
    ];

    showLoading(false);
    renderSidebarCategories();
    setActiveType('live');
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /* =========================================================================
     EPG (GUÍA DE PROGRAMACIÓN) — solo disponible en modo Xtream Codes.
     Se pide bajo demanda (get_short_epg) SOLO para los canales que están
     realmente visibles en pantalla (ver buildChannelCard más abajo, que la
     dispara al construir cada tarjeta), para no disparar cientos de
     peticiones de una con listas grandes. El resultado se cachea en memoria
     durante la sesión. Los paneles M3U no tienen esta información salvo que
     traigan su propia URL de XMLTV, que queda fuera de este alcance.
     ========================================================================= */
  const epgCache = new Map();    // streamId -> { now, next } | null (null = ya se consultó, sin datos)
  const epgInFlight = new Set(); // streamIds con un pedido en curso, para no duplicarlos

  // Xtream Codes devuelve título/descripción de la EPG codificados en base64.
  function decodeEpgText(b64) {
    if (!b64) return '';
    try {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return b64;
    }
  }

  function epgTimeLabel(entry) {
    const ts = entry.start_timestamp ? Number(entry.start_timestamp) * 1000 : Date.parse((entry.start || '') + ' UTC');
    if (!ts || isNaN(ts)) return '';
    return new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }

  async function fetchEpgFor(streamId) {
    if (!streamId || epgCache.has(streamId) || epgInFlight.has(streamId)) return;
    if (state.mode !== 'xtream' || !state.xtream) return;
    epgInFlight.add(streamId);
    try {
      const { baseUrl, user, pass } = state.xtream;
      const url = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_short_epg&stream_id=${streamId}&limit=2`;
      const data = await fetchJson(url);
      const listings = (data && data.epg_listings) || [];
      const now = listings[0] ? { title: decodeEpgText(listings[0].title), time: epgTimeLabel(listings[0]) } : null;
      const next = listings[1] ? { title: decodeEpgText(listings[1].title), time: epgTimeLabel(listings[1]) } : null;
      epgCache.set(streamId, (now || next) ? { now, next } : null);
    } catch {
      epgCache.set(streamId, null);
    } finally {
      epgInFlight.delete(streamId);
      // Si la tarjeta de ese canal sigue en pantalla (pudo haber scrolleado
      // fuera de la ventana virtualizada mientras tanto), se actualiza su badge.
      const badge = document.querySelector(`.channel-card[data-stream-id="${streamId}"] .channel-card__epg`);
      if (badge) renderEpgBadge(badge, streamId);
    }
  }

  function renderEpgBadge(badgeEl, streamId) {
    const info = epgCache.get(streamId);
    if (!info || !info.now) { badgeEl.hidden = true; badgeEl.textContent = ''; return; }
    badgeEl.hidden = false;
    badgeEl.textContent = (info.now.time ? info.now.time + ' · ' : '') + info.now.title;
    badgeEl.title = info.next ? `A continuación: ${info.next.title}` : '';
  }

  /* =========================================================================
     MODAL DE SERIE — TEMPORADAS Y EPISODIOS
     (get_series_info devuelve TODAS las temporadas/episodios disponibles;
      acá se listan en vez de reproducir directamente el primer episodio)
     ========================================================================= */
  const seriesModalOverlay = $('#series-modal-overlay');
  const seriesModalLoading = $('#series-modal-loading');
  const seriesModalEmpty = $('#series-modal-empty');

  async function openSeries(item) {
    state.currentSeriesItem = item;
    state.currentSeriesEpisodes = {};
    state.currentSeasonKey = null;

    $('#series-modal-title').textContent = item.name;
    $('#series-modal-poster').src = item.logo || '';
    $('#series-modal-meta').textContent = '';
    $('#series-modal-plot').textContent = '';
    $('#season-tabs').innerHTML = '';
    $('#episode-list').innerHTML = '';
    $('#series-modal-resume').hidden = true;
    seriesModalEmpty.hidden = true;
    seriesModalLoading.classList.add('is-visible');
    seriesModalOverlay.hidden = false;

    const { baseUrl, user, pass } = state.xtream;
    const url = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_series_info&series_id=${item.seriesId}`;
    const info = await fetchJson(url);
    seriesModalLoading.classList.remove('is-visible');

    // Puede no venir como objeto ({}) si el servidor no tiene datos: se normaliza.
    const episodesBySeason = (info && info.episodes && typeof info.episodes === 'object') ? info.episodes : {};
    const seasonKeys = Object.keys(episodesBySeason)
      .filter((k) => Array.isArray(episodesBySeason[k]) && episodesBySeason[k].length)
      .sort((a, b) => Number(a) - Number(b));

    const meta = (info && info.info) || {};
    if (meta.plot) $('#series-modal-plot').textContent = meta.plot;
    const metaBits = [
      meta.genre,
      meta.releaseDate || meta.release_date,
      meta.rating ? `⭐ ${meta.rating}` : null,
      seasonKeys.length ? `${seasonKeys.length} temporada${seasonKeys.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    $('#series-modal-meta').textContent = metaBits.join(' · ');
    if (meta.cover) $('#series-modal-poster').src = meta.cover;

    state.currentSeriesEpisodes = episodesBySeason;

    if (!seasonKeys.length) {
      seriesModalEmpty.hidden = false;
      renderResumeBanner(null);
      return;
    }

    // Si hay un episodio con progreso guardado, se abre directo en esa temporada.
    let resumeEntry = null;
    seasonKeys.forEach((key) => {
      episodesBySeason[key].forEach((ep) => {
        const p = getProgress('episode:' + ep.id);
        if (p && (!resumeEntry || p.updatedAt > resumeEntry.updatedAt)) {
          resumeEntry = { ...p, seasonKey: key, ep };
        }
      });
    });

    renderSeasonTabs(seasonKeys);
    selectSeason(resumeEntry ? resumeEntry.seasonKey : seasonKeys[0]);
    renderResumeBanner(resumeEntry);
  }

  function renderResumeBanner(resumeEntry) {
    const bar = $('#series-modal-resume');
    if (!resumeEntry) {
      bar.hidden = true;
      return;
    }
    const pct = Math.min(100, Math.round((resumeEntry.position / resumeEntry.duration) * 100));
    $('#series-modal-resume-text').textContent =
      `Seguir viendo: T${resumeEntry.seasonKey} E${resumeEntry.ep.episode_num} · ${pct}% visto`;
    const btn = $('#series-modal-resume-btn');
    btn.onclick = () => playEpisode(resumeEntry.ep, resumeEntry.seasonKey);
    bar.hidden = false;
  }

  function renderSeasonTabs(seasonKeys) {
    const wrap = $('#season-tabs');
    wrap.innerHTML = '';
    seasonKeys.forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'season-tab';
      btn.textContent = `Temporada ${key}`;
      btn.dataset.season = key;
      btn.addEventListener('click', () => selectSeason(key));
      wrap.appendChild(btn);
    });
  }

  function selectSeason(seasonKey) {
    state.currentSeasonKey = seasonKey;
    $$('.season-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.season === seasonKey));
    renderEpisodeList(seasonKey);
  }

  function renderEpisodeList(seasonKey) {
    const list = $('#episode-list');
    list.innerHTML = '';
    const episodes = (state.currentSeriesEpisodes && state.currentSeriesEpisodes[seasonKey]) || [];

    episodes
      .slice()
      .sort((a, b) => Number(a.episode_num) - Number(b.episode_num))
      .forEach((ep) => {
        const epInfo = ep.info || {};
        const thumb = epInfo.movie_image || (state.currentSeriesItem && state.currentSeriesItem.logo) || '';
        const duration = epInfo.duration || '';
        const plot = epInfo.plot || '';
        const title = ep.title || `Episodio ${ep.episode_num || ''}`;
        const epProgress = getProgress('episode:' + ep.id);

        const epNum = ep.episode_num || '?';

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'episode-row';

        // --- thumb (con fallback si la imagen no carga o no existe) ---
        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'episode-row__thumb-wrap';

        function renderThumbFallback() {
          thumbWrap.innerHTML = '';
          const fallback = document.createElement('span');
          fallback.className = 'episode-row__thumb-fallback';
          fallback.textContent = epNum;
          thumbWrap.appendChild(fallback);
        }

        if (thumb) {
          const img = document.createElement('img');
          img.className = 'episode-row__thumb';
          img.src = thumb;
          img.alt = '';
          img.loading = 'lazy';
          img.addEventListener('error', renderThumbFallback, { once: true });
          thumbWrap.appendChild(img);
        } else {
          renderThumbFallback();
        }
        row.appendChild(thumbWrap);

        // --- info (título, plot, duración, progreso) ---
        const info = document.createElement('div');
        info.className = 'episode-row__info';

        const titleEl = document.createElement('span');
        titleEl.className = 'episode-row__title';
        titleEl.textContent = `E${epNum} · ${title}`;
        info.appendChild(titleEl);

        if (plot) {
          const plotEl = document.createElement('span');
          plotEl.className = 'episode-row__plot';
          plotEl.textContent = plot;
          info.appendChild(plotEl);
        }

        if (duration) {
          const durationEl = document.createElement('span');
          durationEl.className = 'episode-row__duration';
          durationEl.textContent = duration;
          info.appendChild(durationEl);
        }

        if (epProgress) {
          const pct = Math.min(100, Math.round((epProgress.position / epProgress.duration) * 100));
          const progressWrap = document.createElement('div');
          progressWrap.className = 'episode-row__progress';
          const progressBar = document.createElement('span');
          progressBar.style.width = pct + '%';
          progressWrap.appendChild(progressBar);
          info.appendChild(progressWrap);
        }

        row.appendChild(info);
        row.addEventListener('click', () => playEpisode(ep, seasonKey));
        list.appendChild(row);
      });
  }

  function playEpisode(ep, seasonKey) {
    const { baseUrl, user, pass } = state.xtream;
    const ext = ep.container_extension || 'mp4';
    const streamUrl = `${baseUrl}/series/${user}/${pass}/${ep.id}.${ext}`;
    const seriesName = state.currentSeriesItem ? state.currentSeriesItem.name : '';
    const title = `${seriesName} — T${seasonKey} E${ep.episode_num}`;
    const meta = {
      progressId: 'episode:' + ep.id,
      kind: 'episode',
      logo: (ep.info && ep.info.movie_image) || (state.currentSeriesItem && state.currentSeriesItem.logo) || '',
      seriesName,
      seasonKey,
      episodeNum: ep.episode_num,
    };
    closeSeriesModal();
    openPlayerShell(title);
    playStream(streamUrl, title, meta);
  }

  $('#series-modal-close').addEventListener('click', closeSeriesModal);
  seriesModalOverlay.addEventListener('click', (e) => {
    if (e.target === seriesModalOverlay) closeSeriesModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !seriesModalOverlay.hidden) closeSeriesModal();
  });

  function closeSeriesModal() {
    seriesModalOverlay.hidden = true;
  }

  /* =========================================================================
     LOGIN — LISTA M3U
     ========================================================================= */
  $('#form-m3u').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#m3u-url').value.trim();
    const fileInput = $('#m3u-file');
    const file = fileInput.files && fileInput.files[0];
    const name = $('#m3u-name').value.trim();
    const remember = $('#m3u-remember').checked;
    const errorEl = $('#m3u-error');

    if (file) {
      await connectM3UFile(file, name, remember);
    } else if (url) {
      await connectM3U(url, name, remember);
    } else {
      errorEl.textContent = 'Ingresá una URL o subí un archivo .m3u / .m3u8';
      errorEl.hidden = false;
    }
  });

  /* Deja el estado global y la UI listos con una lista M3U ya parseada */
  function finalizeM3U(parsedItems, label) {
    state.mode = 'm3u';
    state.xtream = null;
    $('#conn-pill').textContent = `M3U · ${label}`;
    buildM3UContent(parsedItems);
    enterApp();
  }

  async function connectM3U(url, name, remember) {
    const errorEl = $('#m3u-error');
    errorEl.hidden = true;
    setFormLoading('form-m3u', true);

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('No se pudo descargar la lista (HTTP ' + res.status + ')');
      const text = await res.text();
      const parsed = parseM3U(text);
      if (!parsed.length) throw new Error('La lista no contiene canales válidos');

      if (remember) await saveConnection({ mode: 'm3u', url, name });

      finalizeM3U(parsed, name || stripProtocol(url));
    } catch (err) {
      console.error(err);
      errorEl.textContent = humanizeError(err);
      errorEl.hidden = false;
    } finally {
      setFormLoading('form-m3u', false);
    }
  }

  /* Carga una lista M3U/M3U8 subida como archivo local */
  async function connectM3UFile(file, name, remember) {
    const errorEl = $('#m3u-error');
    errorEl.hidden = true;
    setFormLoading('form-m3u', true);

    try {
      const text = await file.text();
      const parsed = parseM3U(text);
      if (!parsed.length) throw new Error('El archivo no contiene canales válidos');

      const label = name || file.name;

      if (remember) {
        try {
          await saveConnection({ mode: 'm3u-file', name: label, content: text });
        } catch (e) {
          console.warn('No se pudo guardar la lista localmente (puede ser demasiado grande).', e);
        }
      }

      finalizeM3U(parsed, label);
    } catch (err) {
      console.error(err);
      errorEl.textContent = humanizeError(err);
      errorEl.hidden = false;
    } finally {
      setFormLoading('form-m3u', false);
    }
  }

  /* Reconecta con una lista M3U guardada previamente desde un archivo */
  function connectM3UFromSavedText(content, name) {
    const errorEl = $('#m3u-error');
    errorEl.hidden = true;
    try {
      const parsed = parseM3U(content);
      if (!parsed.length) throw new Error('La lista guardada no contiene canales válidos');
      finalizeM3U(parsed, name || 'Lista M3U (archivo)');
    } catch (err) {
      console.error(err);
      errorEl.textContent = humanizeError(err);
      errorEl.hidden = false;
    }
  }

  /* Selección de archivo: actualiza la etiqueta y permite arrastrar y soltar */
  const m3uFileInput = $('#m3u-file');
  const m3uFileDrop = $('#m3u-file-drop');
  const m3uFileLabel = $('#m3u-file-label');

  function updateM3UFileLabel() {
    const file = m3uFileInput.files && m3uFileInput.files[0];
    if (file) {
      m3uFileLabel.textContent = file.name;
      m3uFileDrop.classList.add('has-file');
    } else {
      m3uFileLabel.textContent = 'Elegí un archivo o arrastralo acá';
      m3uFileDrop.classList.remove('has-file');
    }
  }

  m3uFileInput.addEventListener('change', updateM3UFileLabel);

  ['dragenter', 'dragover'].forEach((evt) => {
    m3uFileDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      m3uFileDrop.classList.add('is-dragover');
    });
  });

  ['dragleave', 'dragend'].forEach((evt) => {
    m3uFileDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      m3uFileDrop.classList.remove('is-dragover');
    });
  });

  m3uFileDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    m3uFileDrop.classList.remove('is-dragover');
    const dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (dropped) {
      m3uFileInput.files = e.dataTransfer.files;
      updateM3UFileLabel();
    }
  });

  /* Parser M3U/M3U8 con soporte de #EXTINF, group-title, tvg-logo */
  function parseM3U(text) {
    const lines = text.split(/\r?\n/);
    const items = [];
    let current = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF')) {
        const nameMatch = line.match(/,(.*)$/);
        const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
        const groupMatch = line.match(/group-title="([^"]*)"/i);
        current = {
          name: nameMatch ? nameMatch[1].trim() : 'Sin nombre',
          logo: logoMatch ? logoMatch[1] : '',
          group: groupMatch ? groupMatch[1] : 'Sin categoría',
        };
      } else if (line.startsWith('#')) {
        continue;
      } else if (current) {
        current.streamUrl = line;
        items.push(current);
        current = null;
      }
    }
    return items;
  }

  function buildM3UContent(parsedItems) {
    const groupSet = new Map();
    parsedItems.forEach((it) => {
      if (!groupSet.has(it.group)) groupSet.set(it.group, []);
      groupSet.get(it.group).push(it);
    });

    state.categories = Array.from(groupSet.keys()).map((g, i) => ({
      id: 'live-' + i,
      name: g,
      type: 'live',
    }));

    state.items = [];
    let catIndex = 0;
    groupSet.forEach((arr) => {
      const catId = 'live-' + catIndex;
      arr.forEach((it) => {
        state.items.push({
          type: 'live',
          categoryId: catId,
          name: it.name,
          logo: it.logo,
          streamUrl: it.streamUrl,
        });
      });
      catIndex++;
    });

    renderSidebarCategories();
    setActiveType('live');
  }

  /* =========================================================================
     UI: SIDEBAR / TIPOS / CATEGORÍAS
     ========================================================================= */
  $$('.sidebar__type').forEach((btn) => {
    btn.addEventListener('click', () => setActiveType(btn.dataset.type));
  });

  function setActiveType(type) {
    state.activeType = type;
    state.activeCategoryId = null;
    $$('.sidebar__type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === type));
    renderSidebarCategories();
    renderGrid();
  }

  function renderSidebarCategories() {
    const wrap = $('#category-list');
    wrap.innerHTML = '';

    // "Favoritos" y "Continuar viendo" mezclan tipos distintos, no tienen categorías propias.
    if (state.activeType === 'favorites' || state.activeType === 'continue') return;

    const cats = state.categories.filter((c) => c.type === state.activeType);

    const allBtn = document.createElement('button');
    allBtn.className = 'sidebar__cat' + (state.activeCategoryId === null ? ' is-active' : '');
    allBtn.textContent = 'Todas';
    allBtn.addEventListener('click', () => {
      state.activeCategoryId = null;
      renderSidebarCategories();
      renderGrid();
    });
    wrap.appendChild(allBtn);

    cats.forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = 'sidebar__cat' + (state.activeCategoryId === cat.id ? ' is-active' : '');
      btn.textContent = cat.name;
      btn.addEventListener('click', () => {
        state.activeCategoryId = cat.id;
        renderSidebarCategories();
        renderGrid();
      });
      wrap.appendChild(btn);
    });
  }

  /* =========================================================================
     BÚSQUEDA
     ========================================================================= */
  let searchDebounceTimer = null;
  $('#search-input').addEventListener('input', (e) => {
    const value = e.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.searchTerm = value.trim().toLowerCase();
      renderGrid();
    }, 180);
  });

  /* =========================================================================
     GRID DE CONTENIDO
     ========================================================================= */
  const titleByType = { live: 'Canales en vivo', movie: 'Películas', series: 'Series', favorites: 'Favoritos', continue: 'Continuar viendo' };

  function renderGrid() {
    const empty = $('#empty-state');

    let list;
    if (state.activeType === 'favorites') {
      list = state.favorites.slice();
    } else if (state.activeType === 'continue') {
      list = state.progress.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      list = state.items.filter((it) => it.type === state.activeType);
      if (state.activeCategoryId) list = list.filter((it) => it.categoryId === state.activeCategoryId);
    }
    if (state.searchTerm) list = list.filter((it) => it.name.toLowerCase().includes(state.searchTerm));

    $('#content-title').textContent = titleByType[state.activeType] || 'Contenido';
    $('#content-count').textContent = list.length ? `${list.length} resultado${list.length === 1 ? '' : 's'}` : '';

    if (!list.length) {
      const emptyTitle = empty.querySelector('p');
      const emptyHint = empty.querySelector('span');
      if (state.activeType === 'favorites' && !state.searchTerm) {
        emptyTitle.textContent = 'Todavía no marcaste favoritos';
        emptyHint.textContent = 'Tocá la ★ en cualquier canal, película o serie para agregarla acá';
      } else if (state.activeType === 'continue' && !state.searchTerm) {
        emptyTitle.textContent = 'No tenés nada para continuar';
        emptyHint.textContent = 'Lo que empieces a mirar va a aparecer acá para retomarlo donde quedó';
      } else {
        emptyTitle.textContent = 'No se encontraron resultados';
        emptyHint.textContent = 'Probá con otro término de búsqueda o categoría';
      }
      empty.hidden = false;
      $('#channel-grid').innerHTML = '';
      return;
    }
    empty.hidden = true;

    vGrid.list = list;
    vGrid.measured = false;
    vGrid.renderedStart = -1;
    vGrid.renderedEnd = -1;

    if (list.length <= VIRTUALIZE_THRESHOLD) {
      // Listas chicas (favoritos, resultados filtrados, etc.): se renderizan
      // todas de una, no vale la pena pagar el costo de medir y virtualizar.
      const grid = $('#channel-grid');
      grid.innerHTML = '';
      const frag = document.createDocumentFragment();
      list.forEach((item) => frag.appendChild(buildChannelCard(item)));
      grid.appendChild(frag);
      return;
    }

    layoutVirtualGrid(true);
  }

  // Construye una tarjeta de canal/película/serie (o de "continuar viendo").
  // Extraído de renderGrid para poder llamarlo tanto desde el render
  // "directo" (listas chicas) como desde el grid virtualizado.
  function buildChannelCard(item) {
    const card = document.createElement('button');
    card.className = 'channel-card';
    card.type = 'button';

    const logoWrap = document.createElement('div');
    logoWrap.className = 'channel-card__logo-wrap';
    if (item.logo) {
      const img = document.createElement('img');
      img.className = 'channel-card__logo';
      img.src = item.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { logoWrap.innerHTML = `<span class="channel-card__logo-fallback">${initials(item.name)}</span>`; };
      logoWrap.appendChild(img);
    } else {
      logoWrap.innerHTML = `<span class="channel-card__logo-fallback">${initials(item.name)}</span>`;
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'channel-card__name';
    nameEl.textContent = item.name;

    card.appendChild(logoWrap);
    card.appendChild(nameEl);

    // EPG: "ahora en el aire", solo para canales en vivo vía Xtream Codes.
    // Se pide apenas la tarjeta se construye, es decir, apenas entra en la
    // ventana visible del grid virtualizado — así nunca se piden más EPGs
    // que canales realmente en pantalla.
    if (item.type === 'live' && item.streamId && state.mode === 'xtream') {
      card.dataset.streamId = item.streamId;
      const epgBadge = document.createElement('span');
      epgBadge.className = 'channel-card__epg';
      epgBadge.hidden = true;
      card.appendChild(epgBadge);
      if (epgCache.has(item.streamId)) renderEpgBadge(epgBadge, item.streamId);
      else fetchEpgFor(item.streamId);
    }

    if (state.activeType === 'continue') {
      // En "Continuar viendo" el botón de la esquina saca el ítem de la lista, en vez de marcar favorito.
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'channel-card__fav channel-card__fav--remove';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', 'Quitar de continuar viendo');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeProgressEntry(item.id);
        renderGrid();
      });
      card.appendChild(removeBtn);
      appendProgressBar(card, item.position, item.duration);
    } else {
      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      const fav = isFavorited(item);
      favBtn.className = 'channel-card__fav' + (fav ? ' is-active' : '');
      favBtn.textContent = '★';
      favBtn.setAttribute('aria-label', fav ? 'Quitar de favoritos' : 'Agregar a favoritos');
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(item);
      });
      card.appendChild(favBtn);

      // Si es una película con progreso guardado, se muestra la barrita también acá.
      if (item.type === 'movie') {
        const p = getProgress('movie:' + item.streamUrl);
        if (p) appendProgressBar(card, p.position, p.duration);
      }
    }

    card.addEventListener('click', () => {
      if (state.activeType === 'continue') {
        const meta = { progressId: item.id, kind: item.kind, logo: item.logo, title: item.name };
        openPlayerShell(item.name);
        playStream(item.streamUrl, item.name, meta);
        return;
      }
      if (item.type === 'series') {
        openSeries(item);
      } else if (item.type === 'movie') {
        const meta = { progressId: 'movie:' + item.streamUrl, kind: 'movie', logo: item.logo, title: item.name };
        openPlayerShell(item.name);
        playStream(item.streamUrl, item.name, meta);
      } else {
        openPlayerShell(item.name);
        playStream(item.streamUrl, item.name);
        // Si ya se conoce el programa actual de este canal, se agrega al título del reproductor.
        if (item.type === 'live' && item.streamId) {
          const epgInfo = epgCache.get(item.streamId);
          if (epgInfo && epgInfo.now) $('#player-title').textContent = `${item.name} — ${epgInfo.now.title}`;
        }
      }
    });
    return card;
  }

  /* =========================================================================
     GRID VIRTUALIZADO
     En vez de montar en el DOM todas las tarjetas de la lista (que con
     paneles grandes puede ser 10.000+ canales), solo se renderizan las
     filas que caen dentro del área visible de ".content" (+ un margen de
     algunas filas arriba/abajo). El resto del alto se simula con dos
     "spacers" (divs vacíos que ocupan todo el ancho de la grilla vía
     grid-column: 1 / -1), así el scroll y la barra de scroll se comportan
     igual que si todo estuviera renderizado.
     ========================================================================= */
  const vGrid = { list: [], columns: 1, rowHeight: 0, measured: false, renderedStart: -1, renderedEnd: -1, rafPending: false };
  const VIRTUALIZE_THRESHOLD = 60;   // listas más chicas que esto no se virtualizan
  const VIRTUALIZE_BUFFER_ROWS = 3;  // filas extra a montar arriba/abajo del área visible

  function layoutVirtualGrid(forceMeasure) {
    const grid = $('#channel-grid');
    const content = $('.content');
    const list = vGrid.list;
    if (!list.length) return;

    // La pantalla todavía puede no ser visible (p. ej. justo antes de
    // enterApp()), y ahí clientHeight da 0: medir en ese momento rompería
    // todos los cálculos. Se reintenta en el próximo frame.
    if (content.clientHeight === 0) {
      requestAnimationFrame(() => layoutVirtualGrid(true));
      return;
    }

    if (forceMeasure || !vGrid.measured) {
      // Se pinta un puñado de tarjetas reales para medir su tamaño ya
      // renderizado (el ancho de columna depende del auto-fill del CSS
      // grid, así que hay que dejar que el navegador lo calcule).
      grid.innerHTML = '';
      const probeCount = Math.min(list.length, 24);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < probeCount; i++) frag.appendChild(buildChannelCard(list[i]));
      grid.appendChild(frag);

      const firstCard = grid.querySelector('.channel-card');
      if (!firstCard) return;
      const gridStyle = getComputedStyle(grid);
      const colGap = parseFloat(gridStyle.columnGap) || 16;
      const rowGap = parseFloat(gridStyle.rowGap) || colGap;
      const columns = Math.max(1, Math.round((grid.clientWidth + colGap) / (firstCard.offsetWidth + colGap)));

      vGrid.columns = columns;
      vGrid.rowHeight = firstCard.offsetHeight + rowGap;
      vGrid.measured = true;
      vGrid.renderedStart = 0;
      vGrid.renderedEnd = probeCount; // ya están pintadas; si alcanzan, no hace falta repintar
    }

    const totalRows = Math.ceil(list.length / vGrid.columns);

    const gridTop = grid.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;
    const viewTop = Math.max(0, content.scrollTop - gridTop);
    const viewBottom = viewTop + content.clientHeight;

    const startRow = Math.max(0, Math.floor(viewTop / vGrid.rowHeight) - VIRTUALIZE_BUFFER_ROWS);
    const endRow = Math.min(totalRows, Math.ceil(viewBottom / vGrid.rowHeight) + VIRTUALIZE_BUFFER_ROWS);
    const startIndex = startRow * vGrid.columns;
    const endIndex = Math.min(list.length, endRow * vGrid.columns);

    if (startIndex === vGrid.renderedStart && endIndex === vGrid.renderedEnd) return; // no cambió nada visible

    vGrid.renderedStart = startIndex;
    vGrid.renderedEnd = endIndex;

    grid.innerHTML = '';
    const topSpacer = document.createElement('div');
    topSpacer.style.cssText = `grid-column: 1 / -1; height: ${startRow * vGrid.rowHeight}px;`;
    grid.appendChild(topSpacer);

    const frag = document.createDocumentFragment();
    for (let i = startIndex; i < endIndex; i++) frag.appendChild(buildChannelCard(list[i]));
    grid.appendChild(frag);

    const bottomSpacer = document.createElement('div');
    bottomSpacer.style.cssText = `grid-column: 1 / -1; height: ${Math.max(0, (totalRows - endRow) * vGrid.rowHeight)}px;`;
    grid.appendChild(bottomSpacer);
  }

  function requestVirtualGridLayout() {
    if (vGrid.rafPending || vGrid.list.length <= VIRTUALIZE_THRESHOLD) return;
    vGrid.rafPending = true;
    requestAnimationFrame(() => {
      vGrid.rafPending = false;
      layoutVirtualGrid(false);
    });
  }

  $('.content').addEventListener('scroll', requestVirtualGridLayout);
  window.addEventListener('resize', () => {
    if (vGrid.list.length > VIRTUALIZE_THRESHOLD) layoutVirtualGrid(true);
  });

  // Barra fina de progreso al pie de una tarjeta (película o episodio con avance guardado).
  function appendProgressBar(card, position, duration) {
    if (!duration) return;
    const pct = Math.min(100, Math.max(0, Math.round((position / duration) * 100)));
    const wrap = document.createElement('div');
    wrap.className = 'channel-card__progress';
    wrap.innerHTML = `<span class="channel-card__progress-bar" style="width:${pct}%"></span>`;
    card.appendChild(wrap);
  }
  function initials(name) {
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }

  /* =========================================================================
     REFUERZO DE VOLUMEN (Web Audio API)
     Amplifica el audio del <video> por encima del 100%, además del volumen
     del dispositivo/navegador. Útil para canales o series que se escuchan
     bajitos. Se arma una sola vez porque un <video> solo puede conectarse
     a un MediaElementSourceNode una única vez en toda su vida.
     ========================================================================= */
  const volumeBoostRow = $('#volume-boost-row');
  const volumeBoostSlider = $('#volume-boost-slider');
  const volumeBoostValue = $('#volume-boost-value');

  function loadVolumeBoost() {
    const v = Number(localStorage.getItem(VOLUME_BOOST_KEY));
    return v >= 100 && v <= 400 ? v : 100;
  }

  function persistVolumeBoost() {
    try { localStorage.setItem(VOLUME_BOOST_KEY, String(state.volumeBoost)); } catch {}
  }

  function updateVolumeBoostUI() {
    volumeBoostSlider.value = state.volumeBoost;
    volumeBoostValue.textContent = state.volumeBoost + '%';
    const pct = ((state.volumeBoost - 100) / (400 - 100)) * 100;
    volumeBoostSlider.style.background =
      `linear-gradient(90deg, var(--cyan) 0%, var(--cyan) ${pct}%, var(--line) ${pct}%, var(--line) 100%)`;
  }

  // Arma el grafo de Web Audio la primera vez que hace falta (dentro de un gesto del usuario, como un click).
  //
  // OJO: un <video> solo puede conectarse a un MediaElementAudioSourceNode UNA
  // vez en toda su vida, y si el archivo que reproduce en ese momento (o
  // cualquiera después) es de otro origen sin cabeceras CORS, el navegador
  // fuerza el audio a CERO por seguridad ("outputs zeroes due to CORS access
  // restrictions"). Los canales en vivo pasan por HLS.js (blob: del mismo
  // origen) y no tienen ese problema, pero los archivos directos de
  // películas/series casi nunca traen CORS. Por eso el refuerzo de volumen
  // solo se conecta para contenido en vivo; ver recreateVideoElement() y
  // playStream() más abajo.
  function ensureAudioBoost() {
    if (videoIsBoosted) {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx) audioCtx = new AudioContextClass();
      const source = audioCtx.createMediaElementSource(video);
      if (!gainNode) {
        gainNode = audioCtx.createGain();
        gainNode.gain.value = state.volumeBoost / 100;
      }
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      videoIsBoosted = true;
    } catch (e) {
      console.warn('El refuerzo de volumen no está disponible en este navegador/dispositivo.', e);
      volumeBoostSlider.disabled = true;
      volumeBoostRow.title = 'No disponible en este navegador o dispositivo';
    }
  }

  // Reemplaza el <video> actual por uno nuevo, sin ninguna conexión previa a
  // Web Audio. Se usa antes de reproducir una película/episodio si el
  // elemento venía "boosteado" (por ejemplo, porque antes se vio un canal en
  // vivo), para garantizar que el audio del archivo directo NO salga mudo
  // por la restricción de CORS explicada arriba.
  function recreateVideoElement() {
    const fresh = document.createElement('video');
    fresh.id = 'video-player';
    fresh.setAttribute('controls', '');
    fresh.setAttribute('playsinline', '');
    video.replaceWith(fresh);
    video = fresh;
    videoIsBoosted = false;
    bindVideoProgressEvents();
  }

  function bindVideoProgressEvents() {
    video.addEventListener('timeupdate', () => {
      const pb = state.currentPlayback;
      if (!pb || !pb.progressId) return;
      const now = Date.now();
      if (now - (pb.lastSavedAt || 0) < 4000) return;
      pb.lastSavedAt = now;
      saveCurrentProgress();
    });
    video.addEventListener('pause', saveCurrentProgress);
    video.addEventListener('ended', () => {
      const pb = state.currentPlayback;
      if (pb && pb.progressId) removeProgressEntry(pb.progressId);
    });
  }

  volumeBoostSlider.addEventListener('input', () => {
    state.volumeBoost = Number(volumeBoostSlider.value);
    updateVolumeBoostUI();
    if (gainNode) gainNode.gain.value = state.volumeBoost / 100;
    persistVolumeBoost();
  });

  /* =========================================================================
     REPRODUCTOR (HLS.js + fallback nativo)
     ========================================================================= */
  function openPlayerShell(title) {
    $('#player-title').textContent = title;
    $('#player-overlay').hidden = false;
    showPlayerStatus(true, 'Conectando con el canal...');
  }

  function showPlayerStatus(show, text) {
    $('#player-status').hidden = !show;
    if (text) $('#player-status-text').textContent = text;
  }

  /* --------------------------------------------------------------------
     AVISO DE "SIN AUDIO COMPATIBLE"
     Muchos archivos de películas/episodios de paneles IPTV traen el audio
     original en AC3/EAC3/DTS (Dolby Digital): el navegador decodifica el
     video perfecto pero descarta el audio en silencio porque no sabe
     decodificar ese códec. Los canales en vivo casi no sufren esto porque
     llegan ya transcodificados a AAC dentro del .m3u8.
     -------------------------------------------------------------------- */
  const audioWarning = $('#player-audio-warning');
  const audioWarningCopyBtn = $('#audio-warning-copy');
  const audioWarningVlcBtn = $('#audio-warning-vlc');
  const audioWarningCloseBtn = $('#audio-warning-close');
  let audioWatchdogTimer = null;

  function clearAudioWatchdog() {
    if (audioWatchdogTimer) { clearTimeout(audioWatchdogTimer); audioWatchdogTimer = null; }
  }
  function hideAudioWarning() {
    clearAudioWatchdog();
    if (audioWarning) audioWarning.hidden = true;
  }
  function showAudioWarning(directUrl) {
    if (!audioWarning) return;
    audioWarning.hidden = false;
    if (audioWarningVlcBtn) audioWarningVlcBtn.href = 'vlc://' + directUrl;
    if (audioWarningCopyBtn) {
      audioWarningCopyBtn.textContent = 'Copiar enlace';
      audioWarningCopyBtn.onclick = () => {
        navigator.clipboard?.writeText(directUrl).then(() => {
          audioWarningCopyBtn.textContent = '¡Copiado!';
          setTimeout(() => { audioWarningCopyBtn.textContent = 'Copiar enlace'; }, 1800);
        }).catch(() => {});
      };
    }
  }
  if (audioWarningCloseBtn) audioWarningCloseBtn.addEventListener('click', hideAudioWarning);

  // A los pocos segundos de reproducir, revisa si el navegador efectivamente
  // decodificó bytes de audio (disponible en navegadores basados en Chromium:
  // Chrome, Edge, Opera, Brave...). Si el video avanza pero no hay audio
  // decodificado, se asume códec no soportado y se muestra el aviso.
  function watchAudioSupport(directUrlForFallback) {
    clearAudioWatchdog();
    if (typeof video.webkitAudioDecodedByteCount !== 'number') return; // no disponible en este navegador
    audioWatchdogTimer = setTimeout(() => {
      const hasAudio = video.webkitAudioDecodedByteCount > 0;
      const isPlaying = video.currentTime > 1 && !video.paused;
      if (!hasAudio && isPlaying) showAudioWarning(directUrlForFallback);
    }, 4000);
  }

  function startNativePlayback(url, resumeFrom, onReady) {
    video.src = url;
    video.addEventListener('loadeddata', () => {
      showPlayerStatus(false);
      if (resumeFrom > 5) video.currentTime = resumeFrom;
      if (onReady) onReady();
    }, { once: true });
    video.addEventListener('error', () => {
      showPlayerStatus(true, 'No se pudo reproducir este contenido. El formato puede no ser compatible con el navegador.');
    }, { once: true });
    video.play().catch(() => {});
  }

  function playHls(url, resumeFrom, fatalMessage) {
    const hls = new Hls({ maxBufferLength: 30 });
    state.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      showPlayerStatus(false);
      if (resumeFrom > 5) video.currentTime = resumeFrom;
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) showPlayerStatus(true, fatalMessage);
    });
  }

  function playStream(url, title, meta) {
    const isVod = meta && (meta.kind === 'movie' || meta.kind === 'episode');

    // Si el <video> ya está conectado a Web Audio (por haber visto un canal
    // en vivo antes) y ahora toca reproducir una película/episodio, se
    // reemplaza por uno nuevo y "limpio" para que el audio del archivo
    // directo no salga mudo por la restricción de CORS.
    if (isVod && videoIsBoosted) recreateVideoElement();

    destroyHls();
    hideAudioWarning();
    $('#player-title').textContent = title;

    // El refuerzo de volumen solo se conecta para contenido en vivo (llega
    // por blob: del mismo origen, es seguro). Para películas/series se deja
    // el audio nativo del navegador sin tocar.
    if (!isVod) ensureAudioBoost();
    volumeBoostSlider.disabled = isVod;
    volumeBoostRow.title = isVod
      ? 'El refuerzo de volumen no está disponible en películas/series (requiere audio con CORS habilitado)'
      : '';

    // meta.progressId identifica películas/episodios para guardar y retomar su posición.
    state.currentPlayback = meta ? { ...meta, url, title, lastSavedAt: 0 } : null;
    const resumeFrom = meta && meta.progressId ? ((getProgress(meta.progressId) || {}).position || 0) : 0;

    if (url.includes('.m3u8') && window.Hls && window.Hls.isSupported()) {
      playHls(url, resumeFrom, 'No se pudo reproducir este canal. Verificá tu conexión o credenciales.');
    } else {
      startNativePlayback(url, resumeFrom, () => { if (isVod) watchAudioSupport(url); });
    }
  }

  function destroyHls() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    video.removeAttribute('src');
    video.load();
  }

  $('#player-close').addEventListener('click', closePlayer);
  function closePlayer() {
    saveCurrentProgress();
    destroyHls();
    hideAudioWarning();
    state.currentPlayback = null;
    $('#player-overlay').hidden = true;
  }

  /* =========================================================================
     NAVEGACIÓN ENTRE PANTALLAS / LOGOUT / CAMBIAR CUENTA
     ========================================================================= */
  function enterApp() {
    screenLogin.hidden = true;
    screenApp.hidden = false;
  }

  function resetToLogin() {
    closePlayer();
    closeSeriesModal();
    state.mode = null;
    state.xtream = null;
    state.items = [];
    state.categories = [];
    state.activeCategoryId = null;
    state.searchTerm = '';
    state.currentSeriesItem = null;
    state.currentSeriesEpisodes = {};
    state.currentSeasonKey = null;
    $('#search-input').value = '';
    $('#conn-pill').textContent = '—';
    screenApp.hidden = true;
    screenLogin.hidden = false;
  }

  // "Salir": cierra la sesión actual y vuelve al login.
  $('#btn-logout').addEventListener('click', resetToLogin);

  // "Cambiar cuenta": mismo comportamiento, solo difiere el texto del botón.
  $('#switch-account').addEventListener('click', resetToLogin);

  /* =========================================================================
     UTILIDADES VARIAS
     ========================================================================= */
  function setFormLoading(formId, loading) {
    const form = document.getElementById(formId);
    const btn = form.querySelector('.btn-primary');
    const label = btn.querySelector('.btn-primary__label');
    const spinner = btn.querySelector('.btn-primary__spinner');
    btn.disabled = loading;
    spinner.hidden = !loading;
    label.style.opacity = loading ? '.6' : '1';
  }

  function showLoading(show) {
    $('#loading-state').hidden = !show;
    $('#channel-grid').hidden = show;
  }

  function humanizeError(err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return 'El servidor no respondió a tiempo. Verificá la URL o tu conexión a internet.';
    }
    if (err instanceof TypeError) {
      return 'No se pudo establecer conexión. Revisá la URL del servidor y tu red.';
    }
    return err.message || 'Ocurrió un error inesperado.';
  }

  /* ---------- Service Worker (PWA) ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js');
  }

  /* ---------- Init ---------- */
  bindVideoProgressEvents();
  state.favorites = loadFavorites();
  state.progress = loadProgress();
  state.volumeBoost = loadVolumeBoost();
  updateVolumeBoostUI();
  renderSavedConnections();
})();