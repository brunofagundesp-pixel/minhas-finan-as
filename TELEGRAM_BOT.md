# Telegram bot (MVP gratuito)

Este projeto agora inclui um bot Telegram por long polling em [scripts/telegram-bot.mjs](scripts/telegram-bot.mjs).

## Requisitos

- Node.js 18 ou superior
- Credencial Firebase Admin (`GOOGLE_APPLICATION_CREDENTIALS`) ou ADC

## O que ele faz

- Recebe mensagens no Telegram
- Converte para lancamento financeiro
- Salva em `users/{UID}/months/{yyyy-mm}` no Firestore
- Responde no chat com confirmacao

## Modo de identificacao de usuario

O bot suporta dois modos:

1. Multi-usuario por email (recomendado)
2. UID fixo por variavel de ambiente (legado)

No modo multi-usuario, cada chat se vincula com:

```text
/entrar seu-email@dominio.com
```

O bot resolve o UID via Firebase Auth e grava o vinculo em `telegramLinks/{chatId}` assim que encontra o email.

Passo a passo simples:

1. A pessoa digita `/entrar seu-email@dominio.com`
2. O bot procura esse email no Firebase Auth
3. O bot grava o chat como vinculado aquele usuario
4. A partir dai, qualquer lancamento enviado no chat vai para o UID encontrado

## 1) Criar bot no Telegram

1. Abra o `@BotFather`
2. Rode `/newbot`
3. Copie o token e guarde em `TELEGRAM_BOT_TOKEN`

## 2) Definir credenciais Firebase Admin

Opcao A (recomendada em maquina local):

- Defina `GOOGLE_APPLICATION_CREDENTIALS` apontando para seu JSON de service account

Windows PowerShell:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\secrets\firebase-admin.json"
```

## 3) Definir variaveis do bot

Windows PowerShell:

```powershell
$env:TELEGRAM_BOT_TOKEN="SEU_TOKEN_DO_BOT"
$env:PREVISA_TELEGRAM_CHAT_ID="123456789" # opcional, recomendado
```

`PREVISA_TELEGRAM_CHAT_ID` bloqueia uso para um unico chat.

Opcional (modo legado UID fixo):

```powershell
$env:PREVISA_FIREBASE_UID="UID_DO_USUARIO_NO_FIREBASE"
```

Se `PREVISA_FIREBASE_UID` nao for definido, o bot roda em modo multi-usuario por email.

Se voce nao sabe seu UID ou chat_id, use o helper:

```powershell
npm run telegram:probe
```

Ele lista:

- UIDs encontrados em `users/` no Firestore
- `chat_id` vistos no `getUpdates` do Telegram

Se nao aparecer chat_id, envie uma mensagem para o bot e rode novamente.

Fallback sem script (quando estiver em Node antigo):

- UID: abra o Firebase Console > Firestore > colecao `users` e copie o id do documento do usuario.
- chat_id: envie uma mensagem para o bot e rode no PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getUpdates" -Body (@{timeout=1;limit=20} | ConvertTo-Json) -ContentType "application/json"
```

## 4) Rodar

```powershell
npm run telegram:bot
```

## Comandos suportados

Comandos de vinculo:

- `/entrar email@dominio.com`
- `/quemsou`
- `/sair`
- `/lancar` (assistente guiado)
- `/cancelar` (cancelar assistente)

Comandos de lancamento:

- `gasto 39,90 mercado hoje #alimentacao`
- `entrada 2500 salario 01/06`
- `investir 300 aporte hoje #Reserva_de_emergencia`
- `diario 25 cafe hoje`
- `cartao 120,50 almoco hoje #alimentacao`
- `cartao 89,90 uber hoje @cartao=nubank #transporte`
- `cartao 350 tv hoje @parcelas=10 @cartao=nubank #casa`

Formato geral:

`tipo valor descricao [data] [#tag1 #tag2] [@cartao=nome] [@parcelas=N]`

Datas aceitas:

- `hoje`
- `ontem`
- `dd/mm`
- `dd/mm/aaaa`
- `aaaa-mm-dd`

Tipos aceitos:

- `gasto`, `saida`, `despesa`
- `entrada`, `receita`
- `investir`, `investimento`, `aporte`
- `diario`
- `cartao`, `card`

## Observacoes

- Sem `#tag`, o investimento pode nao entrar em metas por objetivo.
- Para reserva padrao, use `#Reserva_de_emergencia`.
- Para cartao com mais de um cadastro, informe `@cartao=nome-do-cartao`.
- Para parcelar no cartao, use `@parcelas=N` (de 1 a 36). O valor enviado e o valor de cada parcela.
- Se preferir nao decorar formato, use `/lancar` e o bot pergunta cada campo passo a passo.
- Esse MVP usa polling local (sem servidor publico e sem custo de webhook).
