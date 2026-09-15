import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors';
import {
  auditOut,
  closureOut,
  customerOut,
  priceGroupOut,
  productOut,
  rateOut,
} from '../../common/serialize';
import { parsePayload } from '../../common/validate-payload';
import { CreatePriceGroupDto, UpdatePriceGroupDto } from '../../catalog/dto/catalog.dto';
import {
  CreateProductDto,
  SetPriceDto,
  UpdateProductDto,
} from '../../catalog/dto/product.dto';
import { PriceGroupsService } from '../../catalog/price-groups.service';
import { ProductsService } from '../../catalog/products.service';
import { ClosuresService } from '../../closures/closures.service';
import { CreateClosureDto } from '../../closures/dto/closure.dto';
import { CustomersService } from '../../customers/customers.service';
import { CreateCustomerDto, UpdateCustomerDto } from '../../customers/dto/customer.dto';
import { CreateRateDto } from '../../rates/dto/rate.dto';
import { RatesService } from '../../rates/rates.service';
import { HandlerOutcome, MutationContext, MutationHandler } from '../sync.types';
import { omit, requireId } from './money.handlers';

/**
 * Handlers del catálogo, clientes, tasas, cierres y bitácora.
 *
 * Todo lo que hay aquí resuelve conflictos con la regla que le toca según §5:
 * LWW por campo en productos y clientes, LWW por celda en precios, fusión por
 * cédula en clientes, append-only idempotente en tasas y bitácora, y "gana el
 * primero" en el cierre del día.
 */
@Injectable()
export class CatalogHandlers {
  constructor(
    private readonly products: ProductsService,
    private readonly priceGroups: PriceGroupsService,
    private readonly customers: CustomersService,
    private readonly rates: RatesService,
    private readonly closures: ClosuresService,
  ) {}

  handlers(): Record<string, MutationHandler> {
    return {
      'customer.create': (ctx) => this.customerCreate(ctx),
      'customer.update': (ctx) => this.customerUpdate(ctx),
      'product.create': (ctx) => this.productCreate(ctx),
      'product.update': (ctx) => this.productUpdate(ctx),
      'productPrice.set': (ctx) => this.productPriceSet(ctx),
      'priceGroupPrice.set': (ctx) => this.priceGroupPriceSet(ctx),
      'priceGroup.create': (ctx) => this.priceGroupCreate(ctx),
      'priceGroup.update': (ctx) => this.priceGroupUpdate(ctx),
      'rate.create': (ctx) => this.rateCreate(ctx),
      'closure.create': (ctx) => this.closureCreate(ctx),
      'audit.append': (ctx) => this.auditAppend(ctx),
    };
  }

  /**
   * `customer.create`. Alta con cédula ya existente ⇒ **se fusiona** con la fila
   * existente y la respuesta trae `idMap` para que el cliente reapunte sus pedidos
   * y ventas locales (§5).
   */
  private async customerCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const dto = parsePayload(CreateCustomerDto, ctx.payload);
    const { customer, merged, idMap } = await this.customers.create(ctx.user, dto, { db: ctx.tx });

    return {
      status: 'applied',
      entityId: customer.id,
      serverEntity: customerOut(customer),
      idMap,
      reason: merged ? 'fusionado por cédula' : undefined,
    };
  }

  /** `customer.update`. Parche con LWW por campo. */
  private async customerUpdate(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = requireId(ctx.payload, 'customerId');
    const dto = parsePayload(UpdateCustomerDto, omit(ctx.payload, ['customerId', 'id']));

    const customer = await this.customers.update(ctx.user, id, dto, {
      db: ctx.tx,
      // LWW por campo: el parche gana sin comparar `rev`. Sólo compite el mismo
      // campo, y para eso el último en escribir es la respuesta acordada (§5).
      ifMatch: null,
    });

    return { status: 'applied', entityId: customer.id, serverEntity: customerOut(customer) };
  }

  /**
   * `product.create`. Un `code` repetido se **recodifica** (dos dispositivos
   * offline pueden generar el mismo) y se devuelve `renumbered`; un código
   * retirado es rechazo permanente.
   */
  private async productCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const dto = parsePayload(CreateProductDto, ctx.payload);
    const { product, renumbered } = await this.products.create(ctx.user, dto, {
      db: ctx.tx,
      allowRecode: true,
    });

    return {
      status: 'applied',
      entityId: product.id,
      serverEntity: productOut(product),
      renumbered,
    };
  }

  /** `product.update`. Parche con LWW por campo; `stock` no es escribible. */
  private async productUpdate(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = requireId(ctx.payload, 'productId');
    const dto = parsePayload(UpdateProductDto, omit(ctx.payload, ['productId', 'id', 'stock']));

    const product = await this.products.update(ctx.user, id, dto, { db: ctx.tx, ifMatch: null });
    return { status: 'applied', entityId: product.id, serverEntity: productOut(product) };
  }

  /** `productPrice.set`. LWW **por celda** `(producto, tipo de precio)`. */
  private async productPriceSet(ctx: MutationContext): Promise<HandlerOutcome> {
    const productId = requireId(ctx.payload, 'productId');
    const dto = parsePayload(SetPriceDto, omit(ctx.payload, ['productId', 'id']));

    const product = await this.products.setPrice(ctx.user, productId, dto, { db: ctx.tx });
    return { status: 'applied', entityId: product.id, serverEntity: productOut(product) };
  }

  /**
   * `priceGroupPrice.set`. LWW por celda: Mayor y Detal sobreviven los dos.
   *
   * @deprecated 2026-09 · Grupos de precio retirados. Los tres handlers de
   * `priceGroup*` se mantienen registrados sólo mientras queden clientes v5:
   * retirarlos haría que `MutationRegistry.resolve` devolviera `validation_failed`,
   * un rechazo **permanente**, y el cliente descartaría la edición encolada en vez
   * de reintentarla. Ver `PriceGroupsService`.
   */
  private async priceGroupPriceSet(ctx: MutationContext): Promise<HandlerOutcome> {
    const priceGroupId = requireId(ctx.payload, 'priceGroupId');
    const dto = parsePayload(SetPriceDto, omit(ctx.payload, ['priceGroupId', 'id']));

    const group = await this.priceGroups.setPrice(ctx.user, priceGroupId, dto, { db: ctx.tx });
    return { status: 'applied', entityId: group.id, serverEntity: priceGroupOut(group) };
  }

  private async priceGroupCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const dto = parsePayload(CreatePriceGroupDto, ctx.payload);
    const group = await this.priceGroups.create(ctx.user, dto, { db: ctx.tx });
    return { status: 'applied', entityId: group.id, serverEntity: priceGroupOut(group) };
  }

  private async priceGroupUpdate(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = requireId(ctx.payload, 'priceGroupId');
    const dto = parsePayload(UpdatePriceGroupDto, omit(ctx.payload, ['priceGroupId', 'id']));

    const group = await this.priceGroups.update(ctx.user, id, dto, { db: ctx.tx, ifMatch: null });
    return { status: 'applied', entityId: group.id, serverEntity: priceGroupOut(group) };
  }

  /**
   * `rate.create`. Append-only e idempotente por PK: varias tasas de la misma
   * fuente coexisten, es un log. La vigente es la de `createdAt` mayor.
   */
  private async rateCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const dto = parsePayload(CreateRateDto, ctx.payload);

    const existing = dto.id
      ? await ctx.tx.exchangeRate.findUnique({ where: { id: dto.id } })
      : null;

    const rate = await this.rates.publish(
      {
        id: dto.id,
        source: dto.source,
        value: dto.value,
        automatic: false,
        userId: ctx.user.id,
        createdAt: ctx.clientAt,
      },
      ctx.tx,
    );

    return {
      status: existing ? 'duplicate' : 'applied',
      entityId: rate.id,
      serverEntity: rateOut(rate),
    };
  }

  /**
   * `closure.create`. Si ese día ya tiene cierre, **gana el primero** y se
   * devuelve el existente como `rejected`/`already_closed`: es permanente, el
   * cliente saca la mutación de la cola y adopta el cierre del servidor (§5).
   */
  private async closureCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const dto = parsePayload(CreateClosureDto, ctx.payload);
    const { closure, alreadyClosed } = await this.closures.create(ctx.user, dto, { db: ctx.tx });

    if (alreadyClosed) {
      return {
        status: 'rejected',
        entityId: closure.id,
        serverEntity: closureOut(closure),
        reason: 'already_closed',
      };
    }
    return { status: 'applied', entityId: closure.id, serverEntity: closureOut(closure) };
  }

  /**
   * `audit.append`. El cliente sube sus asientos offline; append-only e
   * idempotente por PK.
   *
   * El `userId` del asiento es **el del usuario autenticado**, no el que venga en
   * el payload: aceptar la identidad del cliente permitiría firmar asientos en
   * nombre de otro, y una bitácora que se puede falsificar no prueba nada.
   */
  private async auditAppend(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = typeof ctx.payload.id === 'string' && ctx.payload.id ? ctx.payload.id : randomUUID();

    const existing = await ctx.tx.auditLog.findUnique({ where: { id } });
    if (existing) {
      return { status: 'duplicate', entityId: id, serverEntity: auditOut(existing) };
    }

    const action = requireString(ctx.payload, 'action', 60);
    const entity = requireString(ctx.payload, 'entity', 40);
    const entityId = requireString(ctx.payload, 'entityId', 64);

    const created = await ctx.tx.auditLog.create({
      data: {
        id,
        userId: ctx.user.id,
        userName: ctx.user.fullName,
        action,
        entity,
        entityId,
        data: parseAuditData(ctx.payload.data),
        deviceId: ctx.deviceId,
        createdAt: ctx.clientAt,
      },
    });

    return { status: 'applied', entityId: id, serverEntity: auditOut(created) };
  }
}

function requireString(payload: Record<string, unknown>, key: string, max: number): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('validation_failed', `El payload necesita ${key}`);
  }
  return value.slice(0, max);
}

/**
 * El frontend produce `AuditLog.data` como **string JSON**; la columna es jsonb.
 * Se acepta las dos formas: si es un string parseable, se guarda el objeto; si no,
 * se envuelve para no perder el contenido.
 */
function parseAuditData(raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') return raw as never;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as never;
    } catch {
      return { raw } as never;
    }
  }
  return { raw } as never;
}
