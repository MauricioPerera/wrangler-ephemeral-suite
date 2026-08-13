# 🧰 Ephemeral Suite

🌐 **Español** · [English](./README.en.md) · [Português](./README.pt.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MauricioPerera/wrangler-ephemeral-suite)

🌐 **[Landing page](https://mauricioperera.github.io/wrangler-ephemeral-suite/)** — presentación visual del proyecto, disponible en español / English / português.

**Chat + pizarra + airdrop en un solo deploy.** Si te interesan las tres herramientas al mismo tiempo (una reunión donde chateás, dibujás y pasás un archivo), no hace falta hacer tres `wrangler deploy --temporary` distintos con tres cuentas temporales — esto las combina en un único Worker, una única cuenta, un único link/claim URL.

Cada herramienta sigue existiendo también **standalone**, sin cambios, para quien solo necesite una:
[wrangler-ephemeral-chat](https://github.com/MauricioPerera/wrangler-ephemeral-chat) · [wrangler-ephemeral-whiteboard](https://github.com/MauricioPerera/wrangler-ephemeral-whiteboard) · [wrangler-ephemeral-airdrop](https://github.com/MauricioPerera/wrangler-ephemeral-airdrop)

## Cómo funciona

- `wrangler deploy --temporary` crea una cuenta de Cloudflare temporal (sin login) y despliega un único Worker con **tres Durable Objects distintos** (`ChatRoom`, `Board`, `Drop`).
- Cada herramienta vive bajo su propio prefijo de ruta para no colisionar entre sí:
  - `/chat` — chat en tiempo real
  - `/board` — pizarra colaborativa
  - `/drop` — compartir un archivo por QR/link
- `/` es un hub simple con links a las tres.
- Todo comparte la misma cuenta temporal — un solo countdown, una sola claim URL, un solo deploy.

## Requisitos

- Node.js
- Wrangler **4.102.0 o superior**
- **No estar logueado** en Wrangler (`wrangler logout` si ya tenés sesión)

## Deploy

```bash
git clone https://github.com/MauricioPerera/wrangler-ephemeral-suite.git
cd wrangler-ephemeral-suite
npm install
npx wrangler deploy --temporary
```

Abrí la URL raíz para ver el hub, o andá directo a `/chat`, `/board` o `/drop`.

### Deploy permanente (opcional)

`wrangler login` + `npx wrangler deploy` en vez de `--temporary`, o el botón **Deploy to Cloudflare** de arriba.

## Funcionalidades

Las mismas de los tres proyectos individuales, sin recortes:

- **Chat**: tiempo real, admin + invitaciones de un solo uso, historial persistente, UI mobile
- **Pizarra**: dibujo colaborativo en vivo, exportar/importar PNG y JSON, admin + invitaciones
- **Airdrop**: subida por drag & drop, QR generado en el navegador, descarga sin conexión previa, verificado hasta 18MB

## Por qué esto vale la pena en vez de tres deploys

- Un solo `wrangler deploy --temporary` en vez de tres
- Una sola claim URL si te interesa reclamar todo
- Una sola cuenta temporal compartiendo la misma ventana de ~1 hora — todo expira junto, sin desincronización entre herramientas
- El bundle total sigue siendo chico (~60KB, nada de WASM como en el sandbox) — no hay costo real de combinar

## Lo que perdés al combinar

- Ya no podés desplegar "solo el chat" desde este repo — para eso usá el repo standalone correspondiente
- El código de las tres herramientas queda duplicado entre este repo y los tres originales (es intencional: cada uno se mantiene independiente, no hay una dependencia compartida)

## Estructura

```
src/index.js       — los tres Worker + Durable Object (ChatRoom, Board, Drop) + hub + routing por prefijo
wrangler.jsonc      — config del Worker con los tres bindings de Durable Object
```

## Límites (heredados de las cuentas temporales de Cloudflare)

Los mismos que los tres proyectos individuales — ver sus READMEs respectivos para el detalle probado de cada uno.

## ¿Sos un agente de IA?

Ver [AGENTS.md](./AGENTS.md) para instrucciones de despliegue autónomo con `wrangler --temporary`.
