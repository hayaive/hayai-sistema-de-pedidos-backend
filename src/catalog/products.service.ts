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
import { COLD_CAKE_GENERIC_GROUP_ID } from './catalog.constants';
import {
  ComboItemInputDto,
  CreateProductDto,
  PriceInputDto,
  ProductsQueryDto,
  SetPriceDto,
  UpdateProductDto,
} from './dto/product.dto';

export type ProductAggregate = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly company: CompanyService,
    private readonly tombstones: TombstonesService,
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
   * cliente necesita reapuntar su copia local (§3.1).
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
      if (dto.priceGroupId) await this.assertPriceGroup(tx, dto.priceGroupId);

      await this.assertCodeNotRetired(tx, dto.code);
      let code = dto.code;
      let renumbered: { from: string; to: string } | undefined;
      const taken = await tx.product.findUnique({ where: { code }, select: { id: true } });
      if (taken) {
        if (!opts.allowRecode) {
          throw new AppError('conflict', `El código ${code} ya está en uso`);
        }
        code = await this.nextFreeCode(tx, code);
        renumbered = { from: dto.code, to: code };
      }

      if (dto.bsOnly && (dto.bsPrice === undefined || dto.bsPrice === null)) {
        throw invalid('Un producto con precio fijado en Bs necesita bsPrice');
      }

      // Invariante del catálogo: un producto de la familia de tortas frías sin
      // grupo propio entra al precio general, si ese grupo existe. Sin esto, un
      // producto nuevo añadiría una cuarta unidad de precio a una familia que
      // debe tener exactamente tres (`catalog.attachDefaultPriceGroup`).
      const priceGroupId = await this.defaultPriceGroup(tx, dto.categoryId, dto.priceGroupId);

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
      if (dto.priceGroupId) await this.assertPriceGroup(tx, dto.priceGroupId);
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
      if (dto.priceGroupId !== undefined) {
        data.priceGroup = dto.priceGroupId
          ? { connect: { id: dto.priceGroupId } }
          : { disconnect: true };
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
   * Siguiente código libre de la serie (`P001`, `P002`…). Los **retirados cuentan
   * como ocupados** aunque su producto ya no exista (`catalog.nextFreeCode`).
   */
  async nextFreeCode(tx: Tx, preferred: string): Promise<string> {
    const [products, retired] = await Promise.all([
      tx.product.findMany({ select: { code: true } }),
      tx.retiredProductCode.findMany({ select: { code: true } }),
    ]);
    const used = new Set([...products.map((p) => p.code), ...retired.map((r) => r.code)]);

    if (!used.has(preferred)) return preferred;
    for (let n = 1; n < 1000; n++) {
      const candidate = 'P' + String(n).padStart(3, '0');
      if (!used.has(candidate)) return candidate;
    }
    return `P-${randomUUID().slice(0, 8)}`;
  }

  private async defaultPriceGroup(
    tx: Tx,
    categoryId: string,
    declared?: string,
  ): Promise<string | null> {
    if (declared) return declared;
    const company = await this.company.settings(tx);
    if (!company.coldCakeCategoryId || categoryId !== company.coldCakeCategoryId) return null;
    const generic = await tx.priceGroup.findUnique({
      where: { id: COLD_CAKE_GENERIC_GROUP_ID },
      select: { id: true },
    });
    return generic?.id ?? null;
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

  private async assertPriceGroup(tx: Tx, id: string): Promise<void> {
    const row = await tx.priceGroup.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw invalid(`El grupo de precio ${id} no existe`);
  }

  private async assertPriceType(tx: Tx, id: string): Promise<void> {
    const row = await tx.priceType.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw invalid(`El tipo de precio ${id} no existe`);
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
