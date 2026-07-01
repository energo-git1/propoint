// ==UserScript==
// @name         TIVIS → Propoint importas
// @namespace    https://energolt.eu
// @version      1.2.0
// @description  Importuoja TIVIS užduotis į Propoint platformą
// @author       EnergoLT
// @match        https://tivis.eso.lt/*
// @homepageURL  http://10.2.1.115:3003
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      10.2.1.115
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

  // ── Ištraukti visus laukus iš detalaus puslapio ─────────────
  // Struktūra: eilutė "Laukas:" → kita eilutė yra reikšmė
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

        // Patikrinti ar jau importuota
        const tivisCode = d['Užsakymo Nr.'];
        const invNr = d['Investicinis numeris'];
        try {
          const existing = await gmFetch('GET', `${PROPOINT}/api/tasks`);
          const dup = existing.find(t => t.tivisCode === tivisCode || t.projectNumber === invNr);
          if (dup) {
            appendLog(`<br>⏭ Jau importuota kaip: <strong>${dup.name}</strong>`);
            appendLog(`🔗 <a href="${PROPOINT}" target="_blank">Atidaryti Propoint →</a>`);
            btn.disabled = false; btn.innerHTML = '⬆ Importuoti į Propoint'; return;
          }
        } catch(e) {}

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
          status:        mapStatus(d['Būsena']),
          createdAt:     new Date().toISOString(),
        };

        const r = await gmFetch('POST', `${PROPOINT}/api/tasks`, task);
        if (r._skip) {
          appendLog('<br>⏭ Ši užduotis jau egzistuoja Propoint sistemoje.');
        } else {
          appendLog(`<br>✅ <strong>Sėkmingai importuota!</strong>`);
          appendLog(`🔗 <a href="${PROPOINT}" target="_blank">Atidaryti Propoint →</a>`);
        }

      } else {
        // ── SĄRAŠO PUSLAPIS: masinis importas ────────────────
        appendLog('📋 Sąrašo puslapis — masinis importas...');

        let tivisTasks = [];
        try {
          const scope = angular.element(document.querySelector('[ng-controller]')).scope();
          tivisTasks = scope.items || scope.tasks || [];
        } catch(e) {}

        if (!tivisTasks.length) {
          appendLog('❌ Užduotys nerastos. Palaukite kol puslapis įsikraus.');
          btn.disabled = false; btn.innerHTML = '⬆ Importuoti viską į Propoint'; return;
        }
        appendLog(`📂 Rasta: <strong>${tivisTasks.length}</strong> užduočių`);

        const existing = await gmFetch('GET', `${PROPOINT}/api/tasks`).catch(() => []);
        const existingCodes = new Set(existing.map(t => t.tivisCode).filter(Boolean));

        let imported = 0, skipped = 0, errors = 0;
        for (const t of tivisTasks) {
          const code = t.task_code || t.work_code || String(t.id);
          if (existingCodes.has(code)) { skipped++; continue; }

          const task = {
            id:            uid(),
            tivisCode:     code,
            tivisId:       String(t.id),
            name:          t.object_name || `TIVIS ${t.id}`,
            projectNumber: t.investment_nr || '',
            address:       t.object_address || '',
            client:        'ESO',
            type:          t.work_kind || '',
            description:   [
              t.work_kind  ? `Darbų rūšis: ${t.work_kind}`  : '',
              t.supervisor ? `Vadovas: ${t.supervisor}`      : '',
              t.defect_nr  ? `Defekto nr.: ${t.defect_nr}`  : '',
              t.region     ? `Rajonas: ${t.region}`         : '',
              t.ward       ? `Seniūnija: ${t.ward}`         : '',
            ].filter(Boolean).join('\n'),
            deadline:      t.deadline || '',
            priority:      'Vidutinis',
            status:        'new',
            createdAt:     new Date().toISOString(),
          };

          try {
            const r = await gmFetch('POST', `${PROPOINT}/api/tasks`, task);
            if (r._skip) { skipped++; }
            else { imported++; appendLog(`✅ ${task.name}`); }
          } catch(e) {
            errors++;
            appendLog(`❌ ${task.name}: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 25));
        }

        appendLog(`<br>✅ Importuota: <strong>${imported}</strong> | ⏭ Praleista: <strong>${skipped}</strong> | ❌ Klaidos: <strong>${errors}</strong>`);
        if (imported > 0) appendLog(`🔗 <a href="${PROPOINT}" target="_blank">Atidaryti Propoint →</a>`);
      }

    } catch (e) {
      appendLog(`💥 Kritinė klaida: ${e.message}`);
    }

    btn.disabled = false;
    btn.innerHTML = isDetailPage() ? '⬆ Importuoti į Propoint' : '⬆ Importuoti viską į Propoint';
  });

})();
