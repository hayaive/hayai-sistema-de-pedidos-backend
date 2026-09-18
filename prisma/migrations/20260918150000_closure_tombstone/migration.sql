-- Reabrir un cierre de caja lo borra (DELETE /closures/:id) y deja un tombstone
-- para que los demás equipos lo quiten: el cierre es una colección acotada que
-- el bootstrap funde en vez de reemplazar, así que sin tombstone seguiría ahí.
-- En Postgres ≥ 12 ADD VALUE puede ir dentro de la transacción de la migración
-- mientras el valor nuevo no se use en ella, que es el caso.
ALTER TYPE "sync_entity" ADD VALUE IF NOT EXISTS 'closure';
