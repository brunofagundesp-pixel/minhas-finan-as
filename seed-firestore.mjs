// Script de seed: migra db.json para o Firestore
// Executar com: node seed-firestore.mjs

import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, collection, addDoc } from 'firebase/firestore';
import { readFileSync } from 'fs';

const firebaseConfig = {
  apiKey: 'AIzaSyCp-DVWCcRwJvCQwb0i0xuyMTl1geKDDYA',
  authDomain: 'minhas-financas-75277.firebaseapp.com',
  projectId: 'minhas-financas-75277',
  storageBucket: 'minhas-financas-75277.firebasestorage.app',
  messagingSenderId: '694437607652',
  appId: '1:694437607652:web:87eba7e0fa1408ca8654f1',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const raw = readFileSync('./db.json', 'utf8');
const data = JSON.parse(raw);

async function seed() {
  // --- months ---
  console.log(`Enviando ${data.months.length} meses...`);
  for (const month of data.months) {
    await setDoc(doc(db, 'months', month.id), month);
    console.log(`  ✓ months/${month.id}`);
  }

  // --- cards ---
  if (data.cards && data.cards.length > 0) {
    console.log(`\nEnviando ${data.cards.length} cartões...`);
    for (const card of data.cards) {
      const { id, ...cardData } = card;
      const ref = await addDoc(collection(db, 'cards'), cardData);
      console.log(`  ✓ cards/${ref.id} (${card.name})`);
    }
  } else {
    console.log('\nNenhum cartão em db.json, pulando...');
  }

  // --- cardLaunches ---
  if (data.cardLaunches && data.cardLaunches.length > 0) {
    console.log(`\nEnviando ${data.cardLaunches.length} lançamentos de cartão...`);
    for (const launch of data.cardLaunches) {
      const { id, ...launchData } = launch;
      const ref = await addDoc(collection(db, 'cardLaunches'), launchData);
      console.log(`  ✓ cardLaunches/${ref.id}`);
    }
  } else {
    console.log('\nNenhum lançamento de cartão em db.json, pulando...');
  }

  console.log('\nSeed concluído!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Erro no seed:', err);
  process.exit(1);
});
