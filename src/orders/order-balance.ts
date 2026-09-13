import { OrderDeposit } from '../generated/prisma/client';
import { Dec, dec, EPS, usd as usdScale, zero } from '../common/money';

export type OrderPaymentStatus = 'sin_abono' | 'abonado' | 'pagado';

export interface OrderBalance {
  totalUsd: Dec;
  /** Suma en USD de los abonos vigentes (excluye anulados). */
  depositUsd: Dec;
  /** Lo que falta por pagar. Nunca negativo. */
  balanceUsd: Dec;
  /** Excedente abonado, si el pedido se redujo después de abonar. */
  overpaidUsd: Dec;
  status: OrderPaymentStatus;
  deposits: OrderDeposit[];
}

/** Abonos vigentes: excluye los anulados/devueltos (`lib/orders.activeDeposits`). */
export const activeDeposits = (deposits: OrderDeposit[]): OrderDeposit[] =>
  deposits.filter((d) => !d.voided);

/**
 * Estado de pago **derivado** de un pedido (`lib/orders.orderBalance`).
 *
 * Ni el total abonado ni el saldo se persisten: el total del pedido cambia cada
 * vez que se editan sus líneas y dos campos cacheados se desincronizarían. Por
 * eso el saldo se calcula siempre aquí y `order_deposits` es la única fuente de
 * verdad de lo abonado.
 *
 * Si el pedido se redujo por debajo de lo abonado, el excedente sale como
 * `overpaidUsd` en lugar de dejar un saldo negativo.
 */
export function orderBalance(totalUsd: Dec | string, deposits: OrderDeposit[]): OrderBalance {
  const total = dec(totalUsd, 'totalUsd');
  const active = activeDeposits(deposits);
  const depositUsd = usdScale(
    active.reduce((acc, d) => acc.plus(dec(d.usdEquivalent)), zero()),
    'depositUsd',
  );

  const raw = total.minus(depositUsd);
  const balanceUsd = Dec.max(zero(), raw.toDecimalPlaces(2, Dec.ROUND_HALF_UP));
  const overpaidUsd = Dec.max(zero(), raw.negated().toDecimalPlaces(2, Dec.ROUND_HALF_UP));

  let status: OrderPaymentStatus = 'sin_abono';
  if (depositUsd.gt(EPS)) status = balanceUsd.lte(EPS) ? 'pagado' : 'abonado';

  return { totalUsd: total, depositUsd, balanceUsd, overpaidUsd, status, deposits: active };
}

/**
 * Máquina de estados **monótona** del pedido (ARCHITECTURE.md §5).
 *
 * `pendiente(0) → preparacion(1) → listo(2) → procesado(3)`, y `cancelado` es una
 * rama terminal. Una transición offline que retrocede (llega `preparacion` cuando
 * el servidor ya está en `listo`) se **ignora y se audita**, no se aplica: así dos
 * dispositivos que empujan el pedido hacia adelante nunca pelean.
 */
export const STATUS_RANK = {
  pendiente: 0,
  preparacion: 1,
  listo: 2,
  procesado: 3,
  cancelado: 3,
} as const;

export type OrderStatusName = keyof typeof STATUS_RANK;

/** Estados terminales: no admiten más cambios (§5, rechazo permanente). */
export const TERMINAL_STATUSES: OrderStatusName[] = ['procesado', 'cancelado'];

export const isTerminal = (status: OrderStatusName) => TERMINAL_STATUSES.includes(status);

/** true si la transición avanza (o es la misma). */
export function advances(from: OrderStatusName, to: OrderStatusName): boolean {
  if (to === 'cancelado') return !isTerminal(from);
  return STATUS_RANK[to] >= STATUS_RANK[from];
}
