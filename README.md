# hayai-sistema-de-pedidos-backend

Backend del POS **Karelys Delicias**: PostgreSQL como fuente de verdad y una API
de sincronización offline-first para el frontend de `karelys-pedidos`.

NestJS 11 + Prisma 7 (driver adapter) + PostgreSQL.

## Documentación

👉 **[ARCHITECTURE.md](./ARCHITECTURE.md)** — esquema, versionado y resolución de
conflictos por entidad, contrato de API, DDL escrito a mano, despliegue en
Railway. **Es la especificación**: si algo de este README y del documento no
coinciden, manda el documento.

## Arranque local

```bash
npm install
cp .env.example .env          # y rellena DATABASE_URL y los dos JWT_*_SECRET
```

### Una base de datos para desarrollar

Con Docker:

```bash
docker run -d --name hayai-pg \
  -e POSTGRES_USER=hayai -e POSTGRES_PASSWORD=hayai -e POSTGRES_DB=karelys_dev \
  -p 5432:5432 postgres:16-alpine
```

y en `.env`:

```
DATABASE_URL="postgresql://hayai:hayai@localhost:5432/karelys_dev?schema=public"
```

Sin Docker, `npx prisma dev` levanta un Postgres local e imprime la URL a usar.

### Esquema y semilla

```bash
npm run db:bootstrap    # CREATE SCHEMA IF NOT EXISTS (sólo si usas ?schema=algo)
npm run db:deploy       # aplica las migraciones
npm run prisma:generate # genera el cliente en src/generated/prisma (NO se versiona)
npm run build           # compila a dist/
npm run db:seed         # semilla idempotente (corre sobre el build)
```

En desarrollo, `npm run db:seed:dev` corre la semilla con ts-node sin compilar.

### Levantar el servidor

```bash
npm run start:dev       # con recarga en caliente
# o
npm run build && npm run start:prod
```

La API queda en `http://localhost:3000/api/v1`.

### Credenciales de ejemplo (sólo desarrollo)

La semilla crea un administrador con la contraseña de `SEED_ADMIN_PASSWORD`. Si
la variable no está, usa el valor de desarrollo:

| usuario | contraseña       |
|---------|------------------|
| `admin` | `Admin.Dev.2026` |

**No es una contraseña real de producción.** El seed aborta si se intenta usar
ese default con `NODE_ENV=production`, y la contraseña sólo se escribe al *crear*
el usuario: si ya existe, correr la semilla otra vez no se la revierte.

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Admin.Dev.2026","device":{"id":"dev-1","name":"Caja 1"}}'
```

Toda petición autenticada necesita **dos** cabeceras:

```
Authorization: Bearer <accessToken>
X-Device-Id: <uuid del dispositivo>
```

## Scripts

| script | qué hace |
|---|---|
| `npm run build` | `nest build` → `dist/` |
| `npm run start:dev` | servidor con recarga en caliente |
| `npm run start:prod` | `db:bootstrap` → `prisma migrate deploy` → `node dist/main.js` |
| `npm run db:bootstrap` | `CREATE SCHEMA IF NOT EXISTS` del schema de `DATABASE_URL` |
| `npm run db:deploy` | `prisma migrate deploy` |
| `npm run db:seed` | semilla idempotente (sobre `dist/`) |
| `npm run db:seed:dev` | semilla con ts-node |
| `npm run db:drift` | comprueba que el esquema y las migraciones no se han separado |
| `npm run db:verify` | comprueba el DDL escrito a mano (triggers, CHECK, índices) |
| `npm run test:e2e` | integración contra un servidor y un Postgres reales |

> `db:drift` necesita `SHADOW_DATABASE_URL`, y su schema **tiene que coincidir**
> con el de `DATABASE_URL`. Si uno apunta a `?schema=test` y el otro a
> `?schema=public`, el diff sale lleno de `CREATE TABLE` que no son deriva real.

## Pruebas de integración

No hay mocks: se prueba contra un Postgres real, porque lo que hay que comprobar
es justo lo que un mock borraría (los triggers que asignan el cursor, el día
contable en `America/Caracas`, el índice único parcial que impide facturar dos
veces un pedido, la bitácora de idempotencia que evita duplicar dinero).

```bash
# 1 · base de datos, esquema y semilla
docker run -d --name hayai-pg-test \
  -e POSTGRES_USER=hayai -e POSTGRES_PASSWORD=hayai -e POSTGRES_DB=karelys_test \
  -p 55433:5432 postgres:16-alpine

export DATABASE_URL="postgresql://hayai:hayai@localhost:55433/karelys_test?schema=test"
npm run db:bootstrap && npm run db:deploy && npm run build
SEED_ADMIN_PASSWORD=Admin.Verify.2026 npm run db:seed

# 2 · servidor
PORT=3099 node dist/main.js &

# 3 · pruebas
API_URL=http://127.0.0.1:3099/api/v1 ADMIN_PASSWORD=Admin.Verify.2026 npm run test:e2e
```

## Aislamiento entre test y producción

Los dos ambientes comparten el mismo Postgres y se separan **por schema**:

| servicio | rama | `DATABASE_URL` |
|---|---|---|
| `hayai-pedidos-backend` | `main` | `...?schema=public` |
| `hayai-pedidos-backend-test` | `test` | `...?schema=test` |

Cada schema tiene su propia copia de las 29 tablas **y su propia secuencia
`sync_rev_seq`**, así que los cursores de sincronización de los dos ambientes son
independientes y no pueden pisarse.

`prisma migrate deploy` crea el schema si no existe, y `npm run db:bootstrap` lo
garantiza además de forma explícita antes de migrar.

> El `schema` se saca de la URL y se pasa al adaptador aparte, porque `pg` ignora
> ese parámetro de la query string (es una convención de Prisma, no de libpq).
> También se fija el `search_path` de la conexión, para que el SQL crudo —el
> borrador del cierre de caja, el cursor— lea del schema correcto.

## Despliegue en Railway

```
Build:  npm ci && npx prisma generate && npm run build
Start:  npm run start:prod
Healthcheck: /api/v1/health
```

`railway.json` ya deja esto configurado. Detalles y variables en
[ARCHITECTURE.md §8](./ARCHITECTURE.md#8--despliegue-en-railway).

- `prisma generate` es **obligatorio** en build: el cliente vive en
  `src/generated/` y no se versiona.
- `prisma` está en `dependencies` (no en `devDependencies`) porque
  `migrate deploy` corre en el arranque, y con las devDependencies podadas
  `npx prisma` tendría que descargarse el CLI en caliente.
- `GET /api/v1/health` **no toca la base** a propósito: si el healthcheck
  dependiera de Postgres, una caída de la base tumbaría el servicio entero y con
  él el endpoint que sirve para diagnosticarla. Para sondear la base está
  `GET /api/v1/health/db`.

### Primera puesta en marcha de un ambiente

1. `npm run start:prod` aplica las migraciones y las filas de infraestructura.
2. `npm run db:seed` crea roles, administrador, formas de pago, tipos de precio y
   los grupos de tortas frías.
3. El catálogo real entra por `POST /api/v1/admin/import` desde el dispositivo
   que tiene el `localStorage` bueno: es el camino que preserva los ids
   semánticos (`prod-P060`, `cat-tortas-frias`) en lugar de rehacerlos a mano.

## Estructura

```
src/
├─ main.ts              CORS, ValidationPipe global, prefijo /api/v1, 0.0.0.0
├─ app.module.ts        los 4 guardias globales (throttle, JWT, activo, permisos)
├─ generated/prisma/    cliente de Prisma (NO se versiona)
├─ prisma/              PrismaModule + PrismaService (driver adapter)
├─ config/              variables de entorno tipadas
├─ common/              errores, serializadores del wire, Decimal↔number, líneas
├─ auth/                login/refresh/logout, JwtStrategy, guardias, permisos
├─ users/               usuarios y roles (online_only)
├─ catalog/             productos, categorías, tipos de precio, grupos, bandas
├─ customers/           clientes (fusión por cédula)
├─ inventory/           ledger de existencia + caché de stock
├─ rates/               tasas + cron del publicador oficial
├─ orders/              pedidos + abonos (saldo derivado, nunca persistido)
├─ sales/               ventas: inventario, abonos, numeración, anulación
├─ closures/            borrador y cierre por día contable
├─ audit/ · company/ · devices/
├─ sync/                bootstrap · delta · push
│  └─ mutations/        un handler por (entity, op), con la tabla de conflictos
├─ admin/               importación inicial del AppState
└─ seed/                semilla idempotente
test/                   integración contra Postgres real
```

## Ramas y despliegue

| Rama | Servicio en Railway (proyecto `hayai`) | Schema |
|---|---|---|
| `main` | producción | `public` |
| `test` | pruebas | `test` |
