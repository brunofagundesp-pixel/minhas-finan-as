/**
 * Script de migração: move dados da coleção raiz para users/{uid}/...
 *
 * Uso:
 *   1. Baixe a chave de serviço no Firebase Console:
 *      Configurações do projeto → Contas de serviço → Gerar nova chave privada
 *      Salve o arquivo como service-account.json na raiz do projeto
 *
 *   2. Descubra seu UID no Firebase Console:
 *      Authentication → Users → copie o User UID
 *
 *   3. Execute:
 *      node migrate-firestore.mjs <SEU_UID>
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const uid = process.argv[2];
if (!uid) {
  console.error('❌  Informe o UID: node migrate-firestore.mjs <SEU_UID>');
  process.exit(1);
}

const serviceAccountPath = resolve(__dirname, 'service-account.json');
let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
} catch {
  console.error('❌  Arquivo service-account.json não encontrado na raiz do projeto.');
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
