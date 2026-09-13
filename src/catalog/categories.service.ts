import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '../common/errors';
import { slug } from '../common/ids';
import { categoryOut } from '../common/serialize';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TombstonesService } from '../sync/tombstones.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/catalog.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
  ) {}

  async list() {
    const rows = await this.prisma.category.findMany({ orderBy: { name: 'asc' } });
    return rows.map(categoryOut);
  }

  async create(user: AuthUser, dto: CreateCategoryDto) {
    // Id semántico como el del catálogo del frontend (`cat-tortas-frias`); si el
    // nombre no deja slug utilizable (sólo símbolos), se cae a un UUID.
    const base = slug(dto.name);
    const id = dto.id ?? (base ? `cat-${base}` : randomUUID());
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (existing) return categoryOut(existing);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.category.create({
        data: { id, name: dto.name.trim(), active: dto.active ?? true },
      });
      await this.tombstones.clear('category', id, tx);
      return created;
    });

    await this.audit.log(user, 'categoria_creada', 'category', row.id, { name: row.name });
    return categoryOut(row);
  }

  async update(user: AuthUser, id: string, dto: UpdateCategoryDto) {
    const current = await this.prisma.category.findUnique({ where: { id } });
    if (!current) throw notFound('La categoría');

    const row = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    await this.audit.log(user, 'categoria_editada', 'category', id, { fields: Object.keys(dto) });
    return categoryOut(row);
  }

  /**
   * Borrado sólo si nadie la referencia. `products.category_id` es
   * `ON DELETE RESTRICT`, así que la base lo impediría igual; aquí se comprueba
   * antes para devolver un 409 con el motivo en lugar de un error de integridad.
   */
  async remove(user: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findUnique({ where: { id } });
      if (!category) throw notFound('La categoría');

      const products = await tx.product.count({ where: { categoryId: id } });
      if (products) {
        throw new AppError('has_history', 'La categoría tiene productos', { products });
      }

      await tx.category.delete({ where: { id } });
      await this.tombstones.record('category', id, user.id, tx);
    });
    await this.audit.log(user, 'categoria_eliminada', 'category', id);
  }
}
