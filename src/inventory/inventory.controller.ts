import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators';
import { InventoryService } from './inventory.service';
import { MovementsQueryDto } from './dto/movement.dto';

@Controller('movements')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /** El kardex completo, paginado. La caché offline sólo trae la ventana. */
  @Get()
  @RequirePermission('view_inventory')
  list(@Query() query: MovementsQueryDto) {
    return this.inventory.list(query);
  }

  /**
   * Reconciliación `products.stock` vs `SUM(delta)`. Debería dar vacío siempre;
   * sirve para comprobarlo sin abrir psql.
   */
  @Get('reconcile')
  @RequirePermission('edit_inventory')
  reconcile() {
    return this.inventory.reconcile();
  }
}
