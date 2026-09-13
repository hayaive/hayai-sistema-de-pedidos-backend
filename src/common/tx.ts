import { Prisma } from '../generated/prisma/client';

/**
 * Cliente dentro de una transacción interactiva. Los servicios que participan en
 * una transacción ajena reciben esto en lugar de `PrismaService`, para que sea
 * imposible colar una escritura fuera de la transacción por descuido.
 */
export type Tx = Prisma.TransactionClient;
