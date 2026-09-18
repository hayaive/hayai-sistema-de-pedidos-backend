import { Injectable } from '@nestjs/common';
import { CompanySettings, Product } from '../generated/prisma/client';
import { Dec, dec } from '../common/money';

/** La `PriceRule` del frontend, con Decimal. */
export interface PriceRule {
  minUsd: Dec;
  targetUsd: Dec;
  band?: { minUsd: Dec; maxUsd: Dec };
}

/**
 * Reglas de precio. Réplica de `lib/pricing` del frontend, con Decimal en lugar
 * de float.
 *
 * Dos cosas que aquí NO se hacen, a propósito:
 *
 *  · **No se persisten alertas de precio.** Se calculan al vuelo en el cliente
 *    para que reaccionen a cambios de precio y de configuración sin migraciones
 *    (ARCHITECTURE.md §3.7: "no añadir tabla de alertas").
 *  · **No se bloquea ninguna venta por banda de precio.** Se retiró en 2026-09:
 *    el algoritmo corregía el importe en Bs hacia dentro de la banda *antes* de
 *    validar, así que en la práctica sólo fallaba cuando no había tasa BCV —
 *    un mensaje de banda para un problema de tasa. Ese caso lo cubre ahora un
 *    guard explícito en `SalesService.create`.
 *
 * Queda como autoridad de la regla de precio del lado servidor; hoy el único
 * consumidor de la regla es el cliente, que la recalcula con los mismos datos.
 */
@Injectable()
export class PricingService {
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
   * Regla aplicable a un producto (`lib/pricing.priceRuleOf`).
   *
   * La banda mínimo/máximo de la empresa aplica a los productos que el negocio
   * marcó como sujetos al rango (`priceBand`). Hasta 2026-09 la banda colgaba
   * sólo del genérico "Tortas Frías"; la migración `product_price_band` lo dejó
   * marcado, así que su comportamiento no cambia.
   *
   * Un producto sin marcar no tiene regla y nunca genera alerta.
   */
  ruleOf(product: Product, company: CompanySettings): PriceRule | null {
    return product.priceBand ? this.companyRule(company) : null;
  }
}
