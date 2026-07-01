const https = require('https');
const fs = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'https://email.previsa.site';
const USERS_FILE = path.join(__dirname, 'beta-users.json');

async function sendWelcome(email, name) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ email, name });

    const url = new URL('/api/send-welcome', API_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(USERS_FILE)) {
    console.error(`Arquivo não encontrado: ${USERS_FILE}`);
    console.error('Crie o arquivo com a lista de usuários no formato:');
    console.error('[{ "name": "Nome", "email": "email@exemplo.com" }]');
    process.exit(1);
  }

  const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));

  if (!Array.isArray(users) || users.length === 0) {
    console.error('Nenhum usuário encontrado no arquivo.');
    process.exit(1);
  }

  console.log(`\nEnviando e-mails de boas-vindas para ${users.length} pessoa(s)...\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i++) {
    const { name, email } = users[i];

    if (!name || !email) {
      console.log(`[${i + 1}/${users.length}] Pulando: nome ou email inválido`);
      failed++;
      continue;
    }

    process.stdout.write(`[${i + 1}/${users.length}] Enviando para ${name} <${email}>... `);

    try {
      const result = await sendWelcome(email, name);

      if (result.status === 200) {
        console.log('OK');
        success++;
      } else {
        console.log(`FALHA (${result.status}): ${JSON.stringify(result.body)}`);
        failed++;
      }
    } catch (err) {
      console.log(`ERRO: ${err.message}`);
      failed++;
    }

    // Pequena pausa entre envios pra não sobrecarregar
    if (i < users.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\nFinalizado! ${success} enviados, ${failed} falhas.\n`);
}

main().catch((err) => {
  console.error('Erro inesperado:', err);
  process.exit(1);
});
