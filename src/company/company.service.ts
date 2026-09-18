import { Injectable } from '@nestjs/common';
import { CompanySettings } from '../generated/prisma/client';
import { AppError, invalid, notFound } from '../common/errors';
import { Tx } from '../common/tx';
import { companyOut } from '../common/serialize';
import { bs as bsScale, Dec, dec, usd as usdScale } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { UpdateCompanyDto } from './dto/update-company.dto';

export const SINGLETON = 'singleton';

@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async settings(db: Tx | PrismaService = this.prisma): Promise<CompanySettings> {
    const row = await db.companySettings.findUnique({ where: { id: SINGLETON } });
    // La migración inicial inserta la fila; si falta, la base no está migrada.
    if (!row) throw notFound('La configuración de la empresa');
    return row;
  }

  async get() {
    return companyOut(await this.settings());
  }

  /** Zona con la que la base calcula el día contable. */
  async timezone(): Promise<string> {
    return (await this.settings()).timezone;
  }

  /**
   * `PATCH /company` con bloqueo optimista. `If-Match` es **obligatorio** aquí
   * (§6.7): la configuración la edita un humano desde varias pestañas y un
   * último-en-escribir-gana silencioso borraría ajustes del otro.
   */
  async update(user: AuthUser, dto: UpdateCompanyDto, ifMatch: number | null) {
    if (ifMatch === null) {
      throw new AppError(
        'precondition_required',
        'PATCH /company exige If-Match con el rev actual',
      );
    }

    const current = await this.settings();
    if (current.rev !== ifMatch) {
      throw new AppError('conflict', 'La configuración cambió en otro dispositivo', {
        serverEntity: companyOut(current),
      });
    }

    // `saleNext`/`orderPrefix`… la numeración es propiedad del servidor y no se
    // acepta de un cliente (§5). El DTO tampoco los declara, pero el filtro
    // explícito deja la regla escrita donde se aplica.
    const data: Record<string, unknown> = {};
    const assign = <K extends keyof UpdateCompanyDto>(key: K, column = key as string) => {
      if (dto[key] !== undefined) data[column] = dto[key];
    };

    assign('name');
    assign('logoUrl');
    assign('phone');
    assign('address');
    assign('taxId');
    assign('ticketFooter');
    assign('salePrefix');
    assign('orderPrefix');
    assign('productCodePrefix');
    assign('productCodeDigits');
    assign('productCodeStart');
    assign('timezone');
    assign('rateMaxAgeHours');
    assign('shortcuts');

    if (dto.coldCakeMin !== undefined) data.coldCakeMin = usdScale(dto.coldCakeMin, 'coldCakeMin');
    if (dto.coldCakeMax !== undefined) data.coldCakeMax = usdScale(dto.coldCakeMax, 'coldCakeMax');
    if (dto.bsRounding !== undefined) data.bsRounding = bsScale(dto.bsRounding, 'bsRounding');

    // `coldCakeCategory` ya NO se escribe. Desde 2026-09 la banda mínimo/máximo
    // no aplica a la categoría entera sino sólo al producto genérico "Tortas
    // Frías" (`PricingService.ruleOf`), así que `cold_cake_category_id` se quedó
    // sin lectores. El campo tampoco se declara ya en el DTO: el ValidationPipe
    // (`whitelist: true`, sin `forbidNonWhitelisted`) lo descarta en silencio, de
    // modo que un cliente v5 que lo siga mandando guarda el resto de sus ajustes
    // sin error en lugar de recibir un 400. La columna sigue en el esquema y se
    // sigue devolviendo en `companyOut` hasta que se retire en una fase posterior.

    // El CHECK `price_groups_target_ge_min_ck` tiene su gemelo aquí: la
    // migración v2 del frontend existió para arreglar un objetivo por debajo del
    // umbral, así que se valida antes de tocar la base y con un mensaje útil.
    const min = dec((data.coldCakeMin as Dec | undefined) ?? current.coldCakeMin);
    const max = dec((data.coldCakeMax as Dec | undefined) ?? current.coldCakeMax);
    if (max.lt(min)) {
      throw invalid('coldCakeMax (precio objetivo) no puede ser menor que coldCakeMin (umbral)');
    }

    const updated = await this.prisma.companySettings.update({ where: { id: SINGLETON }, data });
    await this.audit.log(user, 'ajustes_editados', 'company', SINGLETON, {
      fields: Object.keys(data),
    });
    return companyOut(updated);
  }

  /**
   * Asigna el siguiente número de venta **dentro de la transacción**.
   * `UPDATE … RETURNING` serializa por bloqueo de fila, que a este volumen es de
   * sobra (§3.2).
   *
   * El bucle cubre el caso de un contador que quedó por detrás de lo ya emitido
   * (típico tras la importación inicial): se salta los números ocupados en lugar
   * de estrellarse contra el índice único de `sales.number`.
   */
  async allocateSaleNumber(tx: Tx): Promise<string> {
    return this.allocate(tx, 'sale');
  }

  async allocateOrderNumber(tx: Tx): Promise<string> {
    return this.allocate(tx, 'order');
  }

  private async allocate(tx: Tx, kind: 'sale' | 'order'): Promise<string> {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const rows =
        kind === 'sale'
          ? await tx.$queryRaw<{ prefix: string; next: number }[]>`
              UPDATE company_settings SET sale_next = sale_next + 1
               WHERE id = ${SINGLETON}
              RETURNING sale_prefix AS prefix, sale_next AS next`
          : await tx.$queryRaw<{ prefix: string; next: number }[]>`
              UPDATE company_settings SET order_next = order_next + 1
               WHERE id = ${SINGLETON}
              RETURNING order_prefix AS prefix, order_next AS next`;

      const row = rows[0];
      if (!row) throw notFound('La configuración de la empresa');

      // `next` ya viene incrementado: el número asignado es el anterior.
      const assigned = Number(row.next) - 1;
      const number = `${row.prefix}${String(assigned).padStart(5, '0')}`;

      const taken =
        kind === 'sale'
          ? await tx.sale.findUnique({ where: { number }, select: { id: true } })
          : await tx.order.findUnique({ where: { number }, select: { id: true } });

      if (!taken) return number;
    }
    throw new AppError('internal_error', 'No se pudo asignar un número de documento libre');
  }
}
