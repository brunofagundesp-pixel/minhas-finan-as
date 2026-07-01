const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin SDK ──────────────────────────────────────────────────────
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');

if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  admin.initializeApp({
    credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
  });
} else {
  admin.initializeApp();
}

// ── SMTP config (Hostinger) ─────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.hostinger.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_USER = process.env.SMTP_USER || 'no-reply@previsa.site';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@previsa.site';
const FROM_NAME = process.env.FROM_NAME || 'Previsa';
const APP_URL = process.env.APP_URL || 'https://previsa.web.app';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// ── Email template ──────────────────────────────────────────────────────────
function buildVerificationEmailHtml(link) {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirme seu e-mail - Previsa</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6fa;padding:32px 16px">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr>
            <td align="center" style="padding-bottom:24px">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style="vertical-align:middle;margin-right:8px">
                <rect x="2" y="4" width="4" height="16" rx="1" fill="#1f5cc2"/>
                <rect x="10" y="8" width="4" height="12" rx="1" fill="#1f5cc2"/>
                <rect x="18" y="2" width="4" height="20" rx="1" fill="#1f5cc2"/>
              </svg>
              <span style="font-size:28px;font-weight:700;color:#1a2332;vertical-align:middle">Previsa</span>
              <span style="display:block;font-size:13px;color:#74869f;margin-top:4px">Gestão financeira com previsibilidade</span>
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border-radius:12px;padding:40px 32px;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
              <h1 style="margin:0 0 8px;font-size:22px;color:#1a2332;font-weight:600">Confirme seu e-mail</h1>
              <p style="margin:0 0 24px;font-size:15px;color:#4a5568;line-height:1.5">
                Bem-vindo ao <strong>Previsa</strong>! Clique no botão abaixo para verificar seu e-mail
                e começar a gerenciar suas finanças com previsibilidade.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px">
                <tr>
                  <td align="center" style="border-radius:8px;background-color:#1168d9;padding:14px 32px">
                    <a href="${link}" target="_blank"
                       style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;display:inline-block">
                      Verificar e-mail
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;font-size:13px;color:#74869f;line-height:1.5">
                Se o botão não funcionar, copie e cole o link abaixo no seu navegador:
              </p>
              <p style="margin:0 0 0;font-size:12px;color:#74869f;word-break:break-all;line-height:1.5">
                <a href="${link}" style="color:#1168d9;text-decoration:underline">${link}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px">
              <p style="margin:0;font-size:12px;color:#a0aec0;line-height:1.5">
                Se voc\u00ea n\u00e3o criou uma conta no Previsa, ignore este e-mail.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/send-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'O campo "email" é obrigatório.' });
    }

    const actionCodeSettings = {
      url: APP_URL,
      handleCodeInApp: false,
    };

    const link = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);
    const html = buildVerificationEmailHtml(link);

    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: email,
      subject: 'Confirme seu e-mail - Previsa',
      html,
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao enviar e-mail de verificação.' });
  }
});

// ── Welcome email template ──────────────────────────────────────────────────

function buildWelcomeEmailHtml(name) {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bem-vindo ao Previsa - Beta</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6fa;padding:32px 16px">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr>
            <td align="center" style="padding-bottom:24px">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style="vertical-align:middle;margin-right:8px">
                <rect x="2" y="4" width="4" height="16" rx="1" fill="#1f5cc2"/>
                <rect x="10" y="8" width="4" height="12" rx="1" fill="#1f5cc2"/>
                <rect x="18" y="2" width="4" height="20" rx="1" fill="#1f5cc2"/>
              </svg>
              <span style="font-size:28px;font-weight:700;color:#1a2332;vertical-align:middle">Previsa</span>
              <span style="display:block;font-size:13px;color:#74869f;margin-top:4px">Gestão financeira com previsibilidade</span>
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border-radius:12px;padding:40px 32px;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
              <h1 style="margin:0 0 16px;font-size:22px;color:#1a2332;font-weight:600">
                Ol\u00e1, ${name}!
              </h1>
              <p style="margin:0 0 16px;font-size:15px;color:#4a5568;line-height:1.5">
                Voc\u00ea foi selecionado para participar do <strong>beta fechado do Previsa</strong>!
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#4a5568;line-height:1.5">
                O Previsa \u00e9 um gestor financeiro pessoal que ajuda voc\u00ea a enxergar para onde o
                seu dinheiro vai, m\u00eas a m\u00eas, antes de acontecer. Com ele, voc\u00ea pode:
              </p>
              <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#4a5568;line-height:1.6">
                <li>Registrar entradas, sa\u00eddas e investimentos</li>
                <li>Projetar seu saldo para at\u00e9 24 meses</li>
                <li>Acompanhar gastos por cart\u00e3o de cr\u00e9dito com previs\u00e3o de fatura</li>
                <li>Definir metas de gasto e receber alertas</li>
                <li>Simular cen\u00e1rios de redu\u00e7\u00e3o de renda</li>
              </ul>
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px">
                <tr>
                  <td align="center" style="border-radius:8px;background-color:#1168d9;padding:14px 32px">
                    <a href="${APP_URL}" target="_blank"
                       style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;display:inline-block">
                      Acessar o Previsa
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 0;font-size:13px;color:#74869f;line-height:1.5">
                Seu acesso j\u00e1 est\u00e1 liberado. Basta criar sua conta com o e-mail que recebeu
                esta mensagem e come\u00e7ar a usar.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px">
              <p style="margin:0;font-size:12px;color:#a0aec0;line-height:1.5">
                D\u00favidas? Responda a este e-mail ou entre em contato pelo Instagram.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

app.post('/api/send-welcome', async (req, res) => {
  try {
    const { email, name } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'O campo "email" é obrigatório.' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'O campo "name" é obrigatório.' });
    }

    const html = buildWelcomeEmailHtml(name);

    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: email,
      subject: `Bem-vindo ao Previsa, ${name}!`,
      html,
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao enviar e-mail de boas-vindas.' });
  }
});

// ── Health check ────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Previsa email server running on port ${PORT}`);
});
