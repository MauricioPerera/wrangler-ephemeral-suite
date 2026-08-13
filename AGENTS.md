# Guía para agentes: desplegar la suite combinada

Mismo mecanismo que los proyectos hermanos ([wrangler-ephemeral-chat](https://github.com/MauricioPerera/wrangler-ephemeral-chat/blob/master/AGENTS.md)). Esta guía cubre lo específico de la versión combinada.

## Cuándo usar este repo en vez de los standalone

- **Usá este** si el usuario quiere chat + pizarra + airdrop juntos, en un solo deploy/cuenta temporal/claim URL.
- **Usá el standalone correspondiente** (`wrangler-ephemeral-chat`, `-whiteboard`, `-airdrop`) si solo necesita una herramienta — es más liviano y no trae las otras dos.
- **Si lo que necesita es inspeccionar webhooks**, esta suite no sirve — [wrangler-ephemeral-webhook](https://github.com/MauricioPerera/wrangler-ephemeral-webhook) es un repo hermano independiente, todavía no integrado a este deploy combinado. Desplegalo aparte.

## Paso 1 — Confirmar que NO hay sesión activa

```bash
npx wrangler whoami
```

## Paso 2 — Instalar y desplegar

```bash
npm install
npx wrangler deploy --temporary
```

## Paso 3 — Verificar que funciona de verdad (las tres, no solo una)

```bash
BASE="https://<worker>.<slug>.workers.dev"

curl -sS -o /dev/null -w "hub: %{http_code}\n" "$BASE/"
curl -sS -o /dev/null -w "chat: %{http_code}\n" "$BASE/chat"
curl -sS -o /dev/null -w "board: %{http_code}\n" "$BASE/board"
curl -sS -o /dev/null -w "drop: %{http_code}\n" "$BASE/drop"
```

Si alguna de las cuatro no da 200, no reportar el deploy como exitoso. **Nota:** justo después del deploy puede haber unos segundos de propagación — un 404 inmediato que se resuelve solo a los pocos segundos no es un bug, reintentar antes de reportar un fallo real.

Para probar las rutas de WebSocket (`/chat/room/<nombre>`, `/board/room/<nombre>`) y el flujo de airdrop (`/drop/upload`, `/drop/file/<token>/raw`), ver los `AGENTS.md` de los repos standalone respectivos — la lógica es idéntica, solo cambia el prefijo de ruta.

## Gotchas específicos de este proyecto

- **Namespacing de rutas es obligatorio**: en los repos standalone, chat y pizarra usan ambos `/room/<nombre>` para su propio Durable Object. Al combinarlos colisionarían si no se prefijan (`/chat/room/*` vs `/board/room/*`). Si se agrega una cuarta herramienta a este repo en el futuro (por ejemplo `wrangler-ephemeral-webhook`, bajo `/hook/*`), verificar que no reutilice un prefijo de ruta ya usado.
- **Los tres Durable Objects van en una sola entrada de `migrations`** en `wrangler.jsonc` (`new_sqlite_classes: ["ChatRoom", "Board", "Drop"]`) — no hace falta una migración por clase.
- El bundle final es chico (~60KB) porque ninguna de las tres herramientas usa WASM (a diferencia de `wrangler-ephemeral-sandbox`) — no hay que preocuparse por tiempos de carga.

## Gotchas heredados (compartidos con todos los proyectos hermanos)

- Wrangler cachea la cuenta temporal en `wrangler-temporary-account.toml`. Si expiró y falla con `Authentication error [code: 10000]`, borrar ese archivo antes de reintentar.
- El timer de 60 minutos es fijo desde la creación, no se extiende con actividad — y acá es compartido por las tres herramientas, no una ventana independiente por cada una.

## Paso 4 — Comunicar el resultado

Entregar la URL raíz (el hub) y la claim URL. Aclarar que las tres herramientas comparten la misma ventana de ~1 hora — si el usuario reclama la cuenta, se queda con las tres juntas; si no hace nada, las tres desaparecen al mismo tiempo.
