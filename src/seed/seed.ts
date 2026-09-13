import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { Permission } from '../generated/prisma/enums';
import {
  COLD_CAKE_ALERT_USD,
  COLD_CAKE_CATEGORY_ID,
  COLD_CAKE_CATEGORY_NAME,
  COLD_CAKE_GENERIC_GROUP_ID,
  COLD_CAKE_GENERIC_PRICES,
  COLD_CAKE_OREO_BROWNIE_GROUP_ID,
  COLD_CAKE_OREO_BROWNIE_PRICES,
  COLD_CAKE_QUESILLO_GROUP_ID,
  COLD_CAKE_QUESILLO_PRICES,
  COLD_CAKE_TARGET_USD,
  OREO_BROWNIE_NAME,
  PRICE_TYPE_DETAL_ID,
  PRICE_TYPE_MAYOR_ID,
  TORTA_QUESILLO_NAME,
} from '../catalog/catalog.constants';

/**
 * Semilla **idempotente**: todo es `upsert`, así que correrla dos veces no duplica
 * ni falla. Es lo que hace que sea segura de encadenar en un arranque.
 *
 * Qué siembra y qué NO:
 *  · SÍ: roles y permisos base, usuario administrador, formas de pago, tipos de
 *    precio (Mayor/Detal), la categoría y los tres grupos de precio de tortas
 *    frías, y la configuración de la empresa.
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

  // ── Categoría y grupos de precio de tortas frías ───────────────────────────
  await prisma.category.upsert({
    where: { id: COLD_CAKE_CATEGORY_ID },
    create: { id: COLD_CAKE_CATEGORY_ID, name: COLD_CAKE_CATEGORY_NAME, active: true },
    update: {},
  });

  /**
   * Los tres grupos de la familia. Sólo el genérico declara `band`: los dos
   * diferenciados viven por encima de esa banda a propósito, y si la declararan
   * bloquearían su propia venta (`lib/pricing.priceBandCheck`).
   */
  const groups = [
    {
      id: COLD_CAKE_GENERIC_GROUP_ID,
      name: COLD_CAKE_CATEGORY_NAME,
      prices: COLD_CAKE_GENERIC_PRICES,
      rule: {
        ruleMinUsd: COLD_CAKE_ALERT_USD,
        ruleTargetUsd: COLD_CAKE_TARGET_USD,
        ruleBandMinUsd: COLD_CAKE_ALERT_USD,
        ruleBandMaxUsd: COLD_CAKE_TARGET_USD,
      },
    },
    {
      id: COLD_CAKE_OREO_BROWNIE_GROUP_ID,
      name: OREO_BROWNIE_NAME,
      prices: COLD_CAKE_OREO_BROWNIE_PRICES,
      rule: null,
    },
    {
      id: COLD_CAKE_QUESILLO_GROUP_ID,
      name: TORTA_QUESILLO_NAME,
      prices: COLD_CAKE_QUESILLO_PRICES,
      rule: null,
    },
  ];

  for (const group of groups) {
    await prisma.priceGroup.upsert({
      where: { id: group.id },
      create: {
        id: group.id,
        name: group.name,
        categoryId: COLD_CAKE_CATEGORY_ID,
        active: true,
        ...(group.rule ?? {}),
      },
      // Sólo se repara el vínculo con la categoría: los precios y la regla que el
      // negocio haya editado se respetan.
      update: { categoryId: COLD_CAKE_CATEGORY_ID },
    });

    // Los precios se siembran sólo si el grupo no tiene ninguno: sobreescribirlos
    // devolvería el precio de venta a la semilla en cada despliegue.
    const existingPrices = await prisma.priceGroupPrice.count({ where: { priceGroupId: group.id } });
    if (existingPrices === 0) {
      await prisma.priceGroupPrice.createMany({
        data: [
          { priceGroupId: group.id, priceTypeId: PRICE_TYPE_MAYOR_ID, amount: group.prices.mayor },
          { priceGroupId: group.id, priceTypeId: PRICE_TYPE_DETAL_ID, amount: group.prices.detal },
        ],
      });
    }
  }
  log(`${groups.length} grupos de precio de tortas frías`);

  // ── Configuración de la empresa ────────────────────────────────────────────
  // La fila la crea la migración; aquí sólo se apunta la categoría de la familia y
  // se fija la zona del día contable. `saleNext`/`orderNext` NO se tocan nunca.
  await prisma.companySettings.update({
    where: { id: 'singleton' },
    data: {
      coldCakeCategoryId: COLD_CAKE_CATEGORY_ID,
      timezone: process.env.BUSINESS_TIMEZONE || 'America/Caracas',
    },
  });
  log('configuración de la empresa apuntada a la familia de tortas frías');

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
