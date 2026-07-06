import './style.css';
import * as api from './api.js';

const app = document.getElementById('app');

/** Escapes text for safe insertion into HTML templates. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Holds cleanup for document-level ASR model picker listeners (cleared on route change). */
let disposeAsrModelPicker = null;

/** Stops mic / SpeechRecognition / MediaRecorder when leaving the library or starting a new session. */
let disposeBrowserLive = null;

/** Filters showcase models by id, label, or hosting keywords (serverless / hub). */
function filterShowcaseModels(models, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return models.slice();
  return models.filter((m) => {
    if (
      m.id.toLowerCase().includes(q) ||
      String(m.label || '')
        .toLowerCase()
        .includes(q)
    ) {
      return true;
    }
    if (q.includes('serverless') && m.hostedInference === true) return true;
    if (
      (q.includes('hub') || q.includes('local')) &&
      m.hostedInference === false
    )
      return true;
    return false;
  });
}

/** Renders ASR model rows into the searchable listbox. */
function renderAsrModelList(listEl, models) {
  listEl.innerHTML = models
    .map((m) => {
      const tag =
        m.hostedInference === true
          ? '<span class="pill">Serverless</span>'
          : m.hostedInference === false
            ? '<span class="pill pill-muted">Hub only</span>'
            : '';
      return `
    <li role="option" tabindex="-1" class="model-picker-item" data-id="${escapeHtml(m.id)}">
      <div class="model-picker-row">
        <span class="model-picker-id">${escapeHtml(m.id)}</span>
        ${tag}
      </div>
      <span class="model-picker-label muted">${escapeHtml(m.label)}</span>
    </li>`;
    })
    .join('');
}

/**
 * Wires the ASR combobox: focus or typing opens the list (filtered by the field), pick fills `#asrModel`.
 * @param {ParentNode} root — typically `#app`
 * @param {{ id: string; label: string }[]} models
 */
function wireAsrModelPicker(root, models) {
  if (disposeAsrModelPicker) disposeAsrModelPicker();
  const anchor = root.querySelector('#asrPickerAnchor');
  const input = root.querySelector('#asrModel');
  const picker = root.querySelector('#asrModelPicker');
  const list = root.querySelector('#asrModelList');
  if (!anchor || !input || !picker || !list) return;

  const all = Array.isArray(models) ? models : [];

  function showAllInList() {
    renderAsrModelList(list, all.slice());
  }

  function syncList() {
    renderAsrModelList(list, filterShowcaseModels(all, input.value));
  }

  /** @param {{ filter?: boolean }} [opts] — `filter: false` shows every model (e.g. on focus). */
  function setOpen(open, opts = {}) {
    const filter = opts.filter !== false;
    picker.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      if (filter) syncList();
      else showAllInList();
    }
  }

  input.addEventListener('focus', () => {
    setOpen(true, { filter: false });
  });

  input.addEventListener('input', () => {
    setOpen(true, { filter: true });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.hidden) {
      e.preventDefault();
      setOpen(false);
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!anchor.matches(':focus-within')) setOpen(false);
    }, 180);
  });

  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    e.preventDefault();
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    input.value = li.getAttribute('data-id') || '';
    setOpen(false);
  });

  const ac = new AbortController();
  document.addEventListener(
    'click',
    (e) => {
      if (picker.hidden) return;
      if (anchor.contains(e.target)) return;
      setOpen(false);
    },
    { signal: ac.signal },
  );
  disposeAsrModelPicker = () => ac.abort();
}

/** Formats milliseconds as mm:ss. */
function formatTime(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Parses current hash into { name, params }. */
function parseRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'asset' && parts[1]) {
    return { name: 'asset', id: decodeURIComponent(parts[1]), query };
  }
  return { name: 'library', query };
}

let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(fn, ms = 2000) {
  stopPolling();
  pollTimer = setInterval(fn, ms);
}

function setRoute(name, id) {
  if (name === 'asset' && id) {
    window.location.hash = `#/asset/${encodeURIComponent(id)}`;
  } else {
    window.location.hash = '#/';
  }
}

function jobBadge(label, slice) {
  if (!slice) return '';
  const st = slice.status || 'idle';
  const err = slice.error ? ` title="${escapeHtml(slice.error)}"` : '';
  return `<span class="pill job-pill"${err}>${escapeHtml(label)}: ${escapeHtml(st)}</span>`;
}

/** Picks a MIME type MediaRecorder can use in this browser (prefers Opus in WebM). */
function pickRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const t of candidates) {
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported?.(t)
    ) {
      return t;
    }
  }
  return '';
}

/** Maps library language hints to BCP-47 tags for SpeechRecognition.lang. */
function browserSpeechLang(hint) {
  switch (hint) {
    case 'hi':
      return 'hi-IN';
    case 'hinglish':
      return 'hi-IN';
    case 'en':
      return 'en-US';
    case 'auto':
    default:
      return `${navigator.language || 'en-US'}`;
  }
}

/**
 * Wires Browser (live): Web Speech API captions plus MediaRecorder on the same mic stream.
 * Offers upload (server ASR) or download of the captured blob.
 * @param {ParentNode} root
 */
function wireBrowserLive(root) {
  if (disposeBrowserLive) disposeBrowserLive();

  const unsupportedEl = root.querySelector('#browserLiveUnsupported');
  const btnStart = root.querySelector('#btnBrowserLiveStart');
  const btnStop = root.querySelector('#btnBrowserLiveStop');
  const langSel = root.querySelector('#browserLiveLang');
  const transcriptEl = root.querySelector('#browserLiveTranscript');
  const postEl = root.querySelector('#browserLivePost');
  const audioEl = root.querySelector('#browserLiveAudio');
  const btnUpload = root.querySelector('#btnBrowserLiveUpload');
  const downloadA = root.querySelector('#browserLiveDownload');
  const msgEl = root.querySelector('#browserLiveMsg');
  const langHintUpload = root.querySelector('#langHint');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || typeof MediaRecorder === 'undefined') {
    unsupportedEl.hidden = false;
    unsupportedEl.textContent = !SR
      ? 'Web Speech API (SpeechRecognition) is not available in this browser. Try Chrome or Edge for live captions.'
      : 'MediaRecorder is not available; audio cannot be saved.';
    btnStart.disabled = true;
    btnStop.disabled = true;
    disposeBrowserLive = null;
    return;
  }
  unsupportedEl.hidden = true;

  let mediaStream = null;
  let mediaRecorder = null;
  let recognition = null;
  /** @type {BlobPart[]} */
  let recorderChunks = [];
  let committedTranscript = '';
  /** @type {Blob | null} */
  let lastBlob = null;
  let lastBlobUrl = null;

  function releaseMic() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  function abortSession() {
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* ignore */
      }
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop();
      } catch (_) {
        /* ignore */
      }
    }
    mediaRecorder = null;
    recorderChunks = [];
    releaseMic();
  }

  function revokeLastBlobUrl() {
    if (lastBlobUrl) {
      URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = null;
    }
    lastBlob = null;
    if (audioEl) audioEl.removeAttribute('src');
    if (downloadA) {
      downloadA.removeAttribute('href');
      downloadA.removeAttribute('download');
      downloadA.setAttribute('aria-disabled', 'true');
    }
  }

  function hidePostCapture() {
    postEl.hidden = true;
    revokeLastBlobUrl();
    msgEl.textContent = '';
  }

  disposeBrowserLive = () => {
    abortSession();
    hidePostCapture();
    committedTranscript = '';
    transcriptEl.textContent = '—';
    btnStart.disabled = false;
    btnStop.disabled = true;
    disposeBrowserLive = null;
  };

  btnStart.addEventListener('click', async () => {
    hidePostCapture();
    committedTranscript = '';
    transcriptEl.textContent = 'Listening…';
    msgEl.textContent = '';

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      transcriptEl.textContent = '—';
      msgEl.textContent = e.message || String(e);
      return;
    }

    const mime = pickRecorderMimeType();
    try {
      mediaRecorder = mime
        ? new MediaRecorder(mediaStream, { mimeType: mime })
        : new MediaRecorder(mediaStream);
    } catch (_) {
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    recorderChunks = [];
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recorderChunks.push(ev.data);
    };

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = browserSpeechLang(langSel.value);

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const r = event.results[i];
        if (r.isFinal) committedTranscript += r[0].transcript;
        else interim += r[0].transcript;
      }
      const line = (committedTranscript + interim).trim();
      transcriptEl.textContent = line || '…';
    };

    recognition.onerror = (ev) => {
      const err = ev.error || 'error';
      if (err !== 'aborted' && err !== 'no-speech') {
        msgEl.textContent = `Speech recognition: ${err}`;
      }
    };

    mediaRecorder.start(500);

    try {
      recognition.start();
    } catch (e) {
      abortSession();
      transcriptEl.textContent = '—';
      msgEl.textContent = e.message || String(e);
      return;
    }

    btnStart.disabled = true;
    btnStop.disabled = false;
  });

  btnStop.addEventListener('click', () => {
    if (!mediaRecorder && !recognition) return;
    btnStop.disabled = true;

    const rec = mediaRecorder;
    const outType = rec?.mimeType || pickRecorderMimeType() || 'audio/webm';

    if (recognition) {
      try {
        recognition.stop();
      } catch (_) {
        /* ignore */
      }
    }

    const finishBlob = () => {
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition = null;
      }
      mediaRecorder = null;
      recorderChunks = [];
      releaseMic();
      btnStart.disabled = false;
      btnStop.disabled = true;
    };

    const publishRecording = () => {
      if (lastBlobUrl) {
        URL.revokeObjectURL(lastBlobUrl);
        lastBlobUrl = null;
      }
      lastBlob = new Blob(recorderChunks, { type: outType });
      lastBlobUrl = URL.createObjectURL(lastBlob);
      audioEl.src = lastBlobUrl;
      downloadA.href = lastBlobUrl;
      downloadA.setAttribute('aria-disabled', 'false');
      const ext = outType.includes('webm')
        ? 'webm'
        : outType.includes('mp4')
          ? 'm4a'
          : 'webm';
      downloadA.download = `browser-live-${Date.now()}.${ext}`;
      postEl.hidden = false;
      transcriptEl.textContent =
        (committedTranscript || '').trim() || '(No speech detected)';
    };

    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => {
        publishRecording();
        finishBlob();
      };
      try {
        rec.stop();
      } catch (_) {
        if (recorderChunks.length) publishRecording();
        finishBlob();
      }
    } else {
      if (recorderChunks.length) publishRecording();
      finishBlob();
    }
  });

  btnUpload.addEventListener('click', async () => {
    if (!lastBlob) return;
    btnUpload.disabled = true;
    msgEl.textContent = 'Uploading…';
    const type = lastBlob.type || 'audio/webm';
    const ext = type.includes('webm')
      ? 'webm'
      : type.includes('mp4')
        ? 'm4a'
        : 'webm';
    const file = new File([lastBlob], `browser-live-${Date.now()}.${ext}`, {
      type,
    });
    const lang = langHintUpload?.value || 'auto';
    try {
      const { ids } = await api.uploadAssets([file], lang);
      msgEl.textContent = 'Uploaded.';
      if (ids?.length === 1) setRoute('asset', ids[0]);
      else render();
    } catch (e) {
      msgEl.textContent = e.message || String(e);
    } finally {
      btnUpload.disabled = false;
    }
  });
}

async function renderLibrary() {
  if (disposeAsrModelPicker) disposeAsrModelPicker();
  if (disposeBrowserLive) disposeBrowserLive();
  stopPolling();
  let assets = [];
  let errMsg = '';
  try {
    assets = await api.listAssets();
  } catch (e) {
    errMsg = e.message || String(e);
  }

  app.innerHTML = `
    <header class="app-header">
      <div class="app-header-inner">
        <div class="app-brand">
          <h1>Audio Library</h1>
          <p>Upload, transcribe with Hugging Face, search, and edit transcripts.</p>
        </div>
        <div class="app-header-actions">
          <label class="sr-only" for="searchQ">Search library</label>
          <input class="input" type="search" id="searchQ" placeholder="Search transcripts…" style="min-width:12rem" />
          <label class="muted row" style="gap:0.35rem">
            <input type="checkbox" id="searchSemantic" />
            Semantic
          </label>
          <button type="button" class="btn btn-primary" id="btnSearch">Search</button>
        </div>
      </div>
    </header>
    <main class="app-main stack">
      ${errMsg ? `<div class="error" role="alert">${escapeHtml(errMsg)}</div>` : ''}
      <section class="card">
        <h2 style="margin-top:0">Upload</h2>
        <p class="muted">Add one or more audio files. Language hint helps ASR for Hindi, English, or mixed speech.</p>
        <div class="row" style="margin-top:0.75rem">
          <label class="sr-only" for="langHint">Language hint</label>
          <select class="select" id="langHint" aria-label="Language hint">
            <option value="auto">Auto-detect</option>
            <option value="en">English</option>
            <option value="hi">Hindi</option>
            <option value="hinglish">Hinglish (auto)</option>
          </select>
          <input type="file" id="fileInput" class="sr-only" multiple accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac" />
          <button type="button" class="btn" id="btnPick">Choose files</button>
          <button type="button" class="btn btn-primary" id="btnUpload" disabled>Upload</button>
        </div>
        <p class="muted" id="fileLabel" style="margin-top:0.5rem">No files selected</p>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Browser (live)</h2>
        <p class="muted">
          Live captions via the Web Speech API while recording the same microphone audio to a file.
          Upload uses the language hint from <strong>Upload</strong> above for server ASR. Chromium-based browsers work best.
        </p>
        
        <div id="browserLiveUnsupported" class="error" role="alert" hidden></div>
        
        <label class="muted" for="browserLiveLang">Speech language<label/>
                   
        <div class="row" style="margin-top:0.75rem;flex-wrap:wrap">
            <select class="select" id="browserLiveLang" aria-label="Speech recognition language">
              <option value="auto">Match browser</option>
              <option value="en">English (en-US)</option>
              <option value="hi">Hindi (hi-IN)</option>
              <option value="hinglish">Hinglish (hi-IN)</option>
            </select>
 
          <div class="row" style="align-items:flex-end;gap:0.5rem">

            <button type="button" class="btn btn-primary" id="btnBrowserLiveStart">Start</button>
            <button type="button" class="btn" id="btnBrowserLiveStop" disabled>Stop</button>
          </div>
        </div>
        <p class="muted" style="margin:0.75rem 0 0.35rem;font-size:0.88rem">Live transcript</p>
        <div id="browserLiveTranscript" class="live-transcript" aria-live="polite">—</div>
        <div id="browserLivePost" class="stack" style="margin-top:1rem" hidden>
          <p class="muted" style="margin:0">Recorded audio</p>
          <audio id="browserLiveAudio" controls style="width:100%;max-width:28rem"></audio>
          <div class="row" style="flex-wrap:wrap">
            <button type="button" class="btn btn-primary" id="btnBrowserLiveUpload">Upload to library</button>
            <a class="btn" id="browserLiveDownload" download aria-disabled="true">Download</a>
          </div>
          <p class="muted" id="browserLiveMsg" style="margin:0"></p>
        </div>
      </section>
      <div id="searchResults" class="stack" hidden></div>
      <section>
        <h2>Your recordings</h2>
        <div id="assetGrid" class="grid grid-2 grid-3"></div>
      </section>
    </main>
  `;

  const fileInput = app.querySelector('#fileInput');
  const fileLabel = app.querySelector('#fileLabel');
  const btnPick = app.querySelector('#btnPick');
  const btnUpload = app.querySelector('#btnUpload');
  const grid = app.querySelector('#assetGrid');

  btnPick.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const n = fileInput.files?.length ?? 0;
    fileLabel.textContent = n ? `${n} file(s) selected` : 'No files selected';
    btnUpload.disabled = !n;
  });

  btnUpload.addEventListener('click', async () => {
    const files = fileInput.files;
    if (!files?.length) return;
    btnUpload.disabled = true;
    try {
      const lang = app.querySelector('#langHint').value;
      const { ids } = await api.uploadAssets(files, lang);
      fileInput.value = '';
      fileLabel.textContent = 'No files selected';
      if (ids?.length === 1) setRoute('asset', ids[0]);
      else render();
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      btnUpload.disabled = !fileInput.files?.length;
    }
  });

  const searchResults = app.querySelector('#searchResults');
  app.querySelector('#btnSearch').addEventListener('click', async () => {
    const q = app.querySelector('#searchQ').value.trim();
    const semantic = app.querySelector('#searchSemantic').checked;
    if (!q) {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
      return;
    }
    try {
      const data = await api.librarySearch(q, semantic);
      const merged = data.merged || [];
      searchResults.hidden = false;
      if (!merged.length) {
        searchResults.innerHTML =
          '<section class="card"><p class="muted">No matches.</p></section>';
        return;
      }
      searchResults.innerHTML = `
        <section class="card">
          <h3 style="margin-top:0">Results</h3>
          <ul class="stack" style="list-style:none;padding:0;margin:0">
            ${merged
              .slice(0, 40)
              .map(
                (h) => `
              <li>
                <a href="#/asset/${encodeURIComponent(h.assetId)}">
                  ${escapeHtml(h.assetId.slice(0, 8))}…
                </a>
                <span class="muted"> · ${escapeHtml(h.kind || '')}</span>
                <div class="muted" style="margin-top:0.25rem;font-size:0.85rem">${escapeHtml(h.snippet || '')}</div>
              </li>`,
              )
              .join('')}
          </ul>
        </section>
      `;
    } catch (e) {
      searchResults.hidden = false;
      searchResults.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`;
    }
  });

  grid.innerHTML = assets.length
    ? assets
        .map((a) => {
          const title = escapeHtml(a.title || a.id);
          const jobs = a.jobs || {};
          return `
        <article class="card card-interactive" data-id="${escapeHtml(a.id)}" role="link" tabindex="0">
          <h3 style="margin:0 0 0.35rem;font-size:1.15rem">${title}</h3>
          <p class="muted" style="margin:0">${escapeHtml(a.status || '')} · ${a.segmentCount ?? 0} segments</p>
          <div style="margin-top:0.65rem">
            ${jobBadge('ASR', jobs.transcribe)}
            ${jobBadge('Embed', jobs.embed)}
            ${jobBadge('Export', jobs.export)}
          </div>
        </article>`;
        })
        .join('')
    : '<p class="muted">No assets yet. Upload audio to begin.</p>';

  grid.querySelectorAll('[data-id]').forEach((el) => {
    const id = el.getAttribute('data-id');
    const open = () => setRoute('asset', id);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        open();
      }
    });
  });

  wireBrowserLive(app);
}

async function renderAsset(id) {
  if (disposeAsrModelPicker) disposeAsrModelPicker();
  if (disposeBrowserLive) disposeBrowserLive();
  stopPolling();
  let asset = null;
  let runsData = { runs: [] };
  let hfModels = {
    defaultAsrModel: '',
    defaultEmbedModel: '',
    defaultAsrRuntime: 'hosted',
    asr: [],
    embedding: [],
    asrCatalogNote: '',
    localAsrAdminGuide: '',
  };
  let errMsg = '';
  try {
    [asset, runsData, hfModels] = await Promise.all([
      api.getAsset(id),
      api.getRuns(id).catch(() => ({ runs: [] })),
      api.getHfModels().catch(() => ({
        defaultAsrModel: '',
        defaultEmbedModel: '',
        defaultAsrRuntime: 'hosted',
        asr: [],
        embedding: [],
        asrCatalogNote: '',
        localAsrAdminGuide: '',
      })),
    ]);
  } catch (e) {
    errMsg = e.message || String(e);
  }

  if (!asset && !errMsg) errMsg = 'Asset not found';

  const defaultAsr = escapeHtml(hfModels.defaultAsrModel || '—');
  const defaultEmbed = escapeHtml(hfModels.defaultEmbedModel || '—');
  const defaultAsrRuntime = escapeHtml(hfModels.defaultAsrRuntime || 'hosted');
  const asrCatalogNote = escapeHtml(
    hfModels.asrCatalogNote ||
      'ASR suggestions require Hugging Face serverless inference routing for the chosen model.',
  );
  const localAsrAdminBlock = hfModels.localAsrAdminGuide
    ? `<details class="admin-guide" style="margin:0.5rem 0 0"><summary class="muted" style="cursor:pointer;font-size:0.88rem">Admin: enable local ASR (Parakeet / Hub-only)</summary><pre class="admin-guide-pre">${escapeHtml(hfModels.localAsrAdminGuide)}</pre></details>`
    : '';
  const embedShowcase =
    (hfModels.embedding || [])
      .slice(0, 8)
      .map((m) => `<code>${escapeHtml(m.id)}</code>`)
      .join(' · ') || '—';

  const jobs = asset?.jobs || {};
  const segments = asset?.segments || [];
  const runs = runsData.runs || [];

  app.innerHTML = `
    <header class="app-header">
      <div class="app-header-inner">
        <div class="app-brand">
          <p class="muted" style="margin:0"><a href="#/">← Library</a></p>
          <h1>${escapeHtml(asset?.title || id)}</h1>
          <p class="muted" style="margin:0.25rem 0 0">${escapeHtml(asset?.id || id)}</p>
        </div>
        <div class="app-header-actions">
          ${jobBadge('ASR', jobs.transcribe)}
          ${jobBadge('Embed', jobs.embed)}
          ${jobBadge('Export', jobs.export)}
        </div>
      </div>
    </header>
    <main class="app-main stack">
      ${errMsg ? `<div class="error">${escapeHtml(errMsg)}</div>` : ''}
      ${
        asset
          ? `
      <div class="grid" style="gap:1.5rem">
        <div class="stack">
          <section class="card player-panel">
            <h2 style="margin-top:0">Playback</h2>
            ${
              asset.audioUrl
                ? `<audio id="player" controls src="${escapeHtml(asset.audioUrl)}"></audio>`
                : '<p class="muted">No audio URL</p>'
            }
            <div class="divider-soft"></div>
            <h3>Export selection</h3>
            <p class="muted">Use the playhead or type milliseconds.</p>
            <div class="row">
              <label class="muted">Start ms<br/><input class="input" type="number" id="exStart" value="0" min="0" /></label>
              <label class="muted">End ms<br/><input class="input" type="number" id="exEnd" value="0" min="0" /></label>
              <label class="muted">Format<br/>
                <select class="select" id="exFmt"><option value="wav">wav</option><option value="mp3">mp3</option></select>
              </label>
            </div>
            <div class="row" style="margin-top:0.5rem">
              <button type="button" class="btn btn-ghost" id="btnMarkStart">Mark start</button>
              <button type="button" class="btn btn-ghost" id="btnMarkEnd">Mark end</button>
              <button type="button" class="btn btn-primary" id="btnExport">Export clip</button>
            </div>
            <p class="muted" id="exportMsg"></p>
          </section>
          <section class="card">
            <h2 style="margin-top:0">Metadata</h2>
            <label class="muted">Title<br/>
              <input class="input" type="text" id="metaTitle" value="${escapeHtml(asset.title || '')}" style="width:100%;max-width:100%" />
            </label>
            <label class="muted" style="display:block;margin-top:0.75rem">Language hint<br/>
              <select class="select" id="metaLang" style="width:100%">
                <option value="auto">auto</option>
                <option value="en">en</option>
                <option value="hi">hi</option>
                <option value="hinglish">hinglish</option>
              </select>
            </label>
            <button type="button" class="btn btn-primary" style="margin-top:1rem" id="btnSaveMeta">Save metadata</button>
          </section>
          <section class="card">
            <h2 style="margin-top:0">Jobs</h2>
            <p class="muted" style="margin:0 0 0.75rem;font-size:0.88rem">
              Server defaults — ASR: <code>${defaultAsr}</code> · Embed: <code>${defaultEmbed}</code> · ASR mode: <code>${defaultAsrRuntime}</code> <span class="muted">(hosted = serverless API; local = Python Transformers on this machine)</span>
            </p>
            <label class="muted" for="asrModel">ASR model (optional override)</label>
            <p class="muted" style="margin:0.15rem 0 0.35rem;font-size:0.85rem">
              Focus the field to open the list; type to filter. Leave blank for the server default or paste any model id.
            </p>
            <p class="muted" style="margin:0 0 0.5rem;font-size:0.8rem">${asrCatalogNote}</p>
            ${localAsrAdminBlock}
            <div class="model-picker-anchor" id="asrPickerAnchor">
              <input
                class="input"
                type="text"
                id="asrModel"
                autocomplete="off"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded="false"
                aria-controls="asrModelList"
                placeholder="Server default — focus to browse"
                style="width:100%"
              />
              <div class="model-picker" id="asrModelPicker" hidden>
                <ul id="asrModelList" class="model-picker-list" role="listbox"></ul>
              </div>
            </div>
            <p class="muted" style="margin-top:0.5rem;font-size:0.82rem">Embedding models (reindex / semantic search): ${embedShowcase}</p>
            <div class="row" style="margin-top:0.75rem">
              <button type="button" class="btn btn-primary" id="btnTranscribe">Run transcription</button>
              <button type="button" class="btn" id="btnReindex">Rebuild search index</button>
            </div>
            <p class="muted" id="jobMsg"></p>
          </section>
          <section class="card">
            <h2 style="margin-top:0">Transcription runs</h2>
            <p class="muted">Canonical: <strong>${escapeHtml(String(asset.canonicalRun ?? '—'))}</strong></p>
            <ul id="runsList" style="list-style:none;padding:0;margin:0" class="stack"></ul>
          </section>
        </div>
        <section class="card">
          <div class="row" style="justify-content:space-between;margin-bottom:0.75rem">
            <h2 style="margin:0">Transcript</h2>
            <button type="button" class="btn btn-primary" id="btnSaveTx">Save transcript</button>
          </div>
          <p class="muted">Click a row to seek. Edit text and save when finished.</p>
          <div id="segList" class="stack" style="margin-top:1rem"></div>
        </section>
      </div>`
          : ''
      }
    </main>
  `;

  if (!asset) return;

  wireAsrModelPicker(app, hfModels.asr);

  const langSel = app.querySelector('#metaLang');
  const hint = asset.languageHint || 'auto';
  langSel.value = ['auto', 'en', 'hi', 'hinglish'].includes(hint)
    ? hint
    : 'auto';

  const player = app.querySelector('#player');
  const segList = app.querySelector('#segList');

  function renderSegments(activeIdx = -1) {
    segList.innerHTML = segments
      .map((seg, idx) => {
        const spk = seg.speaker ? escapeHtml(seg.speaker) : '';
        return `
        <div class="segment-row${idx === activeIdx ? ' is-active' : ''}" data-idx="${idx}" data-start="${seg.startMs}" data-end="${seg.endMs}">
          <div class="segment-time">${formatTime(seg.startMs)}</div>
          <div class="segment-fields">
            ${spk ? `<span class="pill">${spk}</span>` : ''}
            <div contenteditable="true" class="input seg-text" data-idx="${idx}">
             ${escapeHtml(seg.text || '')} 
            </div>
            </div>
        </div>`;
      })
      .join('');

    segList.querySelectorAll('.segment-row').forEach((row) => {
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.seg-text')) return;
        const start = Number(row.dataset.start);
        if (player && !Number.isNaN(start)) {
          player.currentTime = start / 1000;
          player.play().catch(() => {});
        }
      });
    });
  }

  renderSegments();

  if (player) {
    player.addEventListener('timeupdate', () => {
      const t = player.currentTime * 1000;
      let idx = -1;
      for (let i = 0; i < segments.length; i++) {
        if (t >= segments[i].startMs && t < segments[i].endMs) {
          idx = i;
          break;
        }
      }
      segList.querySelectorAll('.segment-row').forEach((row, i) => {
        row.classList.toggle('is-active', i === idx);
      });
    });
  }

  app.querySelector('#btnMarkStart')?.addEventListener('click', () => {
    if (!player) return;
    app.querySelector('#exStart').value = String(
      Math.floor(player.currentTime * 1000),
    );
  });
  app.querySelector('#btnMarkEnd')?.addEventListener('click', () => {
    if (!player) return;
    app.querySelector('#exEnd').value = String(
      Math.floor(player.currentTime * 1000),
    );
  });

  app.querySelector('#btnExport')?.addEventListener('click', async () => {
    const msg = app.querySelector('#exportMsg');
    msg.textContent = '';
    const startMs = Number(app.querySelector('#exStart').value);
    const endMs = Number(app.querySelector('#exEnd').value);
    const format = app.querySelector('#exFmt').value;
    try {
      const out = await api.postExport(id, startMs, endMs, format);
      if (out.downloadUrl) {
        msg.innerHTML = `Ready: <a href="${escapeHtml(out.downloadUrl)}" download>Download clip</a>`;
      }
    } catch (e) {
      msg.textContent = e.message || String(e);
    }
  });

  app.querySelector('#btnSaveMeta')?.addEventListener('click', async () => {
    const title = app.querySelector('#metaTitle').value;
    const languageHint = app.querySelector('#metaLang').value;
    try {
      await api.patchAssetMeta(id, { title, languageHint });
      app.querySelector('#jobMsg').textContent = 'Metadata saved.';
    } catch (e) {
      app.querySelector('#jobMsg').textContent = e.message || String(e);
    }
  });

  app.querySelector('#btnTranscribe')?.addEventListener('click', async () => {
    const msg = app.querySelector('#jobMsg');
    msg.textContent = 'Starting transcription…';
    const model = app.querySelector('#asrModel').value.trim();
    const strategies = model ? [{ model }] : undefined;
    try {
      await api.postTranscribe(id, strategies);
      msg.textContent =
        'Transcription running on server. This page will refresh status.';
      scheduleAssetPoll(id, true);
    } catch (e) {
      msg.textContent = e.message || String(e);
    }
  });

  app.querySelector('#btnReindex')?.addEventListener('click', async () => {
    const msg = app.querySelector('#jobMsg');
    msg.textContent = 'Reindex started…';
    try {
      await api.postReindex(id);
      scheduleAssetPoll(id, true);
    } catch (e) {
      msg.textContent = e.message || String(e);
    }
  });

  app.querySelector('#btnSaveTx')?.addEventListener('click', async () => {
    const msg = app.querySelector('#jobMsg');
    const next = segments.map((seg, idx) => {
      const inp = segList.querySelector(`.seg-text[data-idx="${idx}"]`);
      return {
        startMs: seg.startMs,
        endMs: seg.endMs,
        speaker: seg.speaker,
        text: inp ? inp.innerText.trim() : seg.text,
        raw: seg.raw,
      };
    });
    try {
      await api.patchTranscript(id, next);
      msg.textContent = 'Transcript saved.';
    } catch (e) {
      msg.textContent = e.message || String(e);
    }
  });

  const runsList = app.querySelector('#runsList');
  runsList.innerHTML = runs.length
    ? runs
        .map(
          (r) => `
      <li class="row" style="justify-content:space-between">
        <code class="muted">${escapeHtml(r.slug)}</code>
        <button type="button" class="btn btn-ghost btn-promote" data-slug="${escapeHtml(r.slug)}">Promote</button>
      </li>`,
        )
        .join('')
    : '<li class="muted">No runs yet. Run transcription first.</li>';

  runsList.querySelectorAll('.btn-promote').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.getAttribute('data-slug');
      try {
        await api.promoteRun(id, slug);
        render();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  });

  function shouldPoll(j) {
    return (
      j?.transcribe?.status === 'running' || j?.embed?.status === 'running'
    );
  }

  /** Polls asset until ASR/embed jobs finish; `force` starts polling even if idle now. */
  function scheduleAssetPoll(assetId, force = false) {
    if (!force && !shouldPoll(jobs)) return;
    startPolling(async () => {
      try {
        const fresh = await api.getAsset(assetId);
        if (!shouldPoll(fresh.jobs)) {
          stopPolling();
          render();
        }
      } catch {
        stopPolling();
      }
    });
  }

  scheduleAssetPoll(id, false);
}

function render() {
  const route = parseRoute();
  if (route.name === 'asset') renderAsset(route.id);
  else renderLibrary();
}

window.addEventListener('hashchange', render);
render();
