#!/usr/bin/env node
/**
 * Crea el schema de Postgres que nombra `DATABASE_URL` si todavía no existe.
 *
 * ¿Por qué hace falta? El aislamiento entre test y producción se hace con DOS
 * SCHEMAS DE LA MISMA BASE (`?schema=test` / `?schema=public`) en lugar de dos
 * bases físicas. `prisma migrate deploy` crea el schema por su cuenta cuando no
 * existe, pero eso es un detalle de implementación del motor de migraciones y no
 * un contrato: si algún día deja de hacerlo, el primer despliegue de `test`
 * fallaría con "schema does not exist" y nadie sabría por qué. Este paso lo hace
 * explícito, es idempotente y cuesta una conexión.
 *
 * Se ejecuta antes de `prisma migrate deploy` en `npm run start:prod`.
 */
import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[db-bootstrap] Falta DATABASE_URL");
  process.exit(1);
}

/** Lee el schema del query string; `public` si no viene. */
function schemaOf(connectionString) {
  try {
    return new URL(connectionString).searchParams.get("schema") || "public";
  } catch {
    return "public";
  }
}

const schema = schemaOf(url);

if (schema === "public") {
  // `public` existe en cualquier base recién creada: no hay nada que hacer.
  console.log("[db-bootstrap] schema=public, nada que crear");
  process.exit(0);
}

// Un identificador de Postgres se cita duplicando las comillas dobles. No se
// interpola sin más: el schema viene de una variable de entorno.
const quoted = '"' + schema.replace(/"/g, '""') + '"';

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
  console.log(`[db-bootstrap] schema ${schema} listo`);
} catch (err) {
  console.error(`[db-bootstrap] No se pudo crear el schema ${schema}:`, err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
