import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError, invalid, notFound } from '../common/errors';
import { slug } from '../common/ids';
import { ROLE_INCLUDE } from '../common/includes';
import { roleOut, userOut } from '../common/serialize';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { hashPassword } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TombstonesService } from '../sync/tombstones.service';
import {
  CreateRoleDto,
  CreateUserDto,
  SetPasswordDto,
  UpdateRoleDto,
  UpdateUserDto,
} from './dto/user.dto';

/**
 * Usuarios y roles. Son `online_only` (ARCHITECTURE.md §5): una cola offline
 * podría resucitar a un usuario revocado o devolverle permisos, así que la
 * separación es **de seguridad, no de comodidad**.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
  ) {}

  // ── Usuarios ───────────────────────────────────────────────────────────────

  async listUsers() {
    // El usuario técnico no se lista: no es una persona y no puede iniciar sesión.
    const rows = await this.prisma.user.findMany({
      where: { system: false },
      orderBy: { username: 'asc' },
    });
    return rows.map(userOut);
  }

  async createUser(actor: AuthUser, dto: CreateUserDto) {
    const username = dto.username.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { username } });
    if (existing) throw new AppError('conflict', `El usuario ${username} ya existe`);

    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role) throw invalid(`El rol ${dto.roleId} no existe`);

    const user = await this.prisma.user.create({
      data: {
        id: dto.id ?? randomUUID(),
        username,
        fullName: dto.fullName.trim(),
        email: dto.email ?? null,
        // El hash es argon2id y nunca sale del servidor.
        passwordHash: await hashPassword(dto.password),
        passwordUpdatedAt: new Date(),
        roleId: dto.roleId,
        active: dto.active ?? true,
      },
    });

    await this.audit.log(actor, 'usuario_creado', 'user', user.id, {
      username: user.username,
      roleId: user.roleId,
    });
    return userOut(user);
  }

  async updateUser(actor: AuthUser, id: string, dto: UpdateUserDto) {
    const current = await this.prisma.user.findUnique({ where: { id } });
    if (!current) throw notFound('El usuario');
    if (current.system) throw invalid('El usuario técnico no se edita');

    if (dto.roleId) {
      const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
      if (!role) throw invalid(`El rol ${dto.roleId} no existe`);
    }

    // Desactivar a alguien deja fechada la revocación: `deactivated_at` decide si
    // una mutación offline en cola de ese usuario todavía se acepta (§5).
    const deactivating = dto.active === false && current.active;
    const reactivating = dto.active === true && !current.active;

    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName.trim() } : {}),
          ...(dto.email !== undefined ? { email: dto.email || null } : {}),
          ...(dto.roleId !== undefined ? { roleId: dto.roleId } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(deactivating ? { deactivatedAt: new Date() } : {}),
          ...(reactivating ? { deactivatedAt: null } : {}),
        },
      });

      // Al desactivar se cortan sus sesiones: si no, seguiría operando hasta que
      // caduque su refresh token (30 días).
      if (deactivating) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return updated;
    });

    await this.audit.log(actor, deactivating ? 'usuario_desactivado' : 'usuario_editado', 'user', id, {
      fields: Object.keys(dto),
    });
    return userOut(user);
  }

  /**
   * Cambia la contraseña y **revoca todas las sesiones** de ese usuario: un
   * cambio de clave que deja vivas las sesiones anteriores no sirve para echar a
   * nadie.
   */
  async setPassword(actor: AuthUser, id: string, dto: SetPasswordDto) {
    const current = await this.prisma.user.findUnique({ where: { id } });
    if (!current) throw notFound('El usuario');
    if (current.system) throw invalid('El usuario técnico no tiene contraseña');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash: await hashPassword(dto.password), passwordUpdatedAt: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.log(actor, 'contrasena_cambiada', 'user', id);
    return { ok: true };
  }

  // ── Roles ──────────────────────────────────────────────────────────────────

  async listRoles() {
    const rows = await this.prisma.role.findMany({
      include: ROLE_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return rows.map(roleOut);
  }

  async createRole(actor: AuthUser, dto: CreateRoleDto) {
    const base = slug(dto.name);
    const id = dto.id ?? (base ? `role-${base}` : randomUUID());

    const role = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
      if (existing) return existing;

      await tx.role.create({ data: { id, name: dto.name.trim() } });
      await tx.rolePermission.createMany({
        data: dto.permissions.map((permission) => ({ roleId: id, permission })),
      });
      await this.tombstones.clear('role', id, tx);

      // Relectura: `role_permissions_bump_parent` movió el `rev` del rol.
      const created = await tx.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
      if (!created) throw notFound('El rol');
      return created;
    });

    await this.audit.log(actor, 'rol_creado', 'role', role.id, { name: role.name });
    return roleOut(role);
  }

  async updateRole(actor: AuthUser, id: string, dto: UpdateRoleDto) {
    const role = await this.prisma.$transaction(async (tx) => {
      const current = await tx.role.findUnique({ where: { id } });
      if (!current) throw notFound('El rol');
      // `system = true` ⇒ no se borra ni se le editan permisos.
      if (current.system && dto.permissions) {
        throw invalid('Un rol de sistema no admite cambios de permisos');
      }

      if (dto.name !== undefined) {
        await tx.role.update({ where: { id }, data: { name: dto.name.trim() } });
      }

      if (dto.permissions) {
        // Reemplazo en bloque: la matriz de permisos es una lista, y fusionarla
        // dejaría permisos que el administrador quitó a propósito.
        await tx.rolePermission.deleteMany({
          where: { roleId: id, permission: { notIn: dto.permissions } },
        });
        for (const permission of dto.permissions) {
          await tx.rolePermission.upsert({
            where: { roleId_permission: { roleId: id, permission } },
            create: { roleId: id, permission },
            update: {},
          });
        }
      }

      const updated = await tx.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
      if (!updated) throw notFound('El rol');
      return updated;
    });

    await this.audit.log(actor, 'rol_editado', 'role', id, { fields: Object.keys(dto) });
    return roleOut(role);
  }

  async removeRole(actor: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id } });
      if (!role) throw notFound('El rol');
      if (role.system) throw invalid('Un rol de sistema no se borra');

      const users = await tx.user.count({ where: { roleId: id } });
      if (users) {
        throw new AppError('has_history', 'El rol tiene usuarios asignados', { users });
      }

      await tx.role.delete({ where: { id } });
      await this.tombstones.record('role', id, actor.id, tx);
    });
    await this.audit.log(actor, 'rol_eliminado', 'role', id);
  }
}
