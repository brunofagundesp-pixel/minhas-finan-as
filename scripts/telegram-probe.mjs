#!/usr/bin/env node

import fs from 'node:fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const nodeMajor = Number((process.versions.node || '0').split('.')[0]);

if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  console.error('Node 18+ is required for telegram:probe (current: ' + process.versions.node + ').');
  process.exit(1);
}

const db = await initializeFirebaseAndGetDb();

async function main() {
  console.log('=== Telegram + Firestore probe ===');
  console.log('');

  await probeFirestoreUsers();
  console.log('');
  await probeTelegramUpdates();
}

async function probeFirestoreUsers() {
  console.log('[1] Firestore users/{uid}');
  try {
    const snap = await db.collection('users').limit(30).get();
    if (snap.empty) {
      console.log('  Nenhum documento em users/.');
      return;
    }

    for (const doc of snap.docs) {
      console.log(`  - ${doc.id}`);
    }

    console.log('  Dica: normalmente o UID correto e o que ja tem months/, cardLaunches/ etc.');
  } catch (err) {
    console.log(`  Falha ao ler Firestore: ${err?.message ?? err}`);
  }
}

async function probeTelegramUpdates() {
  console.log('[2] Telegram chat_id via getUpdates');
  if (!BOT_TOKEN) {
    console.log('  TELEGRAM_BOT_TOKEN nao definido. Pule esta etapa por enquanto.');
    return;
  }

  try {
    const updates = await telegramApi('getUpdates', {
      timeout: 1,
      limit: 20,
      allowed_updates: ['message']
    });

    if (!updates.length) {
      console.log('  Sem updates recentes. Envie uma mensagem para o bot e rode novamente.');
      return;
    }

    const seen = new Set();
    for (const upd of updates) {
      const msg = upd?.message;
      const chat = msg?.chat;
      if (!chat?.id) {
        continue;
      }

      const key = String(chat.id);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const label = [chat.type, chat.username ? `@${chat.username}` : '', chat.title || chat.first_name || ''].filter(Boolean).join(' | ');
      console.log(`  - chat_id=${chat.id} (${label})`);
    }
  } catch (err) {
    console.log(`  Falha ao consultar Telegram: ${err?.message ?? err}`);
  }
}

async function initializeFirebaseAndGetDb() {
  const firebaseAdminApp = await import('firebase-admin/app');
  const firebaseAdminFirestore = await import('firebase-admin/firestore');
  const { initializeApp, applicationDefault, cert } = firebaseAdminApp;
  const { getFirestore } = firebaseAdminFirestore;

  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
    const json = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    initializeApp({ credential: cert(json) });
  } else {
    initializeApp({ credential: applicationDefault() });
  }

  return getFirestore();
}

async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API HTTP ${response.status}: ${body}`);
  }

  const json = await response.json();
  if (!json.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(json)}`);
  }

  return json.result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
