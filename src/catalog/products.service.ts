import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, Product } from '../generated/prisma/client';
import { AppError, invalid, notFound } from '../common/errors';
import { PRODUCT_INCLUDE } from '../common/includes';
import { qty as qtyScale, usd as usdScale } from '../common/money';
import { productOut } from '../common/serialize';
import { Tx } from '../common/tx';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { CompanyService } from '../company/company.service';
import { PrismaService } from '../prisma/prisma.service';
import { TombstonesService } from '../sync/tombstones.service';
import {
  ComboItemInputDto,
  CreateProductDto,
  PriceInputDto,
  ProductsQueryDto,
  SetPriceDto,
  UpdateProductDto,
} from './dto/product.dto';
import { nextProductCode } from './product-code';

export type ProductAggregate = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
    private readonly company: CompanyService,
  ) {}

  /** Relee la raíz para devolver su `rev` nuevo tras tocar filas hijas (§4.3). */
  async aggregate(id: string, db: Tx | PrismaService = this.prisma): Promise<ProductAggregate> {
    const row = await db.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!row) throw notFound('El producto');
    return row;
  }

  async list(query: ProductsQueryDto) {
    const where: Prisma.ProductWhereInput = {
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.active !== undefined ? { active: query.active === 'true' } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: [{ code: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map(productOut),
    };
  }

  async getOne(id: string) {
    return productOut(await this.aggregate(id));
  }

  /**
   * Alta de producto.
   *
   * Devuelve además `renumbered` cuando hubo que recodificar: dos dispositivos
   * offline pueden generar el mismo `code`, que es una clave de negocio, y el
   * cliente necesita reapuntar su copia local (§3.1). Con `allowRecode` (vía
   * sync) un código **retirado** se recodifica igual que uno tomado, en vez de
   * rechazarse: perder el producto entero por un choque de nombres offline es
   * peor que reasignarle un código libre. La vía HTTP directa (sin
   * `allowRecode`) sigue devolviendo 409 `retired_code`/`conflict`.
   */
  async create(
    user: AuthUser,
    dto: CreateProductDto,
    opts: { db?: Tx; allowRecode?: boolean } = {},
  ): Promise<{ product: ProductAggregate; renumbered?: { from: string; to: string } }> {
    const run = async (tx: Tx) => {
      const id = dto.id ?? randomUUID();

      // PK repetida no es un error: es un reenvío (§3.1). El llamador decide si
      // eso es `duplicate` (sync) o un 409 (HTTP).
      const existing = await tx.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
      if (existing) return { product: existing };

      await this.assertCategory(tx, dto.categoryId);
      const priceGroupId = await this.resolvePriceGroup(tx, dto.priceGroupId);

      // Un código retirado o ya tomado se trata igual cuando `allowRecode`
      // viene de la vía de sync (§5, ARCHITECTURE.md): dos dispositivos
      // offline pueden generar el mismo código, o reusar sin saberlo uno que
      // ya se retiró, y el producto no se pierde por eso, se recodifica. La
      // vía HTTP directa (sin `allowRecode`) sigue rechazando ambos casos: un
      // humano tecleando un código sabe cuál quería.
      let code = dto.code;
      let renumbered: { from: string; to: string } | undefined;
      const retired = await tx.retiredProductCode.findUnique({ where: { code } });
      const taken = retired
        ? null
        : await tx.product.findUnique({ where: { code }, select: { id: true } });
      if (retired || taken) {
        if (!opts.allowRecode) {
          if (retired) {
            throw new AppError(
              'retired_code',
              `El código ${code} está retirado y no se puede reutilizar`,
              { formerName: retired.formerName },
            );
          }
          throw new AppError('conflict', `El código ${code} ya está en uso`);
        }
        code = await this.nextFreeCode(tx);
        renumbered = { from: dto.code, to: code };
      }

      if (dto.bsOnly && (dto.bsPrice === undefined || dto.bsPrice === null)) {
        throw invalid('Un producto con precio fijado en Bs necesita bsPrice');
      }

      // Un producto nuevo NUNCA se engancha solo a un grupo de precio: desde
      // 2026-09 cada producto tiene precio propio en `product_prices` y el
      // mecanismo de grupos está retirado. El campo se sigue aceptando sólo si el
      // cliente lo declara y el grupo todavía existe (ver `resolvePriceGroup`),
      // mientras la columna exista (compatibilidad v5).
      await tx.product.create({
        data: {
          id,
          code,
          name: dto.name.trim(),
          description: dto.description ?? null,
          categoryId: dto.categoryId,
          imageUrl: dto.imageUrl ?? null,
          // `stock` arranca en 0 siempre: se mueve con movimientos de inventario.
          minStock: qtyScale(dto.minStock ?? 0, 'minStock'),
          active: dto.active ?? true,
          bsOnly: dto.bsOnly ?? false,
          bsPrice: dto.bsPrice === undefined ? null : usdScale(dto.bsPrice, 'bsPrice'),
          bsPrices: dto.bsPrices?.length ? await this.bsPricesJson(tx, dto.bsPrices) : undefined,
          priceBand: dto.priceBand ?? false,
          priceGroupId,
          isCombo: dto.isCombo ?? false,
          allowCustomization: dto.allowCustomization ?? false,
          customizationPrice:
            dto.customizationPrice === undefined
              ? null
              : usdScale(dto.customizationPrice, 'customizationPrice'),
        },
      });

      // Si el id se había borrado antes, su tombstone tiene que irse en la MISMA
      // transacción (§4.4).
      await this.tombstones.clear('product', id, tx);

      if (dto.prices?.length) await this.writePrices(tx, id, dto.prices);
      if (dto.comboItems?.length) await this.writeComboItems(tx, id, dto.comboItems);

      // Relectura obligatoria: los triggers de las hijas ya movieron el `rev`.
      return { product: await this.aggregate(id, tx), renumbered };
    };

    const result = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);
    await this.audit.log(user, 'producto_creado', 'product', result.product.id, {
      code: result.product.code,
      ...(result.renumbered ? { renumbered: result.renumbered } : {}),
    });
    return result;
  }

  /**
   * Parche con LWW por campo. `stock` no es escribible; `code` se valida contra
   * los códigos retirados (el trigger lo impediría igual, pero aquí el mensaje
   * sirve de algo).
   */
  async update(
    user: AuthUser,
    id: string,
    dto: UpdateProductDto,
    opts: { db?: Tx; ifMatch?: number | null } = {},
  ): Promise<ProductAggregate> {
    const run = async (tx: Tx) => {
      const current = await tx.product.findUnique({ where: { id } });
      if (!current) throw notFound('El producto');

      if (opts.ifMatch !== undefined && opts.ifMatch !== null && current.rev !== opts.ifMatch) {
        throw new AppError('conflict', 'El producto cambió en otro dispositivo', {
          serverEntity: productOut(await this.aggregate(id, tx)),
        });
      }

      if (dto.categoryId) await this.assertCategory(tx, dto.categoryId);
      if (dto.code && dto.code !== current.code) await this.assertCodeNotRetired(tx, dto.code);

      const data: Prisma.ProductUpdateInput = {};
      if (dto.code !== undefined) data.code = dto.code;
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (dto.description !== undefined) data.description = dto.description || null;
      if (dto.categoryId !== undefined) data.category = { connect: { id: dto.categoryId } };
      if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl || null;
      if (dto.minStock !== undefined) data.minStock = qtyScale(dto.minStock, 'minStock');
      if (dto.active !== undefined) data.active = dto.active;
      if (dto.bsOnly !== undefined) data.bsOnly = dto.bsOnly;
      if (dto.bsPrice !== undefined)
        data.bsPrice = dto.bsPrice === null ? null : usdScale(dto.bsPrice, 'bsPrice');
      if (dto.bsPrices !== undefined) data.bsPrices = await this.bsPricesJson(tx, dto.bsPrices);
      if (dto.priceBand !== undefined) data.priceBand = dto.priceBand;
      if (dto.priceGroupId !== undefined) {
        // `priceGroupId: null` es justo lo que manda la migración v6 del cliente
        // para desvincular; un id que ya no existe acaba igual (ver
        // `resolvePriceGroup`) en lugar de rechazar la mutación.
        const groupId = await this.resolvePriceGroup(tx, dto.priceGroupId);
        data.priceGroup = groupId ? { connect: { id: groupId } } : { disconnect: true };
      }
      if (dto.isCombo !== undefined) data.isCombo = dto.isCombo;
      if (dto.allowCustomization !== undefined) data.allowCustomization = dto.allowCustomization;
      if (dto.customizationPrice !== undefined) {
        data.customizationPrice =
          dto.customizationPrice === null
            ? null
            : usdScale(dto.customizationPrice, 'customizationPrice');
      }

      // El CHECK `products_bs_only_needs_price_ck` lo exige; se comprueba antes
      // para dar un mensaje de negocio en lugar de un error de la base.
      const bsOnly = dto.bsOnly ?? current.bsOnly;
      const bsPrice = dto.bsPrice !== undefined ? dto.bsPrice : current.bsPrice;
      if (bsOnly && (bsPrice === null || bsPrice === undefined)) {
        throw invalid('Un producto con precio fijado en Bs necesita bsPrice');
      }

      if (Object.keys(data).length) await tx.product.update({ where: { id }, data });

      // `prices` y `comboItems` se reemplazan en bloque cuando vienen: son
      // listas, y fusionarlas duplicaría o perdería líneas. La granularidad por
      // celda existe aparte, en `setProductPrice`.
      if (dto.prices) await this.writePrices(tx, id, dto.prices, { replace: true });
      if (dto.comboItems) await this.writeComboItems(tx, id, dto.comboItems, { replace: true });

      return this.aggregate(id, tx);
    };

    const product = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);
    await this.audit.log(user, 'producto_editado', 'product', id, { fields: Object.keys(dto) });
    return product;
  }

  /**
   * `DELETE /products/:id` → 409 si tiene historial; retira el código.
   *
   * El historial bloquea el borrado porque las FK son `ON DELETE RESTRICT` y
   * porque una referencia huérfana en el frontend no da error: da **pérdida
   * silenciosa de stock** (`applyMovement` hace `if (!p) return`, §3.3).
   */
  async remove(user: AuthUser, id: string, opts: { db?: Tx } = {}): Promise<void> {
    const run = async (tx: Tx) => {
      const product = await tx.product.findUnique({ where: { id } });
      if (!product) throw notFound('El producto');

      const [saleItems, orderItems, movements, comboUsages] = await Promise.all([
        tx.saleItem.count({ where: { productId: id } }),
        tx.orderItem.count({ where: { productId: id } }),
        tx.inventoryMovement.count({ where: { productId: id } }),
        tx.comboItem.count({ where: { componentProductId: id } }),
      ]);

      if (saleItems || orderItems || movements) {
        throw new AppError(
          'has_history',
          'El producto tiene historial y no se puede borrar: desactívalo (active = false)',
          { saleItems, orderItems, movements },
        );
      }
      if (comboUsages) {
        throw new AppError('has_history', 'El producto forma parte de un combo', { comboUsages });
      }

      // El código se retira ANTES de borrar el producto: si se hiciera después y
      // la transacción fallara a medias, el código volvería a circular y un
      // comprobante viejo pasaría a resolver a otro producto (§3.5).
      await tx.retiredProductCode.upsert({
        where: { code: product.code },
        create: {
          code: product.code,
          formerName: product.name,
          formerProductId: product.id,
          reason: 'Producto eliminado desde la API',
        },
        update: {},
      });

      await tx.product.delete({ where: { id } });
      await this.tombstones.record('product', id, user.id, tx);
    };

    if (opts.db) await run(opts.db);
    else await this.prisma.$transaction(run);

    await this.audit.log(user, 'producto_eliminado', 'product', id);
  }

  /**
   * `productPrice.set`: LWW **por celda** `(producto, tipo de precio)`. Dos
   * dispositivos que cambian Mayor y Detal sobreviven los dos (§5).
   */
  async setPrice(
    user: AuthUser,
    productId: string,
    dto: SetPriceDto,
    opts: { db?: Tx } = {},
  ): Promise<ProductAggregate> {
    const run = async (tx: Tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) throw notFound('El producto');
      await this.assertPriceType(tx, dto.priceTypeId);

      await tx.productPrice.upsert({
        where: { productId_priceTypeId: { productId, priceTypeId: dto.priceTypeId } },
        create: { productId, priceTypeId: dto.priceTypeId, amount: usdScale(dto.amount, 'precio') },
        update: { amount: usdScale(dto.amount, 'precio') },
      });

      // El trigger `product_prices_bump_parent` ya movió el `rev` del producto.
      return this.aggregate(productId, tx);
    };

    const product = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);
    await this.audit.log(user, 'precio_producto', 'product', productId, {
      priceTypeId: dto.priceTypeId,
      amount: dto.amount,
    });
    return product;
  }

  // ── Auxiliares ─────────────────────────────────────────────────────────────

  /**
   * Código sugerido: el menor número libre ≥ piso en la serie configurable de
   * Ajustes (`company_settings.product_code_prefix/digits/start`, decisión de
   * J.O.R.B.I). El piso **no es un contador**: esta lectura no lo avanza, así
   * que dar de alta un producto nunca mueve `company_settings.rev`. Los
   * **retirados cuentan como ocupados** aunque su producto ya no exista.
   */
  async nextFreeCode(tx: Tx): Promise<string> {
    const [settings, products, retired] = await Promise.all([
      this.company.settings(tx),
      tx.product.findMany({ select: { code: true } }),
      tx.retiredProductCode.findMany({ select: { code: true } }),
    ]);
    const used = [...products.map((p) => p.code), ...retired.map((r) => r.code)];

    return nextProductCode(used, {
      prefix: settings.productCodePrefix,
      digits: settings.productCodeDigits,
      start: settings.productCodeStart,
    });
  }

  private async assertCodeNotRetired(tx: Tx, code: string): Promise<void> {
    const retired = await tx.retiredProductCode.findUnique({ where: { code } });
    if (retired) {
      throw new AppError(
        'retired_code',
        `El código ${code} está retirado y no se puede reutilizar`,
        { formerName: retired.formerName },
      );
    }
  }

  private async assertCategory(tx: Tx, id: string): Promise<void> {
    const row = await tx.category.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw invalid(`La categoría ${id} no existe`);
  }

  /**
   * El grupo de precio que declara el cliente, o `null`.
   *
   * @deprecated 2026-09 · Grupos de precio retirados. Un id **desconocido ya no
   * se rechaza**: se degrada a `null`. Antes lanzaba `validation_failed`, que el
   * cliente trata como rechazo **permanente** (`push.service.PERMANENT`) y le
   * hace descartar la mutación de la cola. Después de la migración de datos que
   * limpia `price_groups`, un v5 con un `product.create` encolado apuntando al
   * grupo genérico perdería el producto entero por un campo que ya no significa
   * nada — exactamente lo que se quiere evitar manteniendo vivas las rutas de
   * compatibilidad (ver `PriceGroupsService`). La FK de la columna es
   * `onDelete: SetNull`, así que guardar `null` es lo que la base habría hecho
   * sola al borrarse el grupo.
   */
  private async resolvePriceGroup(tx: Tx, id?: string | null): Promise<string | null> {
    if (!id) return null;
    const row = await tx.priceGroup.findUnique({ where: { id }, select: { id: true } });
    return row?.id ?? null;
  }

  private async assertPriceType(tx: Tx, id: string): Promise<void> {
    const row = await tx.priceType.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw invalid(`El tipo de precio ${id} no existe`);
  }

  /**
   * Precios en Bs por tipo de precio de un producto `bsOnly` (Mayor, Detal…),
   * validados igual que `prices` —tipos existentes y sin repetir— y guardados
   * como arreglo JSON `[{ priceTypeId, amount }]` con los montos en Bs.
   *
   * Viven aparte de `product_prices` (que son USD) para no reinterpretar la
   * moneda de filas existentes. Un producto `bsOnly` sin esta lista sigue
   * usando `bs_price` para todos los tipos, como antes.
   */
  private async bsPricesJson(tx: Tx, prices: PriceInputDto[]): Promise<Prisma.InputJsonValue> {
    const ids = new Set<string>();
    for (const p of prices) {
      if (ids.has(p.priceTypeId)) throw invalid(`El tipo de precio ${p.priceTypeId} viene repetido`);
      ids.add(p.priceTypeId);
      await this.assertPriceType(tx, p.priceTypeId);
    }
    return prices.map((p) => ({
      priceTypeId: p.priceTypeId,
      amount: usdScale(p.amount, 'precio en Bs').toNumber(),
    }));
  }

  private async writePrices(
    tx: Tx,
    productId: string,
    prices: PriceInputDto[],
    opts: { replace?: boolean } = {},
  ): Promise<void> {
    const ids = new Set<string>();
    for (const p of prices) {
      if (ids.has(p.priceTypeId)) throw invalid(`El tipo de precio ${p.priceTypeId} viene repetido`);
      ids.add(p.priceTypeId);
      await this.assertPriceType(tx, p.priceTypeId);
    }

    if (opts.replace) {
      await tx.productPrice.deleteMany({
        where: { productId, priceTypeId: { notIn: [...ids] } },
      });
    }

    for (const p of prices) {
      await tx.productPrice.upsert({
        where: { productId_priceTypeId: { productId, priceTypeId: p.priceTypeId } },
        create: { productId, priceTypeId: p.priceTypeId, amount: usdScale(p.amount, 'precio') },
        update: { amount: usdScale(p.amount, 'precio') },
      });
    }
  }

  /** Los combos se reemplazan en bloque: `position` es su orden declarado. */
  private async writeComboItems(
    tx: Tx,
    comboProductId: string,
    items: ComboItemInputDto[],
    opts: { replace?: boolean } = {},
  ): Promise<void> {
    if (opts.replace) await tx.comboItem.deleteMany({ where: { comboProductId } });

    for (const [index, item] of items.entries()) {
      if (item.productId) {
        const component = await tx.product.findUnique({
          where: { id: item.productId },
          select: { id: true },
        });
        if (!component) throw invalid(`El componente ${item.productId} no existe`);
      }
      await tx.comboItem.create({
        data: {
          id: randomUUID(),
          comboProductId,
          position: index,
          description: item.description,
          qty: qtyScale(item.qty, 'cantidad del combo'),
          componentProductId: item.productId ?? null,
        },
      });
    }
  }
}
