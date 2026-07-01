// ==UserScript==
// @name         TIVIS → Propoint importas
// @namespace    https://energolt.eu
// @version      1.1.0
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
        method,
        url,
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

  // ── Laukų ištraukimas iš detalaus puslapio ──────────────────
  // Ieško label:value porų (td/dt/label su tekstu → sekantis elementas su reikšme)
  function extractField(labelText) {
    const els = document.querySelectorAll('td, th, label, dt, .control-label, .field-label');
    for (const el of els) {
      if (el.textContent.trim().replace(/:$/, '').toLowerCase() === labelText.toLowerCase()) {
        // Sekantis sibling arba parent sekantis
        const next = el.nextElementSibling || el.closest('tr')?.nextElementSibling?.querySelector('td');
        if (next) return next.textContent.trim();
      }
    }
    // Fallback: ieškoti teksto ir grąžinti po dvitaškio
    const all = document.body.innerText;
    const re = new RegExp(labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:?\\s*([^\\n]+)', 'i');
    const m = all.match(re);
    return m ? m[1].trim() : '';
  }

  function extractDetailData() {
    const fields = [
      'Užsakymo Nr.',
      'Investicinis numeris',
      'Objektas',
      'Objekto adresas',
      'Administracinis rajonas',
      'Darbų rūšis',
      'Užsakymo tipas',
      'Sutarties numeris',
      'Sutarties pabaiga',
      'Preliminarus sutarties likutis',
      'Rangovas',
      'Rangovo atstovas',
      'Rangovo projektų vadovas',
      'Užsakymo pateikimo data',
      'Būsena',
      'Regionas',
    ];
    const data = {};
    for (const f of fields) {
      data[f] = extractField(f);
    }
    return data;
  }

  // ── Ar esame detalaus užsakymo puslapyje? ───────────────────
  function isDetailPage() {
    // Detalus puslapis turi "Užsakymo Nr." lauką ir ISSAUGOTI mygtuką
    const hasOrderNr = !!extractField('Užsakymo Nr.');
    const hasSave = !!document.querySelector('button[ng-click*="save"], .btn-success, [data-action="save"]');
    const hasInvNr = !!extractField('Investicinis numeris');
    return hasOrderNr || hasInvNr || hasSave;
  }

  // ── Statusų vertimas ─────────────────────────────────────────
  function mapStatus(busena) {
    const b = (busena || '').toLowerCase();
    if (b.includes('atmest'))    return 'rejected';
    if (b.includes('baigt'))     return 'completed';
    if (b.includes('tikrin'))    return 'review';
    if (b.includes('derin'))     return 'coordination';
    if (b.includes('vykdom'))    return 'in_progress';
    if (b.includes('priskirt'))  return 'assigned';
    return 'new';
  }

  // ── UI stiliai ───────────────────────────────────────────────
  GM_addStyle(`
    #pp-import-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      background: #2563EB; color: #fff; border: none; border-radius: 10px;
      padding: 12px 20px; font-size: 14px; font-weight: 600;
      cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      display: flex; align-items: center; gap: 8px;
    }
    #pp-import-btn:hover { background: #1d4ed8; }
    #pp-import-btn:disabled { background: #64748b; cursor: not-allowed; }
    #pp-import-log {
      position: fixed; bottom: 76px; right: 24px; z-index: 99998;
      background: #0f172a; color: #e2e8f0; border-radius: 10px;
      padding: 14px 16px; font-size: 12px; font-family: monospace;
      max-height: 340px; width: 380px; overflow-y: auto;
      box-shadow: 0 4px 24px rgba(0,0,0,.4); display: none;
      line-height: 1.6;
    }
  `);

  const btn = document.createElement('button');
  btn.id = 'pp-import-btn';
  document.body.appendChild(btn);

  const log = document.createElement('div');
  log.id = 'pp-import-log';
  document.body.appendChild(log);

  function appendLog(msg) {
    log.style.display = 'block';
    log.innerHTML += msg + '<br>';
    log.scrollTop = log.scrollHeight;
  }

  // ── Palaukti kol puslapis pilnai įsikraus ───────────────────
  function waitReady(cb, tries = 0) {
    if (tries > 80) return;
    const ready = document.querySelector('[ng-controller]') || document.querySelector('.container');
    if (ready) { setTimeout(cb, 300); return; }
    setTimeout(() => waitReady(cb, tries + 1), 400);
  }

  waitReady(() => {
    const detail = isDetailPage();
    btn.innerHTML = detail ? '⬆ Importuoti į Propoint' : '⬆ Importuoti viską į Propoint';
    btn.disabled = false;
    btn.title = detail
      ? 'Importuoti šią užduotį į Propoint'
      : 'Importuoti visas sąrašo užduotis į Propoint';
  });

  // ── Importas ─────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = '⏳ Importuojama...';
    log.innerHTML = '';
    log.style.display = 'block';

    try {
      if (isDetailPage()) {
        // ── DETALUS PUSLAPIS: importuoti vieną užduotį ────────
        const d = extractDetailData();

        appendLog(`📋 Užsakymo Nr.: <strong>${d['Užsakymo Nr.'] || '?'}</strong>`);
        appendLog(`🔑 Inv. nr.: <strong>${d['Investicinis numeris'] || '?'}</strong>`);

        if (!d['Užsakymo Nr.'] && !d['Investicinis numeris']) {
          appendLog('❌ Nerasta pagrindinių laukų. Patikrinkite ar esate detalaus užsakymo puslapyje.');
          btn.disabled = false; btn.innerHTML = '⬆ Importuoti į Propoint'; return;
        }

        // Patikrinti ar jau importuota
        const tivisCode = d['Užsakymo Nr.'];
        try {
          const existing = await gmFetch('GET', `${PROPOINT}/api/tasks`);
          const dup = existing.find(t => t.tivisCode === tivisCode || t.projectNumber === d['Investicinis numeris']);
          if (dup) {
            appendLog(`⏭ Jau importuota: <strong>${dup.name}</strong>`);
            btn.disabled = false; btn.innerHTML = '⬆ Importuoti į Propoint'; return;
          }
        } catch(e) {}

        const descLines = [
          d['Darbų rūšis']                   ? `Darbų rūšis: ${d['Darbų rūšis']}`                       : '',
          d['Užsakymo tipas']                 ? `Užsakymo tipas: ${d['Užsakymo tipas']}`                 : '',
          d['Sutarties numeris']              ? `Sutarties nr.: ${d['Sutarties numeris']}`                : '',
          d['Sutarties pabaiga']              ? `Sutarties pabaiga: ${d['Sutarties pabaiga']}`            : '',
          d['Preliminarus sutarties likutis'] ? `Sutarties likutis: ${d['Preliminarus sutarties likutis']}` : '',
          d['Rangovas']                       ? `Rangovas: ${d['Rangovas']}`                             : '',
          d['Rangovo atstovas']               ? `Atstovas: ${d['Rangovo atstovas']}`                     : '',
          d['Rangovo projektų vadovas']       ? `Proj. vadovas: ${d['Rangovo projektų vadovas']}`        : '',
          d['Administracinis rajonas']        ? `Rajonas: ${d['Administracinis rajonas']}`               : '',
          d['Regionas']                       ? `Regionas: ${d['Regionas']}`                             : '',
        ].filter(Boolean).join('\n');

        const task = {
          id:            uid(),
          tivisCode:     d['Užsakymo Nr.'] || '',
          projectNumber: d['Investicinis numeris'] || '',
          name:          d['Objektas'] || d['Investicinis numeris'] || tivisCode,
          address:       d['Objekto adresas'] || '',
          client:        'ESO',
          type:          d['Darbų rūšis'] || '',
          description:   descLines,
          deadline:      d['Sutarties pabaiga'] || '',
          priority:      'Vidutinis',
          status:        mapStatus(d['Būsena']),
          createdAt:     new Date().toISOString(),
        };

        const r = await gmFetch('POST', `${PROPOINT}/api/tasks`, task);
        if (r._skip) {
          appendLog('⏭ Ši užduotis jau egzistuoja Propoint sistemoje.');
        } else {
          appendLog(`✅ Importuota: <strong>${task.name}</strong>`);
          appendLog(`   Statusas: ${task.status}`);
          appendLog(`   Proj. nr.: ${task.projectNumber}`);
          appendLog(`<br>🔗 <a href="${PROPOINT}" target="_blank" style="color:#60a5fa">Atidaryti Propoint →</a>`);
        }

      } else {
        // ── SĄRAŠO PUSLAPIS: masinis importas ─────────────────
        // (senoji logika)
        appendLog('ℹ️ Sąrašo puslapis — masinis importas');
        const scope = window.angular
          ? angular.element(document.querySelector('[ng-controller]')).scope()
          : null;
        const tivisTasks = scope ? (scope.items || scope.tasks || []) : [];

        if (!tivisTasks.length) {
          appendLog('❌ Užduotys nerastos. Palaukite kol puslapis įsikraus.');
          btn.disabled = false; btn.innerHTML = '⬆ Importuoti viską į Propoint'; return;
        }
        appendLog(`📂 Rasta: ${tivisTasks.length} užduočių`);

        const existingIds = new Set();
        const existing = await gmFetch('GET', `${PROPOINT}/api/tasks`).catch(() => []);
        for (const t of existing) if (t.tivisCode) existingIds.add(t.tivisCode);

        let imported = 0, skipped = 0, errors = 0;
        for (const t of tivisTasks) {
          const code = t.task_code || t.work_code || String(t.id);
          if (existingIds.has(code)) { skipped++; continue; }

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
      }

    } catch (e) {
      appendLog(`💥 Kritinė klaida: ${e.message}`);
    }

    btn.disabled = false;
    btn.innerHTML = isDetailPage() ? '⬆ Importuoti į Propoint' : '⬆ Importuoti viską į Propoint';
  });

})();
