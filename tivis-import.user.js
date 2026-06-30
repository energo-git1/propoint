// ==UserScript==
// @name         TIVIS → Propoint importas
// @namespace    https://energolt.eu
// @version      1.0.1
// @description  Importuoja TIVIS užduotis į Propoint platformą
// @author       EnergoLT
// @match        https://tivis.eso.lt/task/index/list*
// @homepageURL  http://10.2.1.115:3003
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      10.2.1.115
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Palaukti kol Angular pilnai įsikraus
  function waitForAngular(cb, tries = 0) {
    if (tries > 60) { console.warn('Propoint: Angular nepasiekiamas'); return; }
    try {
      const el = document.querySelector('[ng-controller]');
      if (el && window.angular && angular.element(el).scope()) { cb(); return; }
    } catch(e) {}
    setTimeout(() => waitForAngular(cb, tries + 1), 500);
  }

  const PROPOINT = 'http://10.2.1.115:3003';

  const STATUS_MAP = {
    'SENT':      'new',
    'ASSIGNED':  'assigned',
    'IN_WORK':   'in_progress',
    'COORD':     'coordination',
    'REVIEW':    'review',
    'DONE':      'completed',
    'REJECTED':  'rejected',
    'SUSPENDED': 'rejected',
  };

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

  // ── UI ──────────────────────────────────────────────────────
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
  btn.innerHTML = '⬆ Importuoti į Propoint';
  document.body.appendChild(btn);

  const log = document.createElement('div');
  log.id = 'pp-import-log';
  document.body.appendChild(log);

  function appendLog(msg) {
    log.style.display = 'block';
    log.innerHTML += msg + '<br>';
    log.scrollTop = log.scrollHeight;
  }

  // Mygtukas aktyvus tik kai Angular pasiruošęs
  btn.disabled = true;
  btn.title = 'Laukiama kol puslapis įsikraus...';
  waitForAngular(() => {
    btn.disabled = false;
    btn.title = '';
  });

  // ── Importas ────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = '⏳ Importuojama...';
    log.innerHTML = '';
    log.style.display = 'block';

    try {
      // 1. Gauti TIVIS duomenis iš Angular scope
      const scope = angular.element(document.querySelector('[ng-controller]')).scope();
      const tivisTasks = scope.items || scope.tasks || [];
      if (!tivisTasks.length) {
        appendLog('❌ TIVIS užduotys nerastos. Palaukite, kol puslapis pilnai įkraunamas.');
        btn.disabled = false; btn.innerHTML = '⬆ Importuoti į Propoint';
        return;
      }
      appendLog(`📂 Rasta ${tivisTasks.length} TIVIS užduočių`);

      // 2. Gauti Propoint vartotojus
      let ppUsers = [];
      try {
        ppUsers = await gmFetch('GET', `${PROPOINT}/api/users`);
        appendLog(`👥 Propoint vartotojai: ${ppUsers.length}`);
      } catch (e) {
        appendLog(`⚠️ Vartotojai nepasiekiami: ${e.message}`);
      }

      // 3. Gauti jau importuotus tivisId
      const existingIds = new Set();
      try {
        const existing = await gmFetch('GET', `${PROPOINT}/api/tasks`);
        for (const t of existing) if (t.tivisId) existingIds.add(String(t.tivisId));
        appendLog(`📋 Jau importuota: ${existingIds.size} užduočių`);
      } catch (e) {
        appendLog(`⚠️ Negalima patikrinti esamų: ${e.message}`);
      }

      // 4. Importuoti
      let imported = 0, skipped = 0, errors = 0;

      for (const t of tivisTasks) {
        const tivisId = String(t.id);
        if (existingIds.has(tivisId)) { skipped++; continue; }

        let assignedTo;
        if (t.supervisor && ppUsers.length) {
          const match = ppUsers.find(u =>
            u.name && u.name.trim().toLowerCase() === t.supervisor.trim().toLowerCase()
          );
          if (match) assignedTo = match.id;
        }

        const task = {
          id:            uid(),
          tivisId,
          tivisCode:     t.task_code || t.work_code || '',
          name:          t.object_name || `TIVIS ${tivisId}`,
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
            t.value && t.value !== '0.00' ? `Vertė: ${t.value}` : '',
          ].filter(Boolean).join('\n'),
          deadline:      t.deadline || '',
          priority:      'Vidutinis',
          status:        STATUS_MAP[t.status_code] || 'new',
          createdAt:     new Date().toISOString(),
          ...(assignedTo ? { assignedTo } : {}),
        };

        try {
          const r = await gmFetch('POST', `${PROPOINT}/api/tasks`, task);
          if (r._skip) {
            skipped++;
          } else {
            imported++;
            appendLog(`✅ ${task.name} <span style="color:#94a3b8">[${task.status}]</span>`);
          }
        } catch (e) {
          errors++;
          appendLog(`❌ ${task.name}: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 25));
      }

      appendLog(`<br>─────────────────────────`);
      appendLog(`✅ Importuota: <strong>${imported}</strong>`);
      appendLog(`⏭ Praleista:  <strong>${skipped}</strong>`);
      appendLog(`❌ Klaidos:   <strong>${errors}</strong>`);

    } catch (e) {
      appendLog(`💥 Kritinė klaida: ${e.message}`);
    }

    btn.disabled = false;
    btn.innerHTML = '⬆ Importuoti į Propoint';
  });

})();
