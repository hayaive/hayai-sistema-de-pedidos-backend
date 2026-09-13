import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Todas las variables de entorno en un sitio, tipadas y con el valor por defecto
 * que documenta `.env.example`. Nada de `process.env` disperso por los
 * servicios: así el arranque falla rápido si falta un secreto, en lugar de
 * firmar tokens con `undefined`.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly cfg: ConfigService) {}

  // ── Servidor ───────────────────────────────────────────────────────────────
  get port(): number {
    // Railway inyecta PORT.
    return this.int('PORT', 3000);
  }

  get nodeEnv(): string {
    return this.str('NODE_ENV', 'development');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  /**
   * Orígenes de CORS. Los tres por defecto son los servicios reales del
   * frontend más `localhost` para desarrollo; `CORS_ORIGINS` (lista separada por
   * comas) los reemplaza.
   */
  get corsOrigins(): string[] {
    const raw = this.cfg.get<string>('CORS_ORIGINS');
    if (raw && raw.trim()) {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [
      'https://karelys-pedidos-production.up.railway.app',
      'https://karelys-pedidos-test-production.up.railway.app',
      'http://localhost',
    ];
  }

  // ── Autenticación ──────────────────────────────────────────────────────────
  get jwtAccessSecret(): string {
    return this.secret('JWT_ACCESS_SECRET');
  }

  get jwtRefreshSecret(): string {
    return this.secret('JWT_REFRESH_SECRET');
  }

  get jwtAccessTtl(): string {
    return this.str('JWT_ACCESS_TTL', '15m');
  }

  get jwtRefreshTtl(): string {
    return this.str('JWT_REFRESH_TTL', '30d');
  }

  get offlineSessionMaxDays(): number {
    return this.int('OFFLINE_SESSION_MAX_DAYS', 7);
  }

  // ── Sincronización ─────────────────────────────────────────────────────────
  get syncResendWindow(): number {
    return this.int('SYNC_RESEND_WINDOW', 200);
  }

  get syncPageLimit(): number {
    return this.int('SYNC_PAGE_LIMIT', 500);
  }

  get syncTombstoneRetentionDays(): number {
    return this.int('SYNC_TOMBSTONE_RETENTION_DAYS', 90);
  }

  get syncMutationRetentionDays(): number {
    return this.int('SYNC_MUTATION_RETENTION_DAYS', 30);
  }

  // ── Caché offline del cliente ──────────────────────────────────────────────
  get bootstrapWindowDays(): number {
    return this.int('BOOTSTRAP_WINDOW_DAYS', 30);
  }

  get bootstrapClosuresDays(): number {
    return this.int('BOOTSTRAP_CLOSURES_DAYS', 90);
  }

  get bootstrapAuditLimit(): number {
    return this.int('BOOTSTRAP_AUDIT_LIMIT', 200);
  }

  get bootstrapRatesDays(): number {
    return this.int('BOOTSTRAP_RATES_DAYS', 30);
  }

  // ── Negocio ────────────────────────────────────────────────────────────────
  get businessTimezone(): string {
    return this.str('BUSINESS_TIMEZONE', 'America/Caracas');
  }

  get ratesFetchEnabled(): boolean {
    return this.bool('RATES_FETCH_ENABLED', true);
  }

  get ratesFetchCron(): string {
    return this.str('RATES_FETCH_CRON', '0 */4 * * *');
  }

  get ratesApiUrl(): string {
    return this.str('RATES_API_URL', 'https://ve.dolarapi.com/v1');
  }

  // ── Semilla ────────────────────────────────────────────────────────────────
  get seedAdminUsername(): string {
    return this.str('SEED_ADMIN_USERNAME', 'admin');
  }

  /**
   * Contraseña del administrador inicial. El default sólo sirve para
   * desarrollo; en producción la variable es obligatoria (el seed aborta si el
   * default se queda puesto con NODE_ENV=production).
   */
  get seedAdminPassword(): string {
    return this.str('SEED_ADMIN_PASSWORD', DEV_ADMIN_PASSWORD);
  }

  // ── Utilidades ─────────────────────────────────────────────────────────────
  private str(key: string, fallback: string): string {
    const v = this.cfg.get<string>(key);
    return v === undefined || v === null || v === '' ? fallback : String(v);
  }

  private int(key: string, fallback: number): number {
    const raw = this.cfg.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  private bool(key: string, fallback: boolean): boolean {
    const raw = this.cfg.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
  }

  /**
   * Un secreto no tiene valor por defecto en producción: firmar con un literal
   * conocido es lo mismo que no firmar. En desarrollo se deriva uno del nombre
   * para que `npm run start:dev` arranque sin `.env`, y se avisa por consola.
   */
  private secret(key: string): string {
    const v = this.cfg.get<string>(key);
    if (v && v.trim() && v !== 'cambiame' && v !== 'cambiame-tambien-y-distinto') return v;
    if (this.nodeEnv === 'production') {
      throw new Error(`Falta ${key}: en producción los secretos JWT son obligatorios`);
    }
    // eslint-disable-next-line no-console
    console.warn(`[config] ${key} sin definir: usando un secreto de DESARROLLO`);
    return `dev-insecure-${key}`;
  }
}

/** Contraseña del admin sembrado en desarrollo. Documentada en el README. */
export const DEV_ADMIN_PASSWORD = 'Admin.Dev.2026';
