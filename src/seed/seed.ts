import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { Permission } from '../generated/prisma/enums';
import {
  COLD_CAKE_CATEGORY_ID,
  COLD_CAKE_CATEGORY_NAME,
  PRICE_TYPE_DETAL_ID,
  PRICE_TYPE_MAYOR_ID,
} from '../catalog/catalog.constants';

/**
 * Semilla **idempotente**: todo es `upsert`, así que correrla dos veces no duplica
 * ni falla. Es lo que hace que sea segura de encadenar en un arranque.
 *
 * Qué siembra y qué NO:
 *  · SÍ: roles y permisos base, usuario administrador, formas de pago, tipos de
 *    precio (Mayor/Detal), la categoría de tortas frías y la zona del día
 *    contable.
 *  · YA NO: los tres grupos de precio de la familia (mecanismo retirado en
 *    2026-09) ni el apuntado de `cold_cake_category_id`. Volver a sembrarlos
 *    resucitaría en cada arranque lo que la migración de datos limpia.
 *  · NO: el catálogo de productos ni los clientes de prueba. El catálogo real entra
 *    por `POST /admin/import` desde el dispositivo que hoy tiene el `localStorage`
 *    bueno (ARCHITECTURE.md §8): así se preservan los ids semánticos
 *    (`prod-P060`) en lugar de rehacerlos a mano y que dejen de coincidir.
 *
 * Las filas de infraestructura (rol y usuario `system`, `company_settings`
 * singleton, los 13 códigos retirados) ya las inserta la migración inicial, así que
 * aquí no se tocan.
 */

const ALL_PERMISSIONS: Permission[] = [
  'view_sales',
  'create_sale',
  'edit_sale',
  'cancel_sale',
  'view_inventory',
  'edit_inventory',
  'view_customers',
  'edit_customers',
  'view_orders',
  'edit_orders',
  'process_orders',
  'close_cash',
  'manage_users',
  'manage_settings',
  'manage_exchange_rates',
];

/** Los roles del frontend (`lib/seed.buildSeed`), con sus mismos ids. */
const ROLES: { id: string; name: string; system?: boolean; permissions: Permission[] }[] = [
  { id: 'role-admin', name: 'Administrador', system: true, permissions: ALL_PERMISSIONS },
  {
    id: 'role-cajero',
    name: 'Cajero',
    permissions: [
      'view_sales',
      'create_sale',
      'view_inventory',
      'view_customers',
      'edit_customers',
      'view_orders',
      'process_orders',
      'close_cash',
    ],
  },
  {
    id: 'role-pedidos',
    name: 'Encargado de pedidos',
    permissions: [
      'view_orders',
      'edit_orders',
      'view_customers',
      'edit_customers',
      'view_inventory',
    ],
  },
  { id: 'role-inventario', name: 'Inventario', permissions: ['view_inventory', 'edit_inventory'] },
];

const PAYMENT_METHODS = [
  { id: 'pm-usd', name: 'USD efectivo', currency: 'USD', requiresReference: false, position: 0 },
  { id: 'pm-bs', name: 'Bs efectivo', currency: 'BS', requiresReference: false, position: 1 },
  { id: 'pm-pm', name: 'Pago Móvil', currency: 'BS', requiresReference: true, position: 2 },
  { id: 'pm-tr', name: 'Transferencia', currency: 'BS', requiresReference: true, position: 3 },
  { id: 'pm-bin', name: 'Binance', currency: 'USD', requiresReference: true, position: 4 },
] as const;

const PRICE_TYPES = [
  { id: PRICE_TYPE_MAYOR_ID, name: 'Mayor', isDefault: true, position: 0 },
  { id: PRICE_TYPE_DETAL_ID, name: 'Detal', isDefault: false, position: 1 },
];

/** Contraseña del admin en desarrollo. Documentada en el README. */
export const DEV_ADMIN_PASSWORD = 'Admin.Dev.2026';

export interface SeedOptions {
  adminUsername?: string;
  adminPassword?: string;
  adminFullName?: string;
  adminEmail?: string;
  log?: (message: string) => void;
}

export async function seed(prisma: PrismaClient, options: SeedOptions = {}) {
  const log = options.log ?? ((m: string) => console.log(`[seed] ${m}`));

  const adminUsername = (options.adminUsername ?? 'admin').trim().toLowerCase();
  const adminPassword = options.adminPassword ?? DEV_ADMIN_PASSWORD;

  // ── Roles y permisos ───────────────────────────────────────────────────────
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { id: role.id },
      create: { id: role.id, name: role.name, system: role.system ?? false },
      // El nombre no se sobreescribe: el negocio pudo renombrar "Cajero".
      update: {},
    });

    // Los permisos sí convergen a la definición: son la matriz de seguridad, y
    // dejar un rol base con menos permisos de los que declara su definición es un
    // fallo silencioso ("el cajero no puede cobrar y nadie sabe por qué").
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permission: { notIn: role.permissions } },
    });
    for (const permission of role.permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permission: { roleId: role.id, permission } },
        create: { roleId: role.id, permission },
        update: {},
      });
    }
  }
  log(`${ROLES.length} roles con sus permisos`);

  // ── Usuario administrador ──────────────────────────────────────────────────
  // La contraseña sólo se escribe al CREARLO: si el administrador ya existe y le
  // cambiaron la clave, la semilla no se la revierte (y menos a la de ejemplo).
  const existingAdmin = await prisma.user.findUnique({ where: { username: adminUsername } });
  if (existingAdmin) {
    log(`usuario "${adminUsername}" ya existe: no se toca su contraseña`);
  } else {
    await prisma.user.create({
      data: {
        id: 'user-admin',
        username: adminUsername,
        fullName: options.adminFullName ?? 'Administrador',
        email: options.adminEmail ?? null,
        passwordHash: await argon2.hash(adminPassword, {
          type: argon2.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        }),
        passwordUpdatedAt: new Date(),
        roleId: 'role-admin',
        active: true,
      },
    });
    log(`usuario administrador "${adminUsername}" creado`);
  }

  // ── Tipos de precio ────────────────────────────────────────────────────────
  // El default se pone al final para no chocar con el índice único parcial
  // `price_types_single_default_uq` si ya había otro marcado.
  for (const pt of PRICE_TYPES) {
    await prisma.priceType.upsert({
      where: { id: pt.id },
      create: { id: pt.id, name: pt.name, isDefault: false, position: pt.position },
      update: { position: pt.position },
    });
  }
  const currentDefault = await prisma.priceType.findFirst({ where: { isDefault: true } });
  if (!currentDefault) {
    await prisma.priceType.update({
      where: { id: PRICE_TYPE_MAYOR_ID },
      data: { isDefault: true },
    });
  }
  log(`${PRICE_TYPES.length} tipos de precio`);

  // ── Formas de pago ─────────────────────────────────────────────────────────
  for (const pm of PAYMENT_METHODS) {
    await prisma.paymentMethod.upsert({
      where: { id: pm.id },
      create: {
        id: pm.id,
        name: pm.name,
        currency: pm.currency,
        requiresReference: pm.requiresReference,
        position: pm.position,
        active: true,
      },
      // `active` no se fuerza: el negocio pudo desactivar un método a propósito.
      update: { requiresReference: pm.requiresReference, position: pm.position },
    });
  }
  log(`${PAYMENT_METHODS.length} formas de pago`);

  // ── Categoría de tortas frías ──────────────────────────────────────────────
  // La categoría se sigue sembrando porque los productos del catálogo importado
  // la referencian por id.
  //
  // Lo que ya NO se siembra son los tres **grupos de precio** de la familia. El
  // mecanismo se retiró en 2026-09: cada producto vuelve a tener precio propio en
  // `product_prices`. Y no es sólo que sobren: la semilla corre en CADA arranque
  // (`start:prod`), así que seguir sembrándolos resucitaría en el siguiente
  // despliegue justo las filas que la migración de datos borra.
  await prisma.category.upsert({
    where: { id: COLD_CAKE_CATEGORY_ID },
    create: { id: COLD_CAKE_CATEGORY_ID, name: COLD_CAKE_CATEGORY_NAME, active: true },
    update: {},
  });
  log('categoría de tortas frías');

  // ── Configuración de la empresa ────────────────────────────────────────────
  // La fila la crea la migración; aquí sólo se fija la zona del día contable.
  // `saleNext`/`orderNext` NO se tocan nunca.
  //
  // `coldCakeCategoryId` tampoco se apunta ya, por el mismo motivo que los grupos:
  // la banda cuelga del producto genérico "Tortas Frías" y no de la categoría
  // (`PricingService.ruleOf`), la columna se quedó sin lectores, y reescribirla en
  // cada arranque desharía la limpieza de la migración de datos.
  await prisma.companySettings.update({
    where: { id: 'singleton' },
    data: {
      timezone: process.env.BUSINESS_TIMEZONE || 'America/Caracas',
    },
  });
  log('zona horaria del día contable fijada');

  return { ok: true };
}

/** Cliente de Prisma para el seed, con el mismo manejo de schema que la app. */
export function seedClient(): PrismaClient {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('Falta DATABASE_URL');

  let connectionString = raw;
  let schema = 'public';
  try {
    const url = new URL(raw);
    schema = url.searchParams.get('schema') || 'public';
    url.searchParams.delete('schema');
    connectionString = url.toString();
  } catch {
    // Una URL que no parsea se pasa tal cual y `pg` dará el error real.
  }

  return new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString,
        options: `-c search_path=${schema === 'public' ? 'public' : `${schema},public`}`,
      },
      { schema },
    ),
  });
}
