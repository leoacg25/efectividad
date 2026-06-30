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

const doc = await db.collection('dashboard').doc('data').get();
if (!doc.exists) {
  console.error('Firestore document dashboard/data does not exist');
  process.exit(1);
}

const data = { ...doc.data(), backedUpAt: new Date().toISOString() };

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
