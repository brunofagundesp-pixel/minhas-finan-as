#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_FIREBASE_UID = process.env.PREVISA_FIREBASE_UID || '';
const ALLOWED_CHAT_ID = process.env.PREVISA_TELEGRAM_CHAT_ID;
const POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 30);

const TELEGRAM_LINKS_COLLECTION = 'telegramLinks';

// In some Windows/network setups, Node may prefer IPv6 and cause intermittent
// fetch failures to Telegram endpoints. Favor IPv4 for more stable polling.
dns.setDefaultResultOrder('ipv4first');

const nodeMajor = Number((process.versions.node || '0').split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  console.error('Node 18+ is required for Telegram bot scripts (current: ' + process.versions.node + ').');
  process.exit(1);
}

if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}

const monthNames = [
  'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const { db, FieldValueRef, authRef } = await initializeFirebaseAndGetDb();
const launchWizards = new Map();

let offset = 0;
let stopping = false;

console.log('Telegram bot is running (long polling).');
if (DEFAULT_FIREBASE_UID) {
  console.log(`Mode: fixed UID (${DEFAULT_FIREBASE_UID})`);
} else {
  console.log('Mode: multi-user via /entrar <email>.');
}
if (ALLOWED_CHAT_ID) {
  console.log(`Allowed chat id: ${ALLOWED_CHAT_ID}`);
} else {
  console.log('Allowed chat id not set. Any chat can send commands.');
}

process.on('SIGINT', () => {
  stopping = true;
  console.log('\nStopping bot...');
});

process.on('SIGTERM', () => {
  stopping = true;
  console.log('\nStopping bot...');
});

while (!stopping) {
  try {
    const updates = await telegramApi('getUpdates', {
      offset,
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: ['message']
    });

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (err) {
    console.error('[polling] error:', err?.message ?? err);
    await sleep(500);
  }
}

async function handleUpdate(update) {
  const message = update?.message;
  if (!message?.text || !message?.chat?.id) {
    return;
  }

  const chatId = String(message.chat.id);

  if (ALLOWED_CHAT_ID && chatId !== String(ALLOWED_CHAT_ID)) {
    await sendMessage(chatId, 'Este bot esta bloqueado para este chat.');
    return;
  }

  const text = String(message.text || '').trim();
  if (!text) {
    return;
  }

  if (text === '/start' || text === '/help' || text === '/ajuda') {
    await sendMessage(chatId, buildHelpText());
    return;
  }

  if (text.startsWith('/entrar ') || text.startsWith('/login ')) {
    const email = normalizeSpaces(text.replace(/^\/(entrar|login)\s+/i, ''));
    await handleLoginCommand(chatId, email);
    return;
  }

  if (text === '/sair' || text === '/logout') {
    await handleLogoutCommand(chatId);
    return;
  }

  if (text === '/quemsou' || text === '/status') {
    await handleStatusCommand(chatId);
    return;
  }

  const link = await resolveChatLink(chatId);
  if (!link?.uid) {
    await sendMessage(
      chatId,
      'Este chat ainda nao esta vinculado. Use /entrar seu-email@dominio.com.'
    );
    return;
  }

  if (text === '/lancar' || text === '/novo') {
    startLaunchWizard(chatId);
    await sendMessage(chatId, wizardPromptForType());
    return;
  }

  if (text === '/cancelar') {
    if (launchWizards.delete(chatId)) {
      await sendMessage(chatId, 'Lancamento guiado cancelado.');
    } else {
      await sendMessage(chatId, 'Nao ha lancamento guiado em andamento.');
    }
    return;
  }

  if (launchWizards.has(chatId) && !text.startsWith('/')) {
    await handleLaunchWizardStep(chatId, link.uid, text);
    return;
  }

  const parsed = parseCommand(text);
  if (!parsed.ok) {
    await sendMessage(chatId, buildInvalidCommandHelp(parsed.error));
    return;
  }

  try {
    const saved = await saveLaunch(link.uid, parsed.value);
    await sendMessage(chatId, `Lancamento salvo: ${saved.summary}`);
  } catch (err) {
    console.error('[saveLaunch] error:', err?.message ?? err);
    await sendMessage(chatId, 'Nao consegui salvar no Firestore. Verifique credenciais e vinculo do chat.');
  }
}

async function handleLoginCommand(chatId, emailRaw) {
  if (DEFAULT_FIREBASE_UID) {
    await sendMessage(chatId, 'Este bot esta em modo UID fixo. Ignore /entrar e envie os lancamentos direto.');
    return;
  }

  const email = normalizeEmail(emailRaw);
  if (!email || !isValidEmail(email)) {
    await sendMessage(chatId, 'Email invalido. Use: /entrar seu-email@dominio.com');
    return;
  }

  try {
    const user = await authRef.getUserByEmail(email);

    await db.doc(`${TELEGRAM_LINKS_COLLECTION}/${chatId}`).set({
      chatId,
      uid: user.uid,
      email: user.email || email,
      updatedAt: FieldValueRef.serverTimestamp()
    }, { merge: true });

    await sendMessage(chatId, `Chat vinculado com sucesso a ${user.email || email}.`);
  } catch (err) {
    const message = String(err?.message || err || '');
    if (message.includes('There is no user record') || message.includes('user-not-found')) {
      await sendMessage(chatId, 'Email nao encontrado no Firebase Auth.');
      return;
    }

    console.error('[handleLoginCommand] error:', err?.message ?? err);
    await sendMessage(chatId, 'Falha ao vincular o e-mail. Tente novamente em instantes.');
  }
}

async function handleLogoutCommand(chatId) {
  if (DEFAULT_FIREBASE_UID) {
    await sendMessage(chatId, 'Modo UID fixo ativo. /sair nao se aplica neste modo.');
    return;
  }

  await db.doc(`${TELEGRAM_LINKS_COLLECTION}/${chatId}`).delete();
  await sendMessage(chatId, 'Vinculo removido. Use /entrar email para vincular novamente.');
}

async function handleStatusCommand(chatId) {
  const link = await resolveChatLink(chatId);
  if (!link?.uid) {
    await sendMessage(chatId, 'Sem vinculo ativo. Use /entrar seu-email@dominio.com');
    return;
  }

  const modeLabel = link.mode === 'fixed' ? 'uid-fixo' : 'email-vinculado';
  const emailLabel = link.email ? `\nEmail: ${link.email}` : '';
  await sendMessage(chatId, `Vinculo ativo (${modeLabel}).\nUID: ${link.uid}${emailLabel}`);
}

async function resolveChatLink(chatId) {
  if (DEFAULT_FIREBASE_UID) {
    return { uid: DEFAULT_FIREBASE_UID, mode: 'fixed', email: null };
  }

  const snap = await db.doc(`${TELEGRAM_LINKS_COLLECTION}/${chatId}`).get();
  if (!snap.exists) {
    return null;
  }

  const data = snap.data() || {};
  const uid = typeof data.uid === 'string' ? data.uid.trim() : '';
  if (!uid) {
    return null;
  }

  return {
    uid,
    email: typeof data.email === 'string' ? data.email : null,
    mode: 'linked'
  };
}

function startLaunchWizard(chatId) {
  launchWizards.set(chatId, {
    step: 'type',
    data: {
      type: null,
      amount: null,
      label: '',
      date: '',
      tags: [],
      cardNameHint: '',
      installments: 1
    }
  });
}

async function handleLaunchWizardStep(chatId, uid, text) {
  const wizard = launchWizards.get(chatId);
  if (!wizard) {
    await sendMessage(chatId, 'Nao encontrei o fluxo guiado. Envie /lancar para iniciar.');
    return;
  }

  const value = normalizeSpaces(text);
  const lower = normalizeWord(value);

  if (wizard.step === 'type') {
    const type = mapWizardType(lower);
    if (!type) {
      await sendMessage(chatId, 'Tipo invalido.\n\n' + wizardPromptForType());
      return;
    }

    wizard.data.type = type;
    wizard.step = 'amount';
    await sendMessage(chatId, 'Valor (ex: 39,90):');
    return;
  }

  if (wizard.step === 'amount') {
    const amount = parseAmount(value);
    if (!amount || amount <= 0) {
      await sendMessage(chatId, 'Valor invalido. Envie algo como 39,90');
      return;
    }

    wizard.data.amount = amount;
    wizard.step = 'label';
    await sendMessage(chatId, 'Descricao do lancamento (ex: mercado semana). Se nao quiser, envie "sem" ou "pular" (tambem aceitamos "-").');
    return;
  }

  if (wizard.step === 'label') {
    wizard.data.label = isSkipInput(value) ? 'Sem descricao' : value;
    wizard.step = 'date';
    await sendMessage(chatId, 'Data (padrao BR: dd-mm-aaaa, ex: 02-06-2026). Tambem aceita dd/mm/aaaa, hoje e ontem. Para usar hoje, envie "sem" ou "pular" (ou "-").');
    return;
  }

  if (wizard.step === 'date') {
    const parsedDate = isSkipInput(value) ? todayDate() : parseDate(value);
    if (!parsedDate) {
      await sendMessage(chatId, 'Data invalida. Exemplos: 02-06-2026, 02/06/2026, hoje, ontem.');
      return;
    }

    wizard.data.date = parsedDate;
    wizard.step = 'tags';
    await sendMessage(chatId, 'Tags opcionais (ex: #alimentacao #mercado). Envie - para sem tags.');
    return;
  }

  if (wizard.step === 'tags') {
    wizard.data.tags = parseWizardTags(value);

    if (wizard.data.type !== 'card-expense') {
      await finalizeWizardAndSave(chatId, uid, wizard.data);
      return;
    }

    wizard.step = 'card';
    await sendMessage(chatId, 'Nome do cartao (ex: nubank). Envie - para auto-selecao.');
    return;
  }

  if (wizard.step === 'card') {
    wizard.data.cardNameHint = isSkipInput(value) ? '' : value.replace(/^@?cartao[:=]/i, '').trim();
    wizard.step = 'installments';
    await sendMessage(chatId, 'Parcelas (1 a 36). Ex: 1, 10, 10x ou @parcelas=10. Para 1 parcela, pode enviar "sem" ou "pular".');
    return;
  }

  if (wizard.step === 'installments') {
    const installments = parseInstallmentsInput(value);
    if (!installments) {
      await sendMessage(chatId, 'Parcelas invalidas. Use um numero entre 1 e 36.');
      return;
    }

    wizard.data.installments = installments;
    await finalizeWizardAndSave(chatId, uid, wizard.data);
  }
}

async function finalizeWizardAndSave(chatId, uid, data) {
  try {
    const saved = await saveLaunch(uid, data);
    await sendMessage(chatId, `Lancamento salvo: ${saved.summary}`);
    launchWizards.delete(chatId);
  } catch (err) {
    console.error('[wizardSave] error:', err?.message ?? err);
    await sendMessage(chatId, `Nao consegui salvar: ${String(err?.message || err || 'erro desconhecido')}`);
  }
}

function wizardPromptForType() {
  return [
    'Vamos lancar passo a passo.',
    'Escolha o tipo:',
    '1) despesa',
    '2) receita',
    '3) investimento',
    '4) diario',
    '5) cartao',
    '',
    'Envie o numero ou o nome do tipo. (/cancelar para sair)'
  ].join('\n');
}

function mapWizardType(value) {
  if (['1', 'despesa', 'gasto', 'saida', 'expense'].includes(value)) return 'expense';
  if (['2', 'receita', 'entrada', 'income'].includes(value)) return 'income';
  if (['3', 'investimento', 'investir', 'aporte'].includes(value)) return 'investment';
  if (['4', 'diario', 'daily'].includes(value)) return 'daily';
  if (['5', 'cartao', 'card', 'credito'].includes(value)) return 'card-expense';
  return null;
}

function parseWizardTags(value) {
  if (!value || isSkipInput(value)) {
    return [];
  }

  if (value.includes('#')) {
    return normalizeTags(extractTags(value.split(' ')));
  }

  return normalizeTags(value.split(',').map((item) => item.trim()));
}

function parseInstallmentsInput(value) {
  if (!value || isSkipInput(value)) {
    return 1;
  }

  const normalized = normalizeWord(value);
  const match = normalized.match(/(?:@?(?:parcelas|parc|x)[:=])?(\d{1,2})x?$/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 36) {
    return null;
  }

  return parsed;
}

function isSkipInput(value) {
  const normalized = normalizeWord(value || '');
  return normalized === '-' || normalized === 'sem' || normalized === 'pular' || normalized === 'skip';
}

function parseCommand(input) {
  const cleaned = normalizeSpaces(input);
  const parts = cleaned.split(' ');
  if (parts.length < 3) {
    return { ok: false, error: 'Use: tipo valor descricao [data] [#tags] [@cartao=nome] [@parcelas=N]' };
  }

  const rawType = normalizeWord(parts[0]);
  const type = mapType(rawType);
  if (!type) {
    return { ok: false, error: 'Tipo invalido. Use: gasto, entrada, investir, diario, cartao.' };
  }

  const amount = parseAmount(parts[1]);
  if (!amount || amount <= 0) {
    return { ok: false, error: 'Valor invalido. Exemplo: 39,90' };
  }

  const tail = parts.slice(2);
  const tags = extractTags(tail);
  const directives = extractDirectives(tail);
  const withoutMeta = tail.filter((token) => !token.startsWith('#') && !token.startsWith('@'));

  const maybeDate = withoutMeta.length ? withoutMeta[withoutMeta.length - 1] : '';
  const parsedDate = parseDate(maybeDate);
  const date = parsedDate ?? todayDate();

  const descriptionTokens = parsedDate ? withoutMeta.slice(0, -1) : withoutMeta;
  const label = normalizeSpaces(descriptionTokens.join(' ')).trim() || defaultLabel(type);

  const normalizedTags = normalizeTags(tags);

  if (type === 'investment' && normalizedTags.length === 0) {
    if (containsEmergencyHint(label)) {
      normalizedTags.push('Reserva de emergencia');
    }
  }

  return {
    ok: true,
    value: {
      type,
      amount,
      label,
      date,
      tags: normalizedTags,
      cardNameHint: directives.cardNameHint,
      installments: directives.installments
    }
  };
}

async function saveLaunch(uid, data) {
  if (data.type === 'card-expense') {
    return saveCardLaunch(uid, data);
  }

  return saveMonthEvent(uid, data);
}

async function saveMonthEvent(uid, data) {
  const eventDate = new Date(`${data.date}T00:00:00`);
  const year = eventDate.getFullYear();
  const monthNumber = eventDate.getMonth() + 1;
  const day = eventDate.getDate();
  const monthKey = `${year}-${String(monthNumber).padStart(2, '0')}`;

  const monthRef = db.doc(`users/${uid}/months/${monthKey}`);

  const event = {
    id: randomUUID(),
    day,
    label: data.label,
    amount: Number(data.amount.toFixed(2)),
    type: data.type,
    ...(data.tags.length ? { tags: data.tags } : {})
  };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(monthRef);

    if (!snap.exists) {
      tx.set(monthRef, {
        id: monthKey,
        key: monthKey,
        title: monthNames[monthNumber - 1],
        year,
        monthNumber,
        openingBalance: 0,
        dailyFixedCost: 0,
        events: [event]
      });
      return;
    }

    tx.update(monthRef, {
      events: FieldValueRef.arrayUnion(event)
    });
  });

  const dateLabel = formatDateBr(day, monthNumber, year);
  const typeLabel = typeLabelFor(data.type);
  const tagLabel = data.tags.length ? ` | tags: ${data.tags.join(', ')}` : '';

  return {
    summary: `${typeLabel} R$ ${formatAmountBr(data.amount)} em ${dateLabel} | ${data.label}${tagLabel}`
  };
}

async function saveCardLaunch(uid, data) {
  const cards = await db.collection(`users/${uid}/cards`).get();
  if (cards.empty) {
    throw new Error('Nenhum cartao encontrado para este usuario.');
  }

  const requestedCardName = normalizeWord(data.cardNameHint || '');
  const matchedByName = requestedCardName
    ? cards.docs.find((doc) => {
        const cardName = normalizeWord(doc.data()?.name || '');
        return cardName.includes(requestedCardName) || requestedCardName.includes(cardName);
      })
    : null;

  const selectedCard = matchedByName || (cards.docs.length === 1 ? cards.docs[0] : null);
  if (!selectedCard) {
    const available = cards.docs
      .map((doc) => String(doc.data()?.name || '').trim())
      .filter(Boolean)
      .join(', ');

    if (requestedCardName) {
      throw new Error(`Nao achei o cartao "${data.cardNameHint}". Disponiveis: ${available}.`);
    }

    throw new Error(`Voce tem mais de um cartao. Use @cartao=nome. Disponiveis: ${available}.`);
  }

  const cardId = String(selectedCard.id);
  const cardName = String(selectedCard.data()?.name || 'cartao');
  const installments = Number.isInteger(data.installments) ? Math.max(1, data.installments) : 1;
  const seriesId = installments > 1 ? randomUUID() : null;

  const baseDate = parseIsoDate(data.date);
  if (!baseDate) {
    throw new Error('Data invalida para lancamento de cartao.');
  }

  for (let i = 0; i < installments; i += 1) {
    const installmentDate = addMonthsKeepingDay(baseDate, i);
    const payload = {
      cardId,
      amount: Number(data.amount.toFixed(2)),
      date: toIsoDate(installmentDate),
      repeatMode: installments > 1 ? 'installment' : 'single',
      ...(seriesId ? { seriesId } : {}),
      ...(installments > 1 ? { installmentNumber: i + 1, installmentTotal: installments } : {}),
      account: 'Telegram',
      description: data.label,
      notes: '',
      tags: data.tags.join(', ')
    };

    await db.collection(`users/${uid}/cardLaunches`).add(payload);
  }

  const eventDate = new Date(`${data.date}T00:00:00`);
  const dateLabel = formatDateBr(eventDate.getDate(), eventDate.getMonth() + 1, eventDate.getFullYear());
  const tagLabel = data.tags.length ? ` | tags: ${data.tags.join(', ')}` : '';
  const installmentsLabel = installments > 1 ? ` | ${installments}x` : '';

  return {
    summary: `cartao (${cardName}) R$ ${formatAmountBr(data.amount)} em ${dateLabel}${installmentsLabel} | ${data.label}${tagLabel}`
  };
}

async function initializeFirebaseAndGetDb() {
  const firebaseAdminApp = await import('firebase-admin/app');
  const firebaseAdminFirestore = await import('firebase-admin/firestore');
  const firebaseAdminAuth = await import('firebase-admin/auth');
  const { initializeApp, applicationDefault, cert } = firebaseAdminApp;
  const { getFirestore, FieldValue } = firebaseAdminFirestore;
  const { getAuth } = firebaseAdminAuth;

  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
    const json = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    initializeApp({ credential: cert(json) });
  } else {
    initializeApp({ credential: applicationDefault() });
  }

  return {
    db: getFirestore(),
    FieldValueRef: FieldValue,
    authRef: getAuth()
  };
}

function mapType(word) {
  if (['gasto', 'saida', 'despesa', 'expense'].includes(word)) {
    return 'expense';
  }
  if (['cartao', 'cartao_credito', 'card', 'credito'].includes(word)) {
    return 'card-expense';
  }
  if (['entrada', 'receita', 'income'].includes(word)) {
    return 'income';
  }
  if (['investir', 'investimento', 'aporte'].includes(word)) {
    return 'investment';
  }
  if (['diario', 'daily'].includes(word)) {
    return 'daily';
  }
  return null;
}

function parseAmount(raw) {
  const cleaned = String(raw)
    .replace(/r\$/gi, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function parseDate(raw) {
  if (!raw) {
    return null;
  }

  const word = normalizeWord(raw);
  const now = new Date();

  if (word === 'hoje') {
    return toIsoDate(now);
  }

  if (word === 'ontem') {
    const d = new Date(now);
    d.setDate(now.getDate() - 1);
    return toIsoDate(d);
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (isValidDate(y, m, d)) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }

  const brMatch = raw.match(/^(\d{2})\/(\d{2})(?:\/(\d{2}|\d{4}))?$/);
  if (brMatch) {
    const d = Number(brMatch[1]);
    const m = Number(brMatch[2]);
    let y = now.getFullYear();
    if (brMatch[3]) {
      y = brMatch[3].length === 2 ? 2000 + Number(brMatch[3]) : Number(brMatch[3]);
    }
    if (isValidDate(y, m, d)) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const brDashMatch = raw.match(/^(\d{2})-(\d{2})(?:-(\d{2}|\d{4}))?$/);
  if (brDashMatch) {
    const d = Number(brDashMatch[1]);
    const m = Number(brDashMatch[2]);
    let y = now.getFullYear();
    if (brDashMatch[3]) {
      y = brDashMatch[3].length === 2 ? 2000 + Number(brDashMatch[3]) : Number(brDashMatch[3]);
    }
    if (isValidDate(y, m, d)) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  return null;
}

function extractTags(tokens) {
  return tokens
    .filter((token) => token.startsWith('#') && token.length > 1)
    .map((token) => token.slice(1).replace(/_/g, ' '));
}

function extractDirectives(tokens) {
  let cardNameHint = '';
  let installments = 1;

  for (const token of tokens) {
    if (!token.startsWith('@')) {
      continue;
    }

    const match = token.match(/^@(cartao|card)[:=](.+)$/i);
    if (!match) {
      const parcelMatch = token.match(/^@(parcelas|parc|x)[:=](\d{1,2})$/i);
      if (!parcelMatch) {
        continue;
      }

      const parsed = Number(parcelMatch[2]);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 36) {
        installments = parsed;
      }
      continue;
    }

    cardNameHint = normalizeSpaces(String(match[2] || '').replace(/_/g, ' '));
  }

  return { cardNameHint, installments };
}

function parseIsoDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDate(year, month, day)) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function addMonthsKeepingDay(date, monthsToAdd) {
  const source = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const y = source.getFullYear();
  const m = source.getMonth();
  const d = source.getDate();

  const firstOfTarget = new Date(y, m + monthsToAdd, 1);
  const lastDay = new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth() + 1, 0).getDate();
  const day = Math.min(d, lastDay);

  return new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth(), day);
}

function normalizeTags(tags) {
  const seen = new Set();
  const result = [];

  for (const tag of tags) {
    const label = normalizeSpaces(tag).trim();
    if (!label) {
      continue;
    }

    const normalized = normalizeWord(label);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(label);
  }

  return result;
}

function containsEmergencyHint(text) {
  const normalized = normalizeWord(text);
  return normalized.includes('reserva de emergencia') || normalized.includes('emergencia');
}

function defaultLabel(type) {
  if (type === 'income') return 'entrada via telegram';
  if (type === 'investment') return 'investimento via telegram';
  if (type === 'daily') return 'diario via telegram';
  if (type === 'card-expense') return 'despesa no cartao via telegram';
  return 'saida via telegram';
}

function typeLabelFor(type) {
  if (type === 'income') return 'entrada';
  if (type === 'investment') return 'investimento';
  if (type === 'daily') return 'diario';
  if (type === 'card-expense') return 'cartao';
  return 'saida';
}

function todayDate() {
  return toIsoDate(new Date());
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isValidDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === (month - 1) && d.getDate() === day;
}

function formatAmountBr(value) {
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatDateBr(day, month, year) {
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function normalizeWord(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function buildHelpText() {
  return [
    'Como lancar (jeito facil):',
    '1) Use /lancar e responda as perguntas.',
    '2) Se quiser, tambem pode enviar no formato rapido.',
    '',
    'Comandos importantes:',
    '/entrar seu-email@dominio.com',
    '/lancar',
    '/cancelar',
    '/quemsou',
    '/sair',
    '',
    'Exemplos simples:',
    'gasto 39,90 mercado hoje #alimentacao',
    'entrada 2500 salario hoje',
    'investir 300 aporte hoje #reserva',
    'diario 25 cafe hoje',
    'cartao 120,50 almoco hoje #alimentacao',
    'cartao 350 tv hoje @parcelas=10 @cartao=nubank',
    '',
    'Data: use hoje, ontem ou dd-mm-aaaa (ex: 02-06-2026).',
    'Cartao com mais de um: use @cartao=nome.',
    'Parcelado: use @parcelas=N (1 a 36).',
    '',
    'Dica: se tiver duvida, use /lancar.'
  ].join('\n');
}

function buildInvalidCommandHelp(errorText) {
  return [
    'Nao entendi esse comando.',
    '',
    'Mais facil: envie /lancar (passo a passo).',
    '',
    'Exemplos rapidos:',
    'gasto 39,90 mercado hoje',
    'entrada 2500 salario hoje',
    'cartao 120,50 almoco hoje',
    '',
    `Detalhe tecnico: ${errorText}`
  ].join('\n');
}

async function sendMessage(chatId, text) {
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
