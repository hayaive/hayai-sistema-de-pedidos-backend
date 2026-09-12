# hayai-sistema-de-pedidos-backend

Backend del POS **Karelys Delicias**: PostgreSQL como fuente de verdad y una API
de sincronización offline-first para el frontend de `karelys-pedidos`.

Estado: **capa de datos lista**. El esquema Prisma y la migración inicial están
verificados contra un Postgres real; el proyecto NestJS se monta encima, en la
raíz de este repo.

## Documentación

👉 **[ARCHITECTURE.md](./ARCHITECTURE.md)** — esquema, versionado y resolución de
conflictos por entidad, contrato de API, DDL escrito a mano, despliegue en
Railway y por dónde continuar.

## Arranque rápido

```bash
npm install
cp .env.example .env

# Base de datos local sin instalar nada (imprime la DATABASE_URL a usar)
npx prisma dev

npx prisma migrate deploy   # aplica el esquema
npx prisma generate         # genera el cliente en src/generated/prisma
npx prisma validate         # comprueba el esquema
```

## Ramas y despliegue

| Rama | Servicio en Railway (proyecto `hayai`) | Base |
|---|---|---|
| `main` | producción | `karelys_prod` |
| `test` | pruebas | `karelys_test` |

Detalles en [ARCHITECTURE.md §8](./ARCHITECTURE.md#8--despliegue-en-railway).
