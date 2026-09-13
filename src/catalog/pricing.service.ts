import { Injectable } from '@nestjs/common';
import { CompanySettings, PriceGroup, Product } from '../generated/prisma/client';
import { Dec, dec, roundBs, zero } from '../common/money';
import { Tx } from '../common/tx';
import { PrismaService } from '../prisma/prisma.service';

/** La `PriceRule` del frontend, con Decimal. */
export interface PriceRule {
  minUsd: Dec;
  targetUsd: Dec;
  band?: { minUsd: Dec; maxUsd: Dec };
}

export interface BandCheck {
  /** Equivalente exacto en Bs antes de redondear. */
  rawBs: Dec;
  /** Equivalente en Bs ya redondeado y corregido dentro de la banda. */
  finalBs: Dec;
  /** Precio USD que representa `finalBs` (lo que realmente paga el cliente). */
  usdBack: Dec;
  ok: boolean;
  min: Dec;
  max: Dec;
  /** false si el producto no tiene banda declarada: entonces nunca bloquea. */
  enforced: boolean;
}

/**
 * Reglas y bandas de precio. Réplica de `lib/pricing` del frontend, con Decimal
 * en lugar de float.
 *
 * Lo que aquí NO se hace, a propósito: **no se persisten alertas de precio**. Se
 * calculan al vuelo para que reaccionen a cambios de precio y de configuración
 * sin migraciones (ARCHITECTURE.md §3.7: "no añadir tabla de alertas").
 */
@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Regla por defecto de la empresa (umbral y objetivo de tortas frías).
   * `targetUsd` nunca queda por debajo de `minUsd`, igual que `companyPriceRule`.
   */
  companyRule(company: CompanySettings): PriceRule {
    const minUsd = dec(company.coldCakeMin);
    const targetUsd = Dec.max(dec(company.coldCakeMax), minUsd);
    return { minUsd, targetUsd, band: { minUsd, maxUsd: targetUsd } };
  }

  /**
   * Regla aplicable a un producto (`lib/pricing.priceRuleOf`):
   *  · si pertenece a un grupo, se rige **sólo** por la regla del grupo (o por
   *    ninguna, si el grupo no la declara);
   *  · si no pertenece a ninguno y está en la categoría de tortas frías, hereda
   *    la de la empresa;
   *  · si no, no tiene regla y nunca genera alertas ni bloqueos.
   *
   * La distinción importa: "Oreo y Brownie" y "Torta Quesillo" están en la
   * familia pero su grupo no declara `rule` a propósito, para quedar fuera de la
   * banda del genérico.
   */
  ruleOf(product: Product, group: PriceGroup | null, company: CompanySettings): PriceRule | null {
    if (group) return groupRule(group);
    if (company.coldCakeCategoryId && product.categoryId === company.coldCakeCategoryId) {
      return this.companyRule(company);
    }
    return null;
  }

  /**
   * Comprueba la banda de redondeo en Bs. Réplica exacta de `bandCheckWith`:
   * se redondea el equivalente en Bs al paso configurado y, si al volver a USD
   * el precio sale de la banda, se corrige el monto en Bs (hacia arriba con
   * `ceil`, hacia abajo con `floor`) para no salirse.
   *
   * Sin banda declarada ⇒ `enforced: false` y `ok: true`: **la alerta avisa, no
   * bloquea**; sólo un grupo con banda puede bloquear una venta.
   */
  bandCheck(
    band: { minUsd: Dec; maxUsd: Dec } | undefined,
    usdPrice: Dec,
    rate: Dec,
    step: Dec,
  ): BandCheck {
    const rawBs = usdPrice.times(rate);
    const s = step.lte(0) ? new Dec(1) : step;

    if (!band) {
      return {
        rawBs,
        finalBs: roundBs(rawBs, s),
        usdBack: usdPrice,
        ok: true,
        min: zero(),
        max: new Dec(Infinity),
        enforced: false,
      };
    }

    const toUsd = (amountBs: Dec) => (rate.lte(0) ? zero() : amountBs.div(rate));

    let finalBs = roundBs(rawBs, s);
    let back = toUsd(finalBs);

    if (back.lt(band.minUsd)) {
      finalBs = band.minUsd.times(rate).div(s).toDecimalPlaces(0, Dec.ROUND_CEIL).times(s);
      back = toUsd(finalBs);
    } else if (back.gt(band.maxUsd)) {
      finalBs = band.maxUsd.times(rate).div(s).toDecimalPlaces(0, Dec.ROUND_FLOOR).times(s);
      back = toUsd(finalBs);
    }

    // La tolerancia de 1e-9 viene del frontend: sin ella, el redondeo exacto al
    // límite de la banda se rechazaría a sí mismo.
    const eps = new Dec('1e-9');
    return {
      rawBs,
      finalBs,
      usdBack: back,
      ok: back.gte(band.minUsd.minus(eps)) && back.lte(band.maxUsd.plus(eps)),
      min: band.minUsd,
      max: band.maxUsd,
      enforced: true,
    };
  }

  /** La banda que aplica a un producto concreto (`lib/pricing.priceBandCheck`). */
  async priceBandCheck(
    product: Product,
    unitPriceUsd: Dec,
    rate: Dec,
    company: CompanySettings,
    db: Tx | PrismaService = this.prisma,
  ): Promise<BandCheck> {
    const group = product.priceGroupId
      ? await db.priceGroup.findUnique({ where: { id: product.priceGroupId } })
      : null;
    const rule = this.ruleOf(product, group, company);
    return this.bandCheck(rule?.band, unitPriceUsd, rate, dec(company.bsRounding));
  }
}

/** Regla declarada por un grupo, o null si no declara ninguna. */
export function groupRule(group: PriceGroup): PriceRule | null {
  if (group.ruleMinUsd === null || group.ruleTargetUsd === null) return null;
  const band =
    group.ruleBandMinUsd !== null && group.ruleBandMaxUsd !== null
      ? { minUsd: dec(group.ruleBandMinUsd), maxUsd: dec(group.ruleBandMaxUsd) }
      : undefined;
  return { minUsd: dec(group.ruleMinUsd), targetUsd: dec(group.ruleTargetUsd), band };
}
