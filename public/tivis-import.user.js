// ==UserScript==
// @name         TIVIS → Propoint importas
// @namespace    https://energolt.eu
// @version      1.3.0
// @description  Importuoja TIVIS užduotis į Propoint platformą (su dokumentais)
// @author       EnergoLT
// @match        https://tivis.eso.lt/*
// @homepageURL  http://10.2.1.115:3003
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      10.2.1.115
// @connect      tivis.eso.lt
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const PROPOINT = 'http://10.2.1.115:3003';

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function gmFetch(method, url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url,
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          try {
            const json = JSON.parse(r.responseText);
            if (r.status === 409) { resolve({ _skip: true }); return; }
            if (r.status >= 400) { reject(new Error(`HTTP ${r.status}: ${json.error || r.responseText}`)); return; }
            resolve(json);
          } catch (e) { reject(new Error('Parse error: ' + r.responseText.slice(0, 80))); }
        },
        onerror: () => reject(new Error('Tinklo klaida')),
      });
    });
  }

  // ── Atsisiųsti failą iš TIVIS (binary) ───────────────────────
  function downloadBinary(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload: (r) => {
          if (r.status === 200) resolve(r.response);
          else reject(new Error(`HTTP ${r.status}`));
        },
        onerror: () => reject(new Error('Atsisiuntimo klaida')),
      });
    });
  }

  // ── Įkelti failą į Propoint ───────────────────────────────────
  function uploadToPropoint(arrayBuffer, fileName) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([arrayBuffer]);
      const formData = new FormData();
      formData.append('file', blob, fileName);
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${PROPOINT}/api/upload`,
        data: formData,
        onload: (r) => {
          try {
            const json = JSON.parse(r.responseText);
            if (r.status >= 400) reject(new Error(json.error || 'Įkėlimo klaida'));
            else resolve(json);
          } catch (e) { reject(new Error('Parse error')); }
        },
        onerror: () => reject(new Error('Įkėlimo tinklo klaida')),
      });
    });
  }

  // ── Ištraukti ir įkelti dokumentus ───────────────────────────
  // Perleidžiame per visus dokumentų nuorodas, intercept'iname
  // window.open() ir parsisiunčiame failus per GM_xmlhttpRequest.
  async function extractAndUploadDocs(taskId, appendLog) {
    const links = Array.from(document.querySelectorAll('[ng-click*="downloadDocument"]'));
    if (!links.length) return 0;

    appendLog(`<br>📎 Randama dokumentų: <strong>${links.length}</strong>`);

    // Interceptuoti window.open kad sužinoti URL
    const origOpen = unsafeWindow.open;
    let capturedUrl = null;
    unsafeWindow.open = function(url) {
      capturedUrl = String(url);
      return null; // neleidžiame atidaryti naujo lango
    };

    let uploaded = 0;
    for (const link of links) {
      const docName = (link.innerText || '').trim() || 'dokumentas';
      capturedUrl = null;

      try {
        link.click();
        await new Promise(r => setTimeout(r, 400));

        if (!capturedUrl) {
          appendLog(`  ⚠️ ${docName}: URL nerastas`);
          continue;
        }

        appendLog(`  ⬇️ ${docName}...`);
        const binary = await downloadBinary(capturedUrl);

        // Pabandyti išgauti failo pavadinimą iš URL arba naudoti dokumento pavadinimą
        let fileName = docName;
        const urlMatch = capturedUrl.match(/\/([^/]+)\/task_id\//);
        // Pridėti .pdf plėtinį jei trūksta
        if (!fileName.match(/\.[a-zA-Z]{2,5}$/)) fileName += '.pdf';

        const fileInfo = await uploadToPropoint(binary, fileName);
        await gmFetch('POST', `${PROPOINT}/api/tasks/${taskId}/attachments`, {
          id: fileInfo.id || uid(),
          name: fileInfo.name || fileName,
          filename: fileInfo.filename,
          size: fileInfo.size || binary.byteLength,
          url: fileInfo.url,
        });

        appendLog(`  ✅ ${docName}`);
        uploaded++;
      } catch(e) {
        appendLog(`  ❌ ${docName}: ${e.message}`);
      }
    }

    unsafeWindow.open = origOpen; // atstatyti originalų window.open
    return uploaded;
  }

  // ── Ištraukti visus laukus iš detalaus puslapio ─────────────
  function extractAllFields() {
    const editPage = document.querySelector('#task_edit_page');
    if (!editPage) return null;
    const lines = editPage.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const data = {};
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].endsWith(':')) {
        const key = lines[i].slice(0, -1).trim();
        const val = lines[i + 1].endsWith(':') ? '' : lines[i + 1].trim();
        if (val) data[key] = val;
      }
    }
    return Object.keys(data).length > 2 ? data : null;
  }

  // ── Ar esame detalaus užsakymo puslapyje? ───────────────────
  function isDetailPage() {
    return !!document.querySelector('#task_edit_page');
  }

  // ── Statusų vertimas ─────────────────────────────────────────
  function mapStatus(busena) {
    const b = (busena || '').toLowerCase();
    if (b.includes('atmest'))   return 'rejected';
    if (b.includes('baigt'))    return 'completed';
    if (b.includes('tikrin'))   return 'review';
    if (b.includes('derin'))    return 'coordination';
    if (b.includes('vykdom'))   return 'in_progress';
    if (b.includes('priskirt')) return 'assigned';
    return 'new';
  }

  // ── UI stiliai ───────────────────────────────────────────────
  GM_addStyle(`
    #pp-import-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      background: #2563EB; color: #fff; border: none; border-radius: 10px;
      padding: 12px 20px; font-size: 14px; font-weight: 600;
      cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      display: flex; align-items: center; gap: 8px; transition: background .2s;
    }
    #pp-import-btn:hover { background: #1d4ed8; }
    #pp-import-btn:disabled { background: #64748b; cursor: not-allowed; }
    #pp-import-log {
      position: fixed; bottom: 76px; right: 24px; z-index: 99998;
      background: #0f172a; color: #e2e8f0; border-radius: 10px;
      padding: 14px 16px; font-size: 12px; font-family: monospace;
      max-height: 360px; width: 400px; overflow-y: auto;
      box-shadow: 0 4px 24px rgba(0,0,0,.4); display: none; line-height: 1.7;
    }
    #pp-import-log a { color: #60a5fa; }
  `);

  const btn = document.createElement('button');
  btn.id = 'pp-import-btn';
  btn.innerHTML = '⬆ Importuoti į Propoint';
  btn.disabled = true;
  document.body.appendChild(btn);

  const log = document.createElement('div');
  log.id = 'pp-import-log';
  document.body.appendChild(log);

  function appendLog(msg) {
    log.style.display = 'block';
    log.innerHTML += msg + '<br>';
    log.scrollTop = log.scrollHeight;
  }

  // ── Stebėti DOM pokyčius (TIVIS krauna turinį dinamiškai) ───
  let checkTimer = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      const detail = isDetailPage();
      btn.disabled = false;
      btn.innerHTML = detail
        ? '⬆ Importuoti į Propoint'
        : '⬆ Importuoti viską į Propoint';
      btn.title = detail
        ? 'Importuoti šį užsakymą į Propoint'
        : 'Importuoti visus sąrašo užsakymus į Propoint';
    }, 600);
  }

  scheduleCheck();
  new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });

  // ── Importas ─────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = '⏳ Importuojama...';
    log.innerHTML = '';
    log.style.display = 'block';

    try {
      if (isDetailPage()) {
        // ── DETALUS PUSLAPIS ──────────────────────────────────
        const d = extractAllFields();

        if (!d || (!d['Užsakymo Nr.'] && !d['Investicinis numeris'])) {
          appendLog('❌ Nerasta pagrindinių laukų. Palaukite kol puslapis pilnai įsikraus.');
          btn.disabled = false; btn.innerHTML = '⬆ Importuoti į Propoint'; return;
        }

        appendLog(`📋 <strong>${d['Užsakymo Nr.'] || '?'}</strong>`);
        appendLog(`🔑 Inv. nr.: <strong>${d['Investicinis numeris'] || '?'}</strong>`);
        appendLog(`📍 ${d['Objektas'] || '?'}`);
        appendLog(`🏠 ${d['Objekto adresas'] || '?'}`);

        const tivisCode = d['Užsakymo Nr.'];
        const invNr = d['Investicinis numeris'];

        // Patikrinti ar jau importuota
        let existingTask = null;
        try {
          const existing = await gmFetch('GET', `${PROPOINT}/api/tasks`);
          existingTask = existing.find(t => t.tivisCode === tivisCode || t.projectNumber === invNr);
        } catch(e) {}

        if (existingTask) {
          appendLog(`<br>⏭ Jau importuota: <strong>${existingTask.name}</strong>`);
          // Vis tiek siūlome atnaujinti dokumentus
          const hasLinks = document.querySelectorAll('[ng-click*="downloadDocument"]').length;
          if (hasLinks) {
            appendLog(`📎 Atnaujinami dokumentai...`);
            const n = await extractAndUploadDocs(existingTask.id, appendLog);
            if (n > 0) appendLog(`<br>✅ Įkelta dokumentų: <strong>${n}</strong>`);
          }
          appendLog(`🔗 <a href="${PROPOINT}" target="_blank">Atidaryti Propoint →</a>`);
          btn.disabled = false; btn.innerHTML = '⬆ Importuoti į Propoint'; return;
        }

        const descLines = [
          d['Darbų rūšis']                   ? `Darbų rūšis: ${d['Darbų rūšis']}`                          : '',
          d['Užsakymo tipas']                 ? `Užsakymo tipas: ${d['Užsakymo tipas']}`                    : '',
          d['Sutarties numeris']              ? `Sutarties nr.: ${d['Sutarties numeris']}`                   : '',
          d['Sutarties pabaiga']              ? `Sutarties pabaiga: ${d['Sutarties pabaiga']}`               : '',
          d['Preliminarus sutarties likutis'] ? `Sutarties likutis: ${d['Preliminarus sutarties likutis']}`  : '',
          d['Rangovas']                       ? `Rangovas: ${d['Rangovas']}`                                : '',
          d['Rangovo atstovas']               ? `Atstovas: ${d['Rangovo atstovas']}`                        : '',
          d['Rangovo projektų vadovas']       ? `Proj. vadovas: ${d['Rangovo projektų vadovas']}`           : '',
          d['Techninis prižiūrėtojas']        ? `Tech. prižiūrėtojas: ${d['Techninis prižiūrėtojas']}`     : '',
          d['Administracinis rajonas']        ? `Rajonas: ${d['Administracinis rajonas']}`                  : '',
          d['Regionas']                       ? `Regionas: ${d['Regionas']}`                               : '',
          d['Užsakymo pateikimo data']        ? `Pateikimo data: ${d['Užsakymo pateikimo data']}`           : '',
        ].filter(Boolean).join('\n');

        const task = {
          id:            uid(),
          tivisCode:     tivisCode || '',
          projectNumber: invNr || '',
          name:          d['Objekto adresas'] || d['Objektas'] || invNr || tivisCode,
          address:       d['Objektas'] || '',
          client:        'ESO',
          type:          d['Darbų rūšis'] || d['Užsakymo tipas'] || '',
          description:   descLines,
          deadline:      d['Sutarties pabaiga'] || '',
          priority:      'Vidutinis',
          statu