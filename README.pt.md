# 🧰 Ephemeral Suite

🌐 [Español](./README.md) · [English](./README.en.md) · **Português**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MauricioPerera/wrangler-ephemeral-suite)

🌐 **[Landing page](https://mauricioperera.github.io/wrangler-ephemeral-suite/)** — apresentação visual do projeto, disponível em español / English / português.

**Chat + quadro branco + airdrop num único deploy.** Se você quer as três ferramentas ao mesmo tempo (uma reunião onde você conversa, desenha e passa um arquivo), não precisa fazer três `wrangler deploy --temporary` separados com três contas temporárias — isso combina tudo num único Worker, uma única conta, um único link/claim URL.

Cada ferramenta continua existindo **standalone**, sem mudanças, para quem só precisa de uma:
[wrangler-ephemeral-chat](https://github.com/MauricioPerera/wrangler-ephemeral-chat) · [wrangler-ephemeral-whiteboard](https://github.com/MauricioPerera/wrangler-ephemeral-whiteboard) · [wrangler-ephemeral-airdrop](https://github.com/MauricioPerera/wrangler-ephemeral-airdrop)

## Como funciona

- `wrangler deploy --temporary` cria uma conta temporária da Cloudflare (sem login) e implanta um único Worker com **três Durable Objects separados** (`ChatRoom`, `Board`, `Drop`).
- Cada ferramenta vive sob seu próprio prefixo de rota para não colidir:
  - `/chat` — chat em tempo real
  - `/board` — quadro colaborativo
  - `/drop` — compartilhar um arquivo via QR/link
- `/` é um hub simples com links para as três.
- Tudo compartilha a mesma conta temporária — uma contagem regressiva, uma claim URL, um deploy.

## Requisitos

- Node.js
- Wrangler **4.102.0 ou superior**
- **Não estar logado** no Wrangler (`wrangler logout` se já tiver sessão)

## Deploy

```bash
git clone https://github.com/MauricioPerera/wrangler-ephemeral-suite.git
cd wrangler-ephemeral-suite
npm install
npx wrangler deploy --temporary
```

Abra a URL raiz para ver o hub, ou vá direto para `/chat`, `/board` ou `/drop`.

### Deploy permanente (opcional)

`wrangler login` + `npx wrangler deploy` em vez de `--temporary`, ou o botão **Deploy to Cloudflare** acima.

## Funcionalidades

As mesmas dos três projetos individuais, sem cortes:

- **Chat**: tempo real, admin + convites de uso único, histórico persistente, UI mobile
- **Quadro**: desenho colaborativo ao vivo, exportar/importar PNG e JSON, admin + convites
- **Airdrop**: upload por drag & drop, QR gerado no navegador, download sem conexão prévia, testado até 18MB

## Por que vale a pena em vez de três deploys

- Um único `wrangler deploy --temporary` em vez de três
- Uma única claim URL se você quiser ficar com tudo
- Uma única conta temporária compartilhando a mesma janela de ~1 hora — tudo expira junto, sem dessincronia entre ferramentas
- O bundle total continua pequeno (~60KB, sem WASM como no sandbox) — não há custo real em combinar

## O que você perde ao combinar

- Não dá mais para implantar "só o chat" a partir deste repositório — use o repo standalone correspondente para isso
- O código das três ferramentas fica duplicado entre este repo e os três originais (é intencional: cada um permanece independente, sem dependência compartilhada)

## Estrutura

```
src/index.js       — os três Worker + Durable Object (ChatRoom, Board, Drop) + hub + roteamento por prefixo
wrangler.jsonc      — config do Worker com os três bindings de Durable Object
```

## Limites (herdados das contas temporárias da Cloudflare)

Os mesmos dos três projetos individuais — veja os READMEs respectivos para o detalhe testado de cada um.

## Você é um agente de IA?

Veja [AGENTS.md](./AGENTS.md) para instruções de deploy autônomo com `wrangler --temporary`.
