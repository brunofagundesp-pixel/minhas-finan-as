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
              <span style="font-size:28px;font-weight:700;color:#1a2332">Previsa</span>
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

// ── Health check ────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Previsa email server running on port ${PORT}`);
});
