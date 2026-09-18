import type {
  AuditLog,
  Category,
  ClosureMethod,
  ComboItem,
  CompanySettings,
  Customer,
  DailyClosure,
  Device,
  ExchangeRate,
  InventoryMovement,
  Order,
  OrderDeposit,
  OrderItem,
  PaymentMethod,
  PriceGroup,
  PriceGroupPrice,
  PriceType,
  Product,
  ProductPrice,
  RetiredProductCode,
  Role,
  RolePermission,
  Sale,
  SaleItem,
  SalePayment,
  User,
} from '../generated/prisma/client';
import { num, num0 } from './money';
import { utcToBusinessDate } from './time';

/**
 * El wire de la API. Traduce las filas de Prisma a la forma que el frontend ya
 * consume (`src/lib/types.ts` de karelys-pedidos): camelCase, dinero como
 * **número JSON** y agregados con sus hijas dentro.
 *
 * Dos reglas que este módulo hace cumplir y que no se pueden relajar:
 *  1. `passwordHash` NUNCA sale. No hay un serializador de usuario que lo
 *     incluya, así que no se puede filtrar por descuido en una ruta nueva.
 *  2. Lo que en el frontend es `number` sale como number, no como string: sus
 *     tipos son `number` y cambiar el formato obligaría a tocarlo (§6.1).
 *
 * `rev` viaja en cada raíz de agregado y hace de ETag / `baseRev`.
 */

/** Quita las claves con `undefined` para no ensuciar el JSON. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/* ── Seguridad ──────────────────────────────────────────────────────────── */

export function roleOut(role: Role & { permissions: RolePermission[] }) {
  return {
    id: role.id,
    name: role.name,
    permissions: role.permissions.map((p) => p.permission),
    system: role.system,
    rev: role.rev,
  };
}

/** Sin `passwordHash`: el hash no sale del servidor ni en /bootstrap ni en /sync. */
export function userOut(user: User) {
  return clean({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    email: opt(user.email),
    roleId: user.roleId,
    active: user.active,
    system: user.system,
    deactivatedAt: iso(user.deactivatedAt),
    lastLoginAt: iso(user.lastLoginAt),
    createdAt: user.createdAt.toISOString(),
    rev: user.rev,
  });
}

/* ── Catálogo y precios ─────────────────────────────────────────────────── */

export function categoryOut(c: Category) {
  return { id: c.id, name: c.name, active: c.active, rev: c.rev };
}

export function priceTypeOut(pt: PriceType) {
  return {
    id: pt.id,
    name: pt.name,
    isDefault: pt.isDefault,
    position: pt.position,
    rev: pt.rev,
  };
}

const priceOut = (p: ProductPrice | PriceGroupPrice) => ({
  priceTypeId: p.priceTypeId,
  amount: num0(p.amount),
});

/**
 * La `PriceRule` del frontend, reconstruida de las 4 columnas aplanadas.
 *
 * @deprecated 2026-09 · Grupos de precio retirados: ninguna regla de grupo se
 * evalúa ya, ni para alertar ni para bloquear. Se sigue serializando tal cual
 * para no cambiarle la forma del agregado a un cliente v5. Ver
 * `PriceGroupsService`.
 */
export function ruleOut(g: PriceGroup) {
  if (g.ruleMinUsd === null || g.ruleTargetUsd === null) return undefined;
  const band =
    g.ruleBandMinUsd !== null && g.ruleBandMaxUsd !== null
      ? { minUsd: num0(g.ruleBandMinUsd), maxUsd: num0(g.ruleBandMaxUsd) }
      : undefined;
  return clean({
    minUsd: num0(g.ruleMinUsd),
    targetUsd: num0(g.ruleTargetUsd),
    band,
  });
}

/** @deprecated 2026-09 · Sólo compatibilidad v5. Ver `ruleOut`. */
export function priceGroupOut(g: PriceGroup & { prices: PriceGroupPrice[] }) {
  return clean({
    id: g.id,
    name: g.name,
    categoryId: opt(g.categoryId),
    prices: g.prices.map(priceOut),
    rule: ruleOut(g),
    active: g.active,
    createdAt: g.createdAt.toISOString(),
    rev: g.rev,
  });
}

const comboItemOut = (ci: ComboItem) =>
  clean({
    description: ci.description,
    qty: num0(ci.qty),
    productId: opt(ci.componentProductId),
  });

export function productOut(p: Product & { prices: ProductPrice[]; comboItems: ComboItem[] }) {
  return clean({
    id: p.id,
    code: p.code,
    name: p.name,
    description: opt(p.description),
    categoryId: p.categoryId,
    imageUrl: opt(p.imageUrl),
    // `stock` es de LECTURA para el cliente: se mueve registrando un movimiento.
    stock: num0(p.stock),
    minStock: num0(p.minStock),
    active: p.active,
    bsOnly: p.bsOnly,
    bsPrice: num(p.bsPrice) ?? undefined,
    prices: p.prices.map(priceOut),
    // @deprecated 2026-09 · La columna sigue en el esquema y se sigue enviando
    // para no cambiar la forma del agregado, pero el precio efectivo del producto
    // sale siempre de `prices`: ya no hay resolución por grupo.
    priceGroupId: opt(p.priceGroupId),
    isCombo: p.isCombo,
    comboItems: p.isCombo ? p.comboItems.map(comboItemOut) : undefined,
    allowCustomization: p.allowCustomization,
    customizationPrice: num(p.customizationPrice) ?? undefined,
    createdAt: p.createdAt.toISOString(),
    rev: p.rev,
  });
}

export function retiredCodeOut(r: RetiredProductCode) {
  return clean({
    code: r.code,
    formerName: opt(r.formerName),
    reason: opt(r.reason),
    retiredAt: r.retiredAt.toISOString(),
  });
}

/* ── Operación ──────────────────────────────────────────────────────────── */

export function customerOut(c: Customer) {
  return clean({
    id: c.id,
    cedula: c.cedula,
    name: c.name,
    phone: opt(c.phone),
    address: opt(c.address),
    active: c.active,
    createdAt: c.createdAt.toISOString(),
    rev: c.rev,
  });
}

export function paymentMethodOut(m: PaymentMethod) {
  return {
    id: m.id,
    name: m.name,
    currency: m.currency,
    requiresReference: m.requiresReference,
    active: m.active,
    position: m.position,
    rev: m.rev,
  };
}

export function rateOut(r: ExchangeRate) {
  return {
    id: r.id,
    source: r.source,
    currency: r.currency,
    value: num0(r.value),
    automatic: r.automatic,
    userId: r.userId,
    createdAt: r.createdAt.toISOString(),
    rev: r.rev,
  };
}

export function movementOut(m: InventoryMovement) {
  return clean({
    id: m.id,
    productId: m.productId,
    type: m.type,
    qty: num0(m.qty),
    // `delta` y `stockAfter` los calcula el servidor; viajan para que el cliente
    // pueda mostrar el kardex sin recalcular nada.
    delta: num0(m.delta),
    stockAfter: num0(m.stockAfter),
    reason: m.reason,
    note: opt(m.note),
    userId: m.userId,
    saleId: opt(m.saleId),
    orderId: opt(m.orderId),
    createdAt: m.createdAt.toISOString(),
    rev: m.rev,
  });
}

const lineOut = (i: SaleItem | OrderItem) =>
  clean({
    productId: i.productId,
    code: i.code,
    name: i.name,
    qty: num0(i.qty),
    priceTypeId: i.priceTypeId,
    unitPriceUsd: num0(i.unitPriceUsd),
    unitPriceBs: num(i.unitPriceBs) ?? undefined,
    bsOnly: i.bsOnly,
    customization: opt(i.customization),
    customizationPrice: num(i.customizationPrice) ?? undefined,
    subtotalUsd: num0(i.subtotalUsd),
  });

const salePaymentOut = (p: SalePayment) =>
  clean({
    methodId: p.methodId,
    methodName: p.methodName,
    currency: p.currency,
    amount: num0(p.amount),
    usdEquivalent: num0(p.usdEquivalent),
    reference: opt(p.reference),
    at: p.at.toISOString(),
    businessDate: utcToBusinessDate(p.businessDate),
    rateUsed: num(p.rateUsed) ?? undefined,
    fromOrderDepositId: opt(p.fromOrderDepositId),
  });

export function saleOut(sale: Sale & { items: SaleItem[]; payments: SalePayment[] }) {
  return clean({
    id: sale.id,
    number: sale.number,
    clientNumber: opt(sale.clientNumber),
    createdAt: sale.createdAt.toISOString(),
    receivedAt: sale.receivedAt.toISOString(),
    // El día contable lo pone la base en `America/Caracas`: el cierre de caja
    // debe usar ESTE campo, no `createdAt.slice(0,10)` (§3.4).
    businessDate: utcToBusinessDate(sale.businessDate),
    customerId: sale.customerId,
    customerName: sale.customerName,
    userId: sale.userId,
    userName: sale.userName,
    items: sale.items.map(lineOut),
    payments: sale.payments.map(salePaymentOut),
    totalUsd: num0(sale.totalUsd),
    totalBs: num0(sale.totalBs),
    changeUsd: num(sale.changeUsd) ?? undefined,
    rateSnapshot: {
      usd: num0(sale.rateUsd),
      eur: num0(sale.rateEur),
      binance: num0(sale.rateBinance),
      at: sale.rateAt.toISOString(),
    },
    status: sale.status,
    orderId: opt(sale.orderId),
    note: opt(sale.note),
    voidedAt: iso(sale.voidedAt),
    voidReason: opt(sale.voidReason),
    voidedByUserId: opt(sale.voidedByUserId),
    createdOffline: sale.createdOffline,
    rev: sale.rev,
  });
}

export function depositOut(d: OrderDeposit) {
  return clean({
    id: d.id,
    orderId: d.orderId,
    methodId: d.methodId,
    methodName: d.methodName,
    currency: d.currency,
    amount: num0(d.amount),
    usdEquivalent: num0(d.usdEquivalent),
    rateUsed: num0(d.rateUsed),
    reference: opt(d.reference),
    note: opt(d.note),
    at: d.at.toISOString(),
    businessDate: utcToBusinessDate(d.businessDate),
    createdAt: d.createdAt.toISOString(),
    userId: d.userId,
    saleId: opt(d.saleId),
    voided: d.voided,
    voidedAt: iso(d.voidedAt),
    voidReason: opt(d.voidReason),
    rev: d.rev,
  });
}

export function orderOut(order: Order & { items: OrderItem[]; deposits: OrderDeposit[] }) {
  return clean({
    id: order.id,
    number: order.number,
    clientNumber: opt(order.clientNumber),
    createdAt: order.createdAt.toISOString(),
    receivedAt: order.receivedAt.toISOString(),
    businessDate: utcToBusinessDate(order.businessDate),
    customerId: order.customerId,
    customerName: order.customerName,
    userId: order.userId,
    items: order.items.map(lineOut),
    // Los abonos viajan también como entidad propia en el delta (tienen `rev`
    // aparte); aquí van embebidos porque `orderBalance()` los necesita.
    deposits: order.deposits.map(depositOut),
    totalUsd: num0(order.totalUsd),
    note: opt(order.note),
    status: order.status,
    saleId: opt(order.saleId),
    canceledAt: iso(order.canceledAt),
    cancelReason: opt(order.cancelReason),
    createdOffline: order.createdOffline,
    rev: order.rev,
  });
}

export function closureOut(c: DailyClosure & { methods: ClosureMethod[] }) {
  return clean({
    id: c.id,
    date: utcToBusinessDate(c.date),
    userId: c.userId,
    userName: c.userName,
    salesCount: c.salesCount,
    totalUsd: num0(c.totalUsd),
    totalBs: num0(c.totalBs),
    depositUsd: num0(c.depositUsd),
    byMethod: c.methods.map((m) => ({
      methodId: m.methodId,
      methodName: m.methodName,
      expected: num0(m.expected),
      received: num0(m.received),
    })),
    expectedUsd: num0(c.expectedUsd),
    receivedUsd: num0(c.receivedUsd),
    differenceUsd: num0(c.differenceUsd),
    note: opt(c.note),
    closedAt: c.closedAt.toISOString(),
    rev: c.rev,
  });
}

/** El frontend produce y consume `data` como string JSON; en la base es jsonb. */
export function auditOut(a: AuditLog) {
  return clean({
    id: a.id,
    userId: a.userId,
    userName: a.userName,
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    data: a.data === null || a.data === undefined ? undefined : JSON.stringify(a.data),
    createdAt: a.createdAt.toISOString(),
    rev: a.rev,
  });
}

/**
 * `coldCakeCategory` (no `coldCakeCategoryId`) porque así se llama el campo en
 * `CompanySettings` del frontend. El nombre de la columna es otro; el wire manda.
 *
 * **La clave viaja SIEMPRE**, incluso cuando la columna está a NULL: sale como
 * cadena vacía y `clean()` sólo borra `undefined`, nunca `''`. Es deliberado y no
 * se puede relajar: un cliente que fusiona la configuración campo a campo
 * conservaría su valor viejo si la clave se omitiera, y no se enteraría nunca de
 * que la categoría dejó de estar apuntada (la banda pasó a colgar del producto
 * genérico, no de la categoría; ver `PricingService.ruleOf`).
 */
export function companyOut(c: CompanySettings) {
  return clean({
    name: c.name,
    logoUrl: c.logoUrl,
    phone: c.phone,
    address: c.address,
    taxId: c.taxId,
    ticketFooter: c.ticketFooter,
    salePrefix: c.salePrefix,
    saleNext: c.saleNext,
    orderPrefix: c.orderPrefix,
    orderNext: c.orderNext,
    productCodePrefix: c.productCodePrefix,
    productCodeDigits: c.productCodeDigits,
    productCodeStart: c.productCodeStart,
    coldCakeMin: num0(c.coldCakeMin),
    coldCakeMax: num0(c.coldCakeMax),
    coldCakeCategory: c.coldCakeCategoryId ?? '',
    bsRounding: num0(c.bsRounding),
    rateMaxAgeHours: c.rateMaxAgeHours,
    timezone: c.timezone,
    schemaVersion: c.schemaVersion,
    shortcuts: (c.shortcuts ?? undefined) as Record<string, string> | undefined,
    rev: c.rev,
  });
}

export function deviceOut(d: Device) {
  return clean({
    id: d.id,
    name: opt(d.name),
    lastUserId: opt(d.lastUserId),
    lastSeenAt: iso(d.lastSeenAt),
    lastCursor: d.lastCursor ?? undefined,
    createdAt: d.createdAt.toISOString(),
  });
}
