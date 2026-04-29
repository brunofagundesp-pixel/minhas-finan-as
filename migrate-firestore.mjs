/**
 * Script de migração: move dados da coleção raiz para users/{uid}/...
 *
 * Uso:
 *   1. Baixe uma chave de serviço no Firebase Console:
 *      Configurações do projeto -> Contas de serviço -> Gerar nova chave privada
 *      Salve fora do repositório (ex.: C:\secrets\firebase-admin.json)
 *
 *   2. Defina a variável de ambiente GOOGLE_APPLICATION_CREDENTIALS apontando
 *      para esse arquivo.
 *
 *   3. Descubra seu UID no Firebase Console:
 *      Authentication → Users → copie o User UID
 *
 *   4. Execute:
 *      node migrate-firestore.mjs <SEU_UID>
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const uid = process.argv[2];
if (!uid) {
  console.error('❌  Informe o UID: node migrate-firestore.mjs <SEU_UID>');
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
  console.error('❌  Não foi possível ler a chave de serviço no caminho informado em GOOGLE_APPLICATION_CREDENTIALS.');
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const COLLECTIONS = ['months', 'cards', 'cardLaunches'];

async function migrateCollection(collectionName) {
  const srcRef = db.collection(collectionName);
  const snapshot = await srcRef.get();

  if (snapshot.empty) {
    console.log(`  ⚠️  ${collectionName}: nenhum documento encontrado, pulando.`);
    return;
  }

  const destRef = db.collection(`users/${uid}/${collectionName}`);
  const batch = db.batch();
  let count = 0;

  for (const doc of snapshot.docs) {
    batch.set(destRef.doc(doc.id), doc.data());
    count++;
  }

  await batch.commit();
  console.log(`  ✅  ${collectionName}: ${count} documento(s) migrado(s).`);
}

console.log(`\n🚀  Iniciando migração para users/${uid}/...\n`);

for (const col of COLLECTIONS) {
  await migrateCollection(col);
}

console.log('\n✅  Migração concluída! Verifique os dados no Firebase Console antes de deletar as coleções antigas.');
console.log('    Para deletar as coleções antigas, acesse o Firestore Console e exclua manualmente.\n');
