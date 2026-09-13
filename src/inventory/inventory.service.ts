import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InventoryMovement, Prisma } from '../generated/prisma/client';
import { MovementType } from '../generated/prisma/enums';
import { invalid, notFound } from '../common/errors';
import { Dec, dec, qty as qtyScale } from '../common/money';
import { movementOut } from '../common/serialize';
import { clampClientTime } from '../common/time';
import { Tx } from '../common/tx';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMovementDto, MovementsQueryDto } from './dto/movement.dto';

export interface ApplyMovementInput {
  /** Id del cliente: hace el asiento idempotente por PK. */
  id?: string;
  productId: string;
  type: MovementType;
  qty: Dec | number | string;
  reason: string;
  note?: string | null;
  userId: string;
  saleId?: string | null;
  orderId?: string | null;
  deviceId?: string | null;
  /** Momento de negocio; el servidor lo acota contra su reloj. */
  at?: Date;
}

/**
 * El ledger de inventario (ARCHITECTURE.md §3.6).
 *
 * `inventory_movements` es la fuente de verdad de la existencia y
 * `products.stock` su materialización: los dos se mueven **en la misma
 * transacción**, y `stock` no lo escribe ningún cliente. Los deltas conmutan, así
 * que el merge offline no pierde ventas.
 *
 * La regla que de verdad importa aquí: un `ajuste` se resuelve **en el momento de
 * aplicar**, no en el de capturar. Un ajuste creado offline a las 9:00 que llega
 * a las 18:00 no borra las ventas que ocurrieron entre medias.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Asienta el movimiento y mueve el stock. Exige un `tx`: no hay forma de
   * asentar el kardex sin mover la existencia en la misma transacción, que es la
   * invariante `SUM(delta) = products.stock`.
   */
  async apply(tx: Tx, input: ApplyMovementInput): Promise<InventoryMovement> {
    const id = input.id ?? randomUUID();

    // Idempotencia por PK: reenviar la misma mutación offline no duplica el
    // asiento ni mueve el stock dos veces.
    const existing = await tx.inventoryMovement.findUnique({ where: { id } });
    if (existing) return existing;

    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product) throw invalid(`El producto ${input.productId} no existe`);

    const captured = qtyScale(input.qty, 'cantidad');
    if (captured.lt(0)) throw invalid('La cantidad no puede ser negativa');
    if (input.type !== 'ajuste' && captured.lte(0)) {
      throw invalid('Una entrada o salida tiene que mover una cantidad mayor que cero');
    }

    const stockNow = dec(product.stock);

    // `delta` y `stockAfter` los calcula el SERVIDOR, nunca el cliente. Los CHECK
    // `inventory_movements_delta_ck` verifican esta misma aritmética en la base:
    //   entrada → delta = +qty · salida → delta = −qty · ajuste → stockAfter = qty
    let delta: Dec;
    let stockAfter: Dec;
    switch (input.type) {
      case 'entrada':
        delta = captured;
        stockAfter = stockNow.plus(captured);
        break;
      case 'salida':
        delta = captured.negated();
        stockAfter = stockNow.minus(captured);
        break;
      case 'ajuste':
        // Aquí está el "se resuelve al aplicar": el delta sale del stock ACTUAL,
        // no del que veía el dispositivo cuando se capturó.
        delta = captured.minus(stockNow);
        stockAfter = captured;
        break;
    }

    const at = clampClientTime(input.at).at;

    const movement = await tx.inventoryMovement.create({
      data: {
        id,
        productId: input.productId,
        type: input.type,
        qty: captured,
        delta: qtyScale(delta, 'delta'),
        stockAfter: qtyScale(stockAfter, 'stockAfter'),
        reason: input.reason.slice(0, 120),
        note: input.note ?? null,
        userId: input.userId,
        saleId: input.saleId ?? null,
        orderId: input.orderId ?? null,
        deviceId: input.deviceId ?? null,
        createdAt: at,
      },
    });

    // `stock` puede quedar negativo a propósito: un POS tiene que poder vender lo
    // que el conteo dice que no hay y cuadrarlo después con un ajuste.
    await tx.product.update({
      where: { id: input.productId },
      data: { stock: qtyScale(stockAfter, 'stock') },
    });

    return movement;
  }

  /** `POST /products/:id/movements` */
  async create(user: AuthUser, productId: string, dto: CreateMovementDto, deviceId?: string) {
    const movement = await this.prisma.$transaction((tx) =>
      this.apply(tx, {
        id: dto.id,
        productId,
        type: dto.type,
        qty: dto.qty,
        reason: dto.reason,
        note: dto.note,
        userId: user.id,
        deviceId: deviceId ?? null,
        at: dto.createdAt ? new Date(dto.createdAt) : undefined,
      }),
    );

    await this.audit.log(user, 'movimiento_inventario', 'product', productId, {
      qty: dto.qty,
      type: dto.type,
      reason: dto.reason,
    });

    return movementOut(movement);
  }

  async list(query: MovementsQueryDto) {
    const where: Prisma.InventoryMovementWhereInput = {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.inventoryMovement.count({ where }),
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { page: query.page, pageSize: query.pageSize, total, items: rows.map(movementOut) };
  }

  /**
   * Reconciliación `stock` vs ledger (§3.6). Debería devolver siempre vacío; si
   * devuelve algo, hay una escritura de `stock` fuera de este servicio.
   */
  async reconcile() {
    const rows = await this.prisma.$queryRaw<
      { id: string; code: string; stock: string; ledger: string; descuadre: string }[]
    >`
      SELECT p.id, p.code, p.stock::text AS stock,
             COALESCE(SUM(m.delta), 0)::text AS ledger,
             (p.stock - COALESCE(SUM(m.delta), 0))::text AS descuadre
        FROM products p
        LEFT JOIN inventory_movements m ON m.product_id = p.id
       GROUP BY p.id, p.code, p.stock
      HAVING p.stock <> COALESCE(SUM(m.delta), 0)
    `;
    return { ok: rows.length === 0, mismatches: rows };
  }

  async productOrFail(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw notFound('El producto');
    return product;
  }
}
