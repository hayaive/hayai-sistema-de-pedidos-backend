import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig } from '../config/app-config';
import { RatesService } from './rates.service';

/**
 * Publicador automático de la tasa oficial (`RATES_FETCH_CRON`).
 *
 * Se registra a mano en lugar de con `@Cron(...)` porque la expresión es
 * configurable por entorno y el decorador la fija en tiempo de compilación. Si
 * `RATES_FETCH_ENABLED` está apagado no se registra nada: en `test` no interesa
 * llamar a una API externa cada 4 horas.
 */
@Injectable()
export class RatesCron implements OnModuleInit {
  private readonly log = new Logger(RatesCron.name);
  static readonly JOB = 'rates-fetch';

  constructor(
    private readonly cfg: AppConfig,
    private readonly rates: RatesService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit() {
    if (!this.cfg.ratesFetchEnabled) {
      this.log.log('RATES_FETCH_ENABLED=false: no se programa el job de tasas');
      return;
    }

    let job: CronJob;
    try {
      job = new CronJob(this.cfg.ratesFetchCron, () => void this.run());
    } catch {
      this.log.error(`RATES_FETCH_CRON no es una expresión válida: ${this.cfg.ratesFetchCron}`);
      return;
    }

    this.scheduler.addCronJob(RatesCron.JOB, job);
    job.start();
    this.log.log(`Job de tasas programado con "${this.cfg.ratesFetchCron}"`);
  }

  private async run() {
    const result = await this.rates.fetchFromApi();
    if (result.ok) {
      this.log.log(`Tasas publicadas: ${result.published.map((p) => `${p.source}=${p.value}`).join(' ')}`);
    } else {
      // No se reintenta en caliente: la siguiente corrida está a unas horas y la
      // tasa anterior sigue vigente mientras tanto.
      this.log.warn(`Job de tasas sin efecto: ${result.message}`);
    }
  }
}
