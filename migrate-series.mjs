/**
 * Script de migração: extrai séries fixas/parceladas dos meses para a nova
 * coleção `series` e limpa eventos duplicados dos meses.
 *
 * Uso:
 *   1. Baixe uma chave de serviço no Firebase Console:
 *      Configurações do projeto -> Contas de serviço -> Gerar nova chave privada
 *      Salve fora do repositório (ex.: C:\secrets\firebase-admin.json)
 *
 *   2. Defina a variável de ambiente GOOGLE_APPLICATION_CREDENTIALS
 *      apontando para esse arquivo.
 *
 *   3. Execute para um usuário específico:
 *      node migrate-series.mjs <UID>
 *
 *      Ou para TODOS os usuários:
 *      node migrate-series.mjs --all
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'fs';

const target = process.argv[2];
if (!target) {
  console.error('❌  Use: node migrate-series.mjs <UID>    (usuário único)');
  console.error('       node migrate-series.mjs --all     (todos os usuários)');
  process.exit(1);
}

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!serviceAccountPath) {
  console.error('❌  Defina GOOGLE_APPLICATION_CREDENTIALS com o caminho da chave de serviço.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
} catch {
  console.error('❌  Não foi possível ler a chave de serviço.');
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

if (target === '--all') {
  migrateAllUsers().catch((err) => {
    console.error('❌  Erro durante a migração global:', err);
    process.exit(1);
  });
} else {
  migrateUser(target).catch((err) => {
    console.error(`❌  Erro durante a migração de ${target}:`, err);
    process.exit(1);
  });
}

async function migrateAllUsers() {
  console.log('\n🌍  Migrando todos os usuários...\n');
  let nextPageToken;
  let total = 0;
  let errors = 0;

  do {
    const result = await getAuth().listUsers(1000, nextPageToken);

    for (const userRecord of result.users) {
      process.stdout.write(`👤  ${userRecord.email ?? userRecord.uid}... `);
      try {
        const { seriesCreated, monthsUpdated } = await migrateUser(userRecord.uid);
        console.log(`✅  ${seriesCreated} série(s), ${monthsUpdated} mês(es)`);
      } catch (err) {
        console.log(`❌  ${err.message}`);
        errors++;
      }
      total++;
    }

    nextPageToken = result.pageToken;
  } while (nextPageToken);

  console.log(`\n✅  Migração global concluída! ${total} usuário(s) processado(s), ${errors} erro(s).`);
}

async function migrateUser(uid) {
  const monthsRef = db.collection(`users/${uid}/months`);
  const seriesRef = db.collection(`users/${uid}/series`);

  const snapshot = await monthsRef.get();
  if (snapshot.empty) {
    return { seriesCreated: 0, monthsUpdated: 0 };
  }

  // 1. Extrair todas as séries únicas dos meses
  const seriesMap = new Map();
  const monthDocs = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    monthDocs.push({ id: doc.id, ...data });

    const events = data.events ?? [];
    for (const ev of events) {
      if (!ev.seriesId) continue;
      if (ev.recurrenceKind === 'single') continue;
      seriesMap.set(ev.seriesId, ev);
    }
  }

  // 2. Criar documentos na coleção series
  let seriesCreated = 0;
  const batch = db.batch();

  for (const [seriesId, template] of seriesMap) {
    const startKey = findEarliestMonth(monthDocs, seriesId);
    const seriesDoc = {
      id: seriesId,
      label: template.label ?? '',
      amount: template.amount ?? 0,
      type: template.type ?? 'expense',
      day: template.day ?? 1,
      repeatMode: template.repeatMode ?? 'monthly',
      recurrenceKind: template.recurrenceKind ?? 'fixed',
      seriesOccurrences: template.seriesOccurrences ?? null,
      tags: template.tags ?? [],
      isActive: true,
      createdInMonthKey: startKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    batch.set(seriesRef.doc(seriesId), seriesDoc);
    seriesCreated++;
  }

  await batch.commit();

  // 3. Limpar eventos de série dos meses e extrair overrides
  let monthsUpdated = 0;
  const updateBatch = db.batch();
  let batchOps = 0;

  for (const month of monthDocs) {
    const originalLength = month.events?.length ?? 0;

    const singleEvents = (month.events ?? []).filter(
      (ev) => !ev.seriesId || ev.recurrenceKind === 'single'
    );
    const seriesEvents = (month.events ?? []).filter(
      (ev) => ev.seriesId && ev.recurrenceKind !== 'single'
    );

    const overrides = [];
    for (const se of seriesEvents) {
      const template = seriesMap.get(se.seriesId);
      if (!template) continue;

      const hasOverride =
        se.paid ||
        se.paidAt ||
        (se.amount !== undefined && template.amount !== undefined && Math.abs(se.amount - template.amount) > 0.001) ||
        (se.label !== undefined && se.label !== template.label) ||
        se.suppressed ||
        se.dailyOccurrenceAction;

      if (hasOverride) {
        overrides.push({
          seriesId: se.seriesId,
          day: se.day,
          ...(se.paid !== undefined && { paid: se.paid }),
          ...(se.paidAt !== undefined && { paidAt: se.paidAt }),
          ...(se.amount !== undefined && template.amount !== undefined && Math.abs(se.amount - template.amount) > 0.001 && { amount: se.amount }),
          ...(se.label !== undefined && se.label !== template.label && { label: se.label }),
          ...(se.suppressed || se.dailyOccurrenceAction === 'skip' ? { action: 'skip' } : {}),
        });
      }
    }

    const changed = singleEvents.length !== originalLength || overrides.length > 0;

    if (changed) {
      const updateData = { events: singleEvents };
      if (overrides.length > 0) {
        updateData.seriesOverrides = overrides;
      }

      updateBatch.update(monthsRef.doc(month.id), updateData);
      batchOps++;
      monthsUpdated++;

      if (batchOps >= 400) {
        await updateBatch.commit();
        batchOps = 0;
      }
    }
  }

  if (batchOps > 0) {
    await updateBatch.commit();
  }

  return { seriesCreated, monthsUpdated };
}

function findEarliestMonth(months, seriesId) {
  let earliest = null;
  for (const m of months) {
    const hasSeries = (m.events ?? []).some((ev) => ev.seriesId === seriesId);
    if (hasSeries) {
      const key = m.key ?? `${m.year}-${String(m.monthNumber).padStart(2, '0')}`;
      if (!earliest || key < earliest) {
        earliest = key;
      }
    }
  }
  return earliest ?? `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
}
