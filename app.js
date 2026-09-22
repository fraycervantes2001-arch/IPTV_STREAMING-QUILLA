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
     PROXY (necesario en GitHub Pages / Firebase Hosting)
     GitHub Pages sirve la página por HTTPS y es un hosting 100% estático (sin
     backend propio). La mayoría de paneles Xtream/M3U son HTTP o no mandan
     cabeceras CORS, así que el navegador bloquea el fetch() directo.
     Solución: un Cloudflare Worker gratuito que hace el pedido por el lado
     del servidor y devuelve la respuesta con CORS habilitado.
     Pegá acá la URL de tu Worker ya desplegado (ver worker.js e instrucciones).
     Dejalo en '' para probar en local sin proxy (ej. si corrés con Live Server).
     ========================================================================= */
  const PROXY_URL = 'https://iptv-proxy.fraycervantes2001.workers.dev/?url=';

  function proxied(url) {
    return PROXY_URL ? PROXY_URL + encodeURIComponent(url) : url;
  }

  /* Web Audio: se crean una sola vez y quedan atados al <video>, incluso si cambia el src. */
  let audioCtx = null;
  let gainNode = null;

  /* ---------- Helpers DOM ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const screenLogin = $('#screen-login');
  const screenApp = $('#screen-app');
  const video = $('#video-player');

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

  function saveConnection(conn) {
    const list = getSavedConnections();
    // evitar duplicados exactos
    const exists = list.some((c) => JSON.stringify(c) === JSON.stringify(conn));
    if (!exists) {
      list.unshift(conn);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 8)));
    }
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

  function connectWithSaved(conn) {
    if (conn.mode === 'xtream') {
      connectXtream(conn.baseUrl, conn.user, conn.pass, conn.name, false);
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

      const res = await fetch(proxied(apiUrl), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('No se pudo conectar con el servidor (HTTP ' + res.status + ')');
      const data = await res.json();

      if (!data || !data.user_info || data.user_info.auth !== 1) {
        throw new Error('Usuario o contraseña incorrectos, o cuenta inactiva');
      }

      state.mode = 'xtream';
      state.xtream = { baseUrl: normalizedUrl, user, pass };

      if (remember) saveConnection({ mode: 'xtream', baseUrl: normalizedUrl, user, pass, name: name || '' });

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
      const res = await fetch(proxied(url), { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
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

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'episode-row';
        row.innerHTML = `
          <div class="episode-row__thumb-wrap">
            ${thumb
              ? `<img class="episode-row__thumb" src="${thumb}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=&quot;episode-row__thumb-fallback&quot;>${ep.episode_num || '?'}</span>'">`
              : `<span class="episode-row__thumb-fallback">${ep.episode_num || '?'}</span>`}
          </div>
          <div class="episode-row__info">
            <span class="episode-row__title">E${ep.episode_num || '?'} · ${escapeHtml(title)}</span>
            ${plot ? `<span class="episode-row__plot">${escapeHtml(plot)}</span>` : ''}
            ${duration ? `<span class="episode-row__duration">${escapeHtml(duration)}</span>` : ''}
            ${epProgress ? `<div class="episode-row__progress"><span style="width:${Math.min(100, Math.round((epProgress.position / epProgress.duration) * 100))}%"></span></div>` : ''}
          </div>
        `;
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
      const res = await fetch(proxied(url), { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('No se pudo descargar la lista (HTTP ' + res.status + ')');
      const text = await res.text();
      const parsed = parseM3U(text);
      if (!parsed.length) throw new Error('La lista no contiene canales válidos');

      if (remember) saveConnection({ mode: 'm3u', url, name });

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
          saveConnection({ mode: 'm3u-file', name: label, content: text });
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
  $('#search-input').addEventListener('input', (e) => {
    state.searchTerm = e.target.value.trim().toLowerCase();
    renderGrid();
  });

  /* =========================================================================
     GRID DE CONTENIDO
     ========================================================================= */
  const titleByType = { live: 'Canales en vivo', movie: 'Películas', series: 'Series', favorites: 'Favoritos', continue: 'Continuar viendo' };

  function renderGrid() {
    const grid = $('#channel-grid');
    const empty = $('#empty-state');
    grid.innerHTML = '';

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
      return;
    }
    empty.hidden = true;

    const frag = document.createDocumentFragment();
    list.slice(0, 400).forEach((item) => {
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
        }
      });
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  }

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
  function ensureAudioBoost() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      const source = audioCtx.createMediaElementSource(video);
      gainNode = audioCtx.createGain();
      gainNode.gain.value = state.volumeBoost / 100;
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    } catch (e) {
      console.warn('El refuerzo de volumen no está disponible en este navegador/dispositivo.', e);
      volumeBoostSlider.disabled = true;
      volumeBoostRow.title = 'No disponible en este navegador o dispositivo';
    }
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

  function playStream(url, title, meta) {
    destroyHls();
    $('#player-title').textContent = title;
    ensureAudioBoost();

    // meta.progressId identifica películas/episodios para guardar y retomar su posición.
    state.currentPlayback = meta ? { ...meta, url, title, lastSavedAt: 0 } : null;
    const resumeFrom = meta && meta.progressId ? ((getProgress(meta.progressId) || {}).position || 0) : 0;

    // El video/HLS también pasa por el proxy: así los segmentos viajan por
    // HTTPS y evitamos el mismo bloqueo de CORS/contenido mixto que en el login.
    const playbackUrl = proxied(url);

    if (url.includes('.m3u8') && window.Hls && window.Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 });
      state.hls = hls;
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        showPlayerStatus(false);
        if (resumeFrom > 5) video.currentTime = resumeFrom;
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          showPlayerStatus(true, 'No se pudo reproducir este canal. Verificá tu conexión o credenciales.');
        }
      });
    } else {
      video.src = playbackUrl;
      video.addEventListener('loadeddata', () => {
        showPlayerStatus(false);
        if (resumeFrom > 5) video.currentTime = resumeFrom;
      }, { once: true });
      video.addEventListener('error', () => {
        showPlayerStatus(true, 'No se pudo reproducir este contenido. El formato puede no ser compatible con el navegador.');
      }, { once: true });
      video.play().catch(() => {});
    }
  }

  /* Guarda el avance cada pocos segundos mientras se reproduce (throttle simple). */
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
  state.favorites = loadFavorites();
  state.progress = loadProgress();
  state.volumeBoost = loadVolumeBoost();
  updateVolumeBoostUI();
  renderSavedConnections();
})();