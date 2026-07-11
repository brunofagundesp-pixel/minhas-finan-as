/**
 * Reparo: zera o campo legado `dailyFixedCost` dos meses do usuário.
 *
 * Esse campo era usado antes da diária virar lançamento/evento. Se ele fica
 * salvo no Firestore, pode aparecer como diária fixa sem existir lançamento.
 *
 * Uso seguro, só mostra o que seria alterado:
 *   node repair-daily-fixed-cost.mjs <UID>
 *   node repair-daily-fixed-cost.mjs --all
 *
 * Aplicar o reparo:
 *   node repair-daily-fixed-cost.mjs <UID> --write
 *   node repair-daily-fixed-cost.mjs --all --write
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const target = process.argv[2];
const shouldWrite = process.argv.includes('--write');

if (!target || target === '--write') {
  console.error('Use: node repair-daily-fixed-cost.mjs <UID|--all> [--write]');
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
  repairUser(target).catch((err) => {
    console.error(`Erro no reparo de ${target}:`, err);
    process.exit(1);
  });
}

async function repairAllUsers() {
  let nextPageToken;
  let totalUsers = 0;
  let totalMonths = 0;

  do {
    const result = await getAuth().listUsers(1000, nextPageToken);

    for (const userRecord of result.users) {
      const repaired = await repairUser(userRecord.uid, userRecord.email ?? userRecord.uid);
      totalUsers += 1;
      totalMonths += repaired;
    }

    nextPageToken = result.pageToken;
  } while (nextPageToken);

  console.log(`\nConcluído: ${totalUsers} usuário(s), ${totalMonths} mês(es) ${shouldWrite ? 'corrigido(s)' : 'encontrado(s)'}.`);
}

async function repairUser(uid, label = uid) {
  const monthsRef = db.collection(`users/${uid}/months`);
  const snapshot = await monthsRef.get();

  if (snapshot.empty) {
    console.log(`${label}: nenhum mês encontrado.`);
    return 0;
  }

  const affected = snapshot.docs
    .map((doc) => ({ doc, data: doc.data() }))
    .filter(({ data }) => Number(data.dailyFixedCost ?? 0) !== 0);

  if (!affected.length) {
    console.log(`${label}: nenhum dailyFixedCost legado encontrado.`);
    return 0;
  }

  console.log(`${label}: ${affected.length} mês(es) com dailyFixedCost legado:`);
  for (const { doc, data } of affected) {
    console.log(`  - ${doc.id}: ${data.dailyFixedCost}`);
  }

  if (!shouldWrite) {
    console.log('  Dry-run: nada foi alterado. Rode com --write para zerar.');
    return affected.length;
  }

  let batch = db.batch();
  let ops = 0;

  for (const { doc } of affected) {
    batch.update(doc.ref, { dailyFixedCost: 0 });
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

  console.log(`  Corrigido: ${affected.length} mês(es) zerado(s).`);
  return affected.length;
}