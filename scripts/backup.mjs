import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT env var is required');
  process.exit(1);
}

const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function decodeName(id) {
  try {
    return decodeURIComponent(id);
  } catch (e) {
    return id;
  }
}

// Esquema v2: colección "programmers" + documento "dashboard/meta" + "dashboard/posweb"
const progSnap = await db.collection('programmers').get();
const metaSnap = await db.collection('dashboard').doc('meta').get();
const poswebSnap = await db.collection('dashboard').doc('posweb').get();

let data;
if (progSnap.size > 0 || metaSnap.exists || poswebSnap.exists) {
  const programmers = {};
  const profiles = {};
  progSnap.forEach(doc => {
    const name = decodeName(doc.id);
    const docData = doc.data();
    programmers[name] = Array.isArray(docData.tickets) ? docData.tickets : [];
    profiles[name] = docData.profile || 'desarrollador';
  });
  const meta = metaSnap.exists ? metaSnap.data() : {};
  const posweb = poswebSnap.exists ? poswebSnap.data() : null;
  data = {
    programmers,
    profiles,
    periodName: meta.periodName || '',
    loadedAt: meta.loadedAt || null,
    archives: Array.isArray(meta.archives) ? meta.archives : [],
    planifications: Array.isArray(meta.planifications) ? meta.planifications : [],
    posweb: posweb && typeof posweb === 'object' ? {
      programmer: posweb.programmer || '',
      cases: Array.isArray(posweb.cases) ? posweb.cases : [],
    } : null,
  };
} else {
  // Esquema v1 (documento único dashboard/data) — compatibilidad
  const doc = await db.collection('dashboard').doc('data').get();
  if (!doc.exists) {
    console.error('No se encontraron datos en Firestore (ni v2 ni v1)');
    process.exit(1);
  }
  data = { ...doc.data() };
}

data.backedUpAt = new Date().toISOString();

const backupDir = resolve(process.env.BACKUP_DIR || 'backups');
if (!existsSync(backupDir)) {
  mkdirSync(backupDir, { recursive: true });
}

const today = new Date().toISOString().slice(0, 10);
const filename = join(backupDir, `efectividad_${today}.json`);

writeFileSync(filename, JSON.stringify(data, null, 2));
console.log(`Backup saved: ${filename}`);

const files = readdirSync(backupDir)
  .filter(f => /^efectividad_\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();

if (files.length >= 7) {
  const toDelete = files.slice(0, -1);
  for (const f of toDelete) {
    unlinkSync(join(backupDir, f));
    console.log(`Deleted old backup: ${f}`);
  }
  console.log(`Rotation: kept 1 (${files[files.length - 1]}), deleted ${toDelete.length} old backups`);
} else {
  console.log(`No rotation needed (${files.length}/7 backups)`);
}
