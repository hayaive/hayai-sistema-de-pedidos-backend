import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Customer, Prisma } from '../generated/prisma/client';
import { AppError, notFound } from '../common/errors';
import { normalizeCedula } from '../common/ids';
import { customerOut } from '../common/serialize';
import { Tx } from '../common/tx';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TombstonesService } from '../sync/tombstones.service';
import { CreateCustomerDto, CustomersQueryDto, UpdateCustomerDto } from './dto/customer.dto';

/** Remapeo de id que el cliente tiene que aplicar a su copia local (§6.5). */
export interface IdMapEntry {
  entity: string;
  localId: string;
  serverId: string;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
  ) {}

  async list(query: CustomersQueryDto) {
    const where: Prisma.CustomerWhereInput = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { cedula: { contains: normalizeCedula(query.search), mode: 'insensitive' } },
            { phone: { contains: query.search } },
          ],
        }
      : {};

    const [total, rows] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { page: query.page, pageSize: query.pageSize, total, items: rows.map(customerOut) };
  }

  async getOne(id: string) {
    const row = await this.prisma.customer.findUnique({ where: { id } });
    if (!row) throw notFound('El cliente');
    return customerOut(row);
  }

  /**
   * Alta de cliente con **fusión por cédula** (§5).
   *
   * La cédula es la identidad del cliente. Si dos dispositivos crean offline a la
   * misma persona, no se rechaza ni se duplica: se conserva la fila existente, se
   * completan los huecos con lo que trae el alta nueva y se devuelve
   * `idMap: { localId → serverId }` para que el cliente reapunte sus pedidos y
   * ventas locales.
   *
   * Los datos existentes NO se sobreescriben con los del alta: una alta es
   * información más pobre que una ficha ya trabajada; sólo se rellena lo vacío.
   */
  async create(
    user: AuthUser,
    dto: CreateCustomerDto,
    opts: { db?: Tx } = {},
  ): Promise<{ customer: Customer; merged: boolean; idMap?: IdMapEntry[] }> {
    const run = async (tx: Tx) => {
      const id = dto.id ?? randomUUID();
      const cedula = normalizeCedula(dto.cedula);

      // PK repetida ⇒ reenvío.
      const byId = await tx.customer.findUnique({ where: { id } });
      if (byId) return { customer: byId, merged: false };

      const byCedula = await tx.customer.findUnique({ where: { cedula } });
      if (byCedula) {
        const merged = await tx.customer.update({
          where: { id: byCedula.id },
          data: {
            // Sólo se rellenan huecos.
            ...(byCedula.phone ? {} : dto.phone ? { phone: dto.phone } : {}),
            ...(byCedula.address ? {} : dto.address ? { address: dto.address } : {}),
            // Un alta nueva significa que el cliente está operando: se reactiva.
            ...(byCedula.active ? {} : { active: true }),
          },
        });
        return {
          customer: merged,
          merged: true,
          idMap: [{ entity: 'customer', localId: id, serverId: merged.id }],
        };
      }

      const created = await tx.customer.create({
        data: {
          id,
          cedula,
          name: dto.name.trim(),
          phone: dto.phone ?? null,
          address: dto.address ?? null,
          active: dto.active ?? true,
        },
      });
      await this.tombstones.clear('customer', id, tx);
      return { customer: created, merged: false };
    };

    const result = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);

    await this.audit.log(
      user,
      result.merged ? 'cliente_fusionado' : 'cliente_creado',
      'customer',
      result.customer.id,
      result.merged ? { cedula: result.customer.cedula, idMap: result.idMap } : undefined,
    );
    return result;
  }

  /** Parche con LWW por campo: dos dispositivos que editan campos distintos no chocan. */
  async update(
    user: AuthUser,
    id: string,
    dto: UpdateCustomerDto,
    opts: { db?: Tx; ifMatch?: number | null } = {},
  ): Promise<Customer> {
    const run = async (tx: Tx) => {
      const current = await tx.customer.findUnique({ where: { id } });
      if (!current) throw notFound('El cliente');

      if (opts.ifMatch !== undefined && opts.ifMatch !== null && current.rev !== opts.ifMatch) {
        throw new AppError('conflict', 'El cliente cambió en otro dispositivo', {
          serverEntity: customerOut(current),
        });
      }

      const data: Prisma.CustomerUpdateInput = {};
      if (dto.cedula !== undefined) {
        const cedula = normalizeCedula(dto.cedula);
        if (cedula !== current.cedula) {
          const other = await tx.customer.findUnique({ where: { cedula } });
          if (other && other.id !== id) {
            // Cambiar la cédula a una que ya existe NO se fusiona: fusionar dos
            // fichas con historial propio movería ventas de una persona a otra.
            throw new AppError('conflict', `La cédula ${cedula} ya pertenece a otro cliente`, {
              serverEntity: customerOut(other),
            });
          }
          data.cedula = cedula;
        }
      }
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (dto.phone !== undefined) data.phone = dto.phone || null;
      if (dto.address !== undefined) data.address = dto.address || null;
      if (dto.active !== undefined) data.active = dto.active;

      if (!Object.keys(data).length) return current;
      return tx.customer.update({ where: { id }, data });
    };

    const customer = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);
    await this.audit.log(user, 'cliente_editado', 'customer', id, { fields: Object.keys(dto) });
    return customer;
  }

  /**
   * Borrado sólo sin historial: `sales.customer_id` y `orders.customer_id` son
   * RESTRICT porque un comprobante viejo tiene que seguir diciendo a quién se le
   * vendió. Con historial, se desactiva.
   */
  async remove(user: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id } });
      if (!customer) throw notFound('El cliente');

      const [sales, orders] = await Promise.all([
        tx.sale.count({ where: { customerId: id } }),
        tx.order.count({ where: { customerId: id } }),
      ]);
      if (sales || orders) {
        throw new AppError(
          'has_history',
          'El cliente tiene ventas o pedidos: desactívalo en lugar de borrarlo',
          { sales, orders },
        );
      }

      await tx.customer.delete({ where: { id } });
      await this.tombstones.record('customer', id, user.id, tx);
    });
    await this.audit.log(user, 'cliente_eliminado', 'customer', id);
  }
}
