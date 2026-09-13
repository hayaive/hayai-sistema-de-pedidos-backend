#!/usr/bin/env node
import 'dotenv/config';
import { DEV_ADMIN_PASSWORD, seed, seedClient } from './seed';

/**
 * `npm run db:seed` (sobre el build) · `npm run db:seed:dev` (ts-node).
 *
 * La contraseña del administrador sale de `SEED_ADMIN_PASSWORD`. El default sólo
 * vale para desarrollo, y con `NODE_ENV=production` la variable es **obligatoria**:
 * desplegar producción con una contraseña que está escrita en el README es dejar la
 * puerta abierta.
 */
async function main() {
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (process.env.NODE_ENV === 'production' && (!password || password === DEV_ADMIN_PASSWORD)) {
    console.error(
      '[seed] SEED_ADMIN_PASSWORD es obligatoria en producción (y no puede ser la de ejemplo)',
    );
    process.exit(1);
  }

  if (!password) {
    console.warn(`[seed] SEED_ADMIN_PASSWORD sin definir: se usa la de DESARROLLO`);
  }

  const prisma = seedClient();
  try {
    await seed(prisma, {
      adminUsername: process.env.SEED_ADMIN_USERNAME,
      adminPassword: password ?? DEV_ADMIN_PASSWORD,
      adminEmail: process.env.SEED_ADMIN_EMAIL,
    });
    console.log('[seed] listo');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('[seed] falló:', err);
  process.exit(1);
});
