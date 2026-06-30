#!/usr/bin/env node
/**
 * TIVIS → Propoint importas
 *
 * Naudojimas:
 *   1. Perkelkite tivis-tasks.json į šį aplanką (propoint/)
 *   2. node tivis-import.js
 *
 * tivis-tasks.json gaunamas:
 *   - Atidarykite https://tivis.eso.lt/task/index/list naršyklėje
 *   - Atidarykite DevTools Console ir paleiskite:
 *     const t=angular.element('[ng-controller]').scope().items;
 *     const b=new Blob([JSON.stringify(t.map(i=>({
 *       id:i.id,task_code:i.task_code,object_name:i.object_name,
 *       object_address:i.object_address,investment_nr:i.investment_nr,
 *       defect_nr:i.defect_nr,work_code:i.work_code,status:i.status,
 *       status_code:i.status_code,work_kind:i.work_kind,deadline:i.deadline,
 *       days_left:i.days_left,work_start:i.work_start,supervisor:i.supervisor,
 *       creator:i.creator,region:i.region,ward:i.ward,value:i.value
 *     })),null,2)],{type:'application/json'});
 *     const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(b),download:'tivis-tasks.json'});
 *     document.body.appendChild(a);a.click();a.remove();
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const PROPOINT_URL = 'http://10.2.1.115:3003';
const JSON_FILE    = path.join(__dirname, 'tivis-tasks.json');

// TIVIS status_code → Propoint status
const STATUS_MAP = {
  'SENT':       'new',          // Pateikta Rangovui
  'ASSIGNED':   'assigned',     // Priskirta
  'IN_WORK':    'in_progress',  // Vykdoma
  'COORD':      'coordination', // Derinimas
  'REVIEW':     'review',       // Tikrinimas
  'DONE':       'completed',    // Baigta
  'REJECTED':   'rejected',     // Atmesta
  'SUSPENDED':  'rejected',     // Sustabdyta → rejected
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, PROPOINT_URL);
    http.get(url.toString(), (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse error: ${data.slice(0,100)}`)); }
      });
    }).on('error', reject);
  });
}

async function apiPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(urlPath, PROPOINT_URL);
    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 3003,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 409) { resolve({ skip: true }); return; }
          if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${json.error || data}`)); return; }
          resolve(json);
        } catch(e) { reject(new Error(`Parse error: ${data.slice(0,100)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  // 1. Skaityti JSON failą
  if (!fs.existsSync(JSON_FILE)) {
    console.error(`❌ Nerasta: ${JSON_FILE}`);
    console.error('   Perkelkite tivis-tasks.json į propoint/ aplanką.');
    process.exit(1);
  }
  const rawTasks = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  console.log(`📂 Nuskaitytos ${rawTasks.length} TIVIS užduotys\n`);

  // 2. Gauti esamus Propoint vartotojus (vardų atitikimui)
  let ppUsers = [];
  try {
    ppUsers = await apiGet('/api/users');
    console.log(`👥 Propoint vartotojai: ${ppUsers.length}`);
  } catch(e) {
    console.warn(`⚠️  Negalima gauti vartotojų: ${e.message}`);
  }

  // 3. Gauti jau importuotas užduotis (deduplication)
  let existingTivisIds = new Set();
  try {
    const res = await apiGet('/api/tasks');
    for (const t of res) {
      if (t.tivisId) existingTivisIds.add(String(t.tivisId));
    }
    console.log(`📋 Jau importuota TIVIS užduočių: ${existingTivisIds.size}\n`);
  } catch(e) {
    console.warn(`⚠️  Negalima patikrinti esamų užduočių: ${e.message}\n`);
  }

  // 4. Importuoti
  let imported = 0, skipped = 0, errors = 0;

  for (const t of rawTasks) {
    const tivisId = String(t.id);

    // Praleisti jau importuotas
    if (existingTivisIds.has(tivisId)) {
      skipped++;
      continue;
    }

    // Rasti atitinkamą Propoint vartotoją pagal vardą
    let assignedTo = undefined;
    if (t.supervisor && ppUsers.length) {
      const match = ppUsers.find(u =>
        u.name && u.name.trim().toLowerCase() === t.supervisor.trim().toLowerCase()
      );
      if (match) assignedTo = match.id;
    }

    const status = STATUS_MAP[t.status_code] || 'new';

    const task = {
      id:            uid(),
      tivisId:       tivisId,
      tivisCode:     t.task_code || t.work_code || '',
      name:          t.object_name || `TIVIS ${tivisId}`,
      projectNumber: t.investment_nr || '',
      address:       t.object_address || '',
      client:        'ESO',
      type:          t.work_kind || '',
      description:   [
        t.work_kind   ? `Darbų rūšis: ${t.work_kind}`     : '',
        t.supervisor  ? `Vadovas: ${t.supervisor}`         : '',
        t.defect_nr   ? `Defekto nr.: ${t.defect_nr}`      : '',
        t.region      ? `Rajonas: ${t.region}`             : '',
        t.ward        ? `Seniūnija: ${t.ward}`             : '',
        t.value && t.value !== '0.00' ? `Vertė: ${t.value}` : '',
      ].filter(Boolean).join('\n'),
      deadline:      t.deadline || '',
      priority:      'Vidutinis',
      status:        status,
      createdAt:     new Date().toISOString(),
      ...(assignedTo ? { assignedTo } : {}),
    };

    try {
      const r = await apiPost('/api/tasks', task);
      if (r.skip) {
        skipped++;
        console.log(`  ⏭  Praleista (duplikatas): ${task.name}`);
      } else {
        imported++;
        console.log(`  ✅ [${imported}] ${task.name} — ${status}${assignedTo ? ` → ${t.supervisor}` : ''}`);
      }
    } catch(e) {
      errors++;
      console.error(`  ❌ Klaida: ${task.name}: ${e.message}`);
    }

    // Nedidelė pauzė, kad serveris neperkrautų
    await new Promise(r => setTimeout(r, 30));
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Importuota:  ${imported}`);
  console.log(`⏭  Praleista:   ${skipped}`);
  console.log(`❌ Klaidos:     ${errors}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch(e => { console.error('Kritinė klaida:', e); process.exit(1); });
