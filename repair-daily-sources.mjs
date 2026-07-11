/**
 * Auditor/reparo de diárias fantasma.
 *
 * Por padrão, só lista fontes de diária que ainda impactam a projeção:
 *   - eventos `type: daily` salvos em users/{uid}/months
 *   - séries `type: daily` ativas em users/{uid}/series
 *   - campo legado `dailyFixedCost`
 *
 * Uso seguro:
 *   node repair-daily-sources.mjs <UID>
 *   node repair-daily-sources.mjs --all
 *
 * Remover todas as diárias encontradas:
 *   node repair-daily-sources.mjs <UID> --write
 *   node repair-daily-sources.mjs --all --write
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const target = process.argv[2];
const shouldWrite = process.argv.includes('--write');

if (!target || target === '--write') {
  console.error('Use: node repair-daily-sources.mjs <UID|--all> [--write]');
  process.exit(1);
}

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!serviceAccountPath) {
  console.error('Defina GOOGLE_APPLICATION_CREDENTIALS com o caminho da chave de serviço.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
} catch {
  console.error('Não foi possível ler a chave de serviço.');
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

if (target === '--all') {
  repairAllUsers().catch((err) => {
    console.error('Erro no reparo global:', err);
    process.exit(1);
  });
} else {
  repairTarget(target).catch((err) => {
    console.error(`Erro no reparo de ${target}:`, err);
    process.exit(1);
  });
}

async function repairTarget(targetValue) {
  if (!targetValue.includes('@')) {
    return repairUser(targetValue);
  }

  const userRecord = await getAuth().getUserByEmail(targetValue);
  return repairUser(userRecord.uid, userRecord.email ?? userRecord.uid);
}

async function repairAllUsers() {
  let nextPageToken;
  let totalUsers = 0;
  let totalMonths = 0;
  let totalDailyEvents = 0;
  let totalSeries = 0;

  do {
    const result = await getAuth().listUsers(1000, nextPageToken);

    for (const userRecord of result.users) {
      const resultForUser = await repairUser(userRecord.uid, userRecord.email ?? userRecord.uid);
      totalUsers += 1;
      totalMonths += resultForUser.months;
      totalDailyEvents += resultForUser.dailyEvents;
      totalSeries += resultForUser.series;
    }

    nextPageToken = result.pageToken;
  } while (nextPageToken);

  console.log(`\nConcluído: ${totalUsers} usuário(s), ${totalMonths} mês(es), ${totalDailyEvents} evento(s) diário(s), ${totalSeries} série(s) diária(s).`);
}

async function repairUser(uid, label = uid) {
  const monthsRef = db.collection(`users/${uid}/months`);
  const seriesRef = db.collection(`users/${uid}/series`);
  const [monthsSnapshot, seriesSnapshot] = await Promise.all([monthsRef.get(), seriesRef.get()]);

  const affectedMonths = [];
  let dailyEvents = 0;

  for (const doc of monthsSnapshot.docs) {
    const data = doc.data();
    const events = Array.isArray(data.events) ? data.events : [];
    const monthDailyEvents = events.filter((event) => event?.type === 'daily');
    const legacyDailyFixedCost = Number(data.dailyFixedCost ?? 0);

    if (monthDailyEvents.length || legacyDailyFixedCost !== 0) {
      dailyEvents += monthDailyEvents.length;
      affectedMonths.push({ doc, data, monthDailyEvents, legacyDailyFixedCost });
    }
  }

  const dailySeriesDocs = seriesSnapshot.docs
    .map((doc) => ({ doc, data: doc.data() }))
    .filter(({ data }) => data.type === 'daily' && data.isActive !== false);

  if (!affectedMonths.length && !dailySeriesDocs.length) {
    console.log(`${label}: nenhuma fonte de diária encontrada.`);
    return { months: 0, dailyEvents: 0, series: 0 };
  }

  console.log(`${label}:`);
  for (const item of affectedMonths) {
    const amount = item.monthDailyEvents.reduce((sum, event) => sum + Number(event.amount ?? 0), 0);
    console.log(`  mês ${item.doc.id}: ${item.monthDailyEvents.length} evento(s) daily, soma ${amount}, dailyFixedCost ${item.legacyDailyFixedCost}`);
  }
  for (const { doc, data } of dailySeriesDocs) {
    console.log(`  série daily ${doc.id}: amount ${data.amount ?? 0}, ativa ${data.isActive !== false}`);
  }

  if (!shouldWrite) {
    console.log('  Dry-run: nada foi alterado. Rode com --write para remover essas diárias.');
    return { months: affectedMonths.length, dailyEvents, series: dailySeriesDocs.length };
  }

  let batch = db.batch();
  let ops = 0;

  for (const item of affectedMonths) {
    const nextEvents = (Array.isArray(item.data.events) ? item.data.events : []).filter((event) => event?.type !== 'daily');
    batch.update(item.doc.ref, {
      events: nextEvents,
      dailyFixedCost: 0,
    });
    ops += 1;

    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  for (const { doc } of dailySeriesDocs) {
    batch.update(doc.ref, {
      isActive: false,
      updatedAt: new Date().toISOString(),
    });
    ops += 1;

    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
  }

  console.log(`  Corrigido: ${affectedMonths.length} mês(es), ${dailyEvents} evento(s), ${dailySeriesDocs.length} série(s).`);
  return { months: affectedMonths.length, dailyEvents, series: dailySeriesDocs.length };
}