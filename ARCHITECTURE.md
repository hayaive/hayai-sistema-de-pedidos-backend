# Backend de pedidos y ventas · Karelys Delicias

Fuente de verdad relacional del POS **Karelys Delicias**, cuyo frontend vive en
`C:\dev\karelys-pedidos` (React + TanStack Start). Hoy ese frontend guarda todo
en `localStorage`; a partir de aquí PostgreSQL es la verdad y el `localStorage`
pasa a ser **caché temporal con cola de cambios pendientes**.

Este documento es el contrato: qué hay en la base, cómo se detecta lo que
cambió, qué pasa cuando dos dispositivos editan lo mismo, qué expone la API y
dónde sigue construyendo D.A.N.I.

> **Estado del repo**: la capa de datos está lista y verificada (esquema Prisma +
> migración inicial aplicada contra un Postgres real, 44 comprobaciones de
> integridad en verde). El proyecto NestJS todavía no existe: se monta encima,
> en la raíz. Ver §9.

---

## Índice

1. [Decisiones de fondo](#1-decisiones-de-fondo)
2. [Resumen del esquema](#2-resumen-del-esquema)
3. [Notas de modelado](#3-notas-de-modelado)
4. [Sincronización: cómo se detecta lo que cambió](#4-sincronización-cómo-se-detecta-lo-que-cambió)
5. [Resolución de conflictos por entidad](#5-resolución-de-conflictos-por-entidad)
6. [Contrato de API](#6-contrato-de-api)
7. [DDL escrito a mano](#7-ddl-escrito-a-mano)
8. [Despliegue en Railway](#8-despliegue-en-railway)
9. [Estructura de carpetas y por dónde seguir](#9-estructura-de-carpetas-y-por-dónde-seguir)
10. [Impacto en el frontend](#10-impacto-en-el-frontend)
11. [Pendientes y decisiones abiertas](#11-pendientes-y-decisiones-abiertas)

---

## 1 · Decisiones de fondo

| Tema | Decisión | Por qué |
|---|---|---|
| ORM | **Prisma 7.10.0** (estable; `latest` en npm es un RC 8.0 que no se usa) | Migraciones versionadas, tipos generados, estándar con NestJS. Sus límites (CHECK, triggers, índices parciales) se cubren con DDL a mano verificado contra la deriva — ver §7 |
| PK | **TEXT (`VarChar(64)`) generada en el origen**, no `uuid` ni autoincremento | El frontend tiene ids semánticos que son **constantes en su código** (`pt-mayor`, `cat-tortas-frias`, `prod-P060`, `pg-tortas-frias`, `pm-usd`). Convertirlos a UUID obligaría a reescribir `pricing-rules.ts`/`catalog.ts`, que está fuera de alcance. Los registros **nuevos** usan UUID generado en el cliente (`crypto.randomUUID()`) |
| Cursor de cambios | Columna **`rev` INTEGER** de una **secuencia global**, asignada por trigger | Orden total sin empates ni relojes; ver §4.2 por qué no `updatedAt` |
| Bloqueo optimista | El mismo **`rev`** hace de ETag / `If-Match` | Una sola columna que significa una sola cosa: "versión de esta fila" |
| Dinero | `NUMERIC` siempre. USD `Decimal(14,4)` · Bs `Decimal(18,4)` · tasa `Decimal(18,8)` · cantidades `Decimal(14,3)` | Nada de float en dinero. La tasa necesita 8 decimales: la semilla ya trae `947.29802151` |
| Bs | **Nunca se persiste un monto en Bs derivado de un precio USD** | Regla explícita del frontend (`lib/money.ts`). Sólo se congela la tasa cuando el dinero ya entró: `sales.rate_*`, `sale_payments.rate_used`, `order_deposits.rate_used` |
| Fechas | Todo `timestamptz`; el día contable se materializa en columnas `business_date` calculadas en `America/Caracas` por trigger | `createdAt.slice(0,10)` sobre un ISO en UTC manda las ventas de después de las 20:00 al día siguiente y descuadra el cierre de caja. Ver §3.4 |
| Existencia | **Ledger** `inventory_movements` append-only; `products.stock` es caché que sólo mueve el servidor | `entrada`/`ajuste` conmutan; una `salida` se recorta al stock disponible al aplicar, así que **el stock nunca queda negativo** (se puede vender sin existencia, pero lo que se descuenta es `min(qty, stock)`). Además el cliente nunca escribe `stock`, lo que elimina de raíz toda una clase de conflictos |
| Multitenancy | **No.** Un solo negocio, una sola base | El frontend no tiene ningún concepto de tenant. Ver §11 para cómo entraría sin romper nada |
| Auditoría | `audit_log`, `inventory_movements` y `exchange_rates` son **append-only reforzado por trigger** (UPDATE y DELETE lanzan excepción) | Un rastro que se puede editar no prueba nada |

---

## 2 · Resumen del esquema

29 tablas. Los nombres entre paréntesis son el modelo Prisma.

### Seguridad

| Tabla | Contenido | Notas |
|---|---|---|
| `roles` (`Role`) | Rol con nombre único y bandera `system` | `system = true` ⇒ no se borra ni se le editan permisos |
| `role_permissions` (`RolePermission`) | Matriz rol × permiso, PK compuesta | `permission` es un **enum** con los 15 valores del frontend. Añadir uno exige migración: desplegar backend **antes** del frontend que lo emita |
| `users` (`User`) | Usuario, `password_hash` (argon2id), `role_id`, `active`, `deactivated_at`, `system` | El hash **nunca** sale del servidor. `deactivated_at` decide si una mutación offline en cola sigue siendo válida (§5) |
| `refresh_tokens` (`RefreshToken`) | Sesiones de refresco: se guarda el hash del token | Rotación con detección de reutilización |

### Catálogo y precios

| Tabla | Contenido | Notas |
|---|---|---|
| `categories` (`Category`) | Categorías | |
| `price_types` (`PriceType`) | Mayor / Detal, `is_default`, `position` | Índice único parcial: **un solo** default |
| `price_groups` (`PriceGroup`) | "Precio general" compartido. `PriceRule` aplanada en `rule_min_usd`, `rule_target_usd`, `rule_band_min_usd`, `rule_band_max_usd` | Seis CHECK sostienen la semántica: *grupo sin regla* ≠ *grupo con regla y sin banda*, y sólo un grupo **con banda** puede bloquear una venta |
| `price_group_prices` (`PriceGroupPrice`) | Precio del grupo por tipo de precio, PK `(grupo, tipo)` | La **celda** es la unidad de conflicto |
| `products` (`Product`) | Producto. `code` único, `stock`/`min_stock`, `bs_only`/`bs_price`, `price_group_id`, combo y personalización | `stock` **no lo escribe ningún cliente** |
| `product_prices` (`ProductPrice`) | Precio propio del producto, PK `(producto, tipo)` | Es la verdad **sólo** si el producto no pertenece a un grupo (`lib/pricing.resolvePrices`) |
| `combo_items` (`ComboItem`) | Contenido declarado de un combo | Descriptivo: los combos no mueven inventario |
| `retired_product_codes` (`RetiredProductCode`) | Códigos retirados, sembrado con `P001`–`P013` | Un trigger impide que un producto reutilice uno. Ver §3.5 |

### Operación

| Tabla | Contenido | Notas |
|---|---|---|
| `customers` (`Customer`) | Cliente. `cedula` única y normalizada en mayúsculas (CHECK) | El formato se valida en el DTO, no con CHECK: un CHECK de formato reventaría la importación inicial |
| `inventory_movements` (`InventoryMovement`) | Kardex: `type`, `qty`, `delta`, `stock_after`, `reason`, `user_id`, `sale_id?` | Append-only. Un CHECK garantiza `entrada ⇒ delta=+qty`, `salida ⇒ delta=−qty`, `ajuste ⇒ stock_after=qty` |
| `exchange_rates` (`ExchangeRate`) | Log append-only de tasas por fuente | La vigente es `MAX(created_at)` por fuente; índice `(source, created_at DESC)` |
| `payment_methods` (`PaymentMethod`) | Formas de pago con moneda y `requires_reference` | |
| `sales` (`Sale`) | Comprobante. Totales, **tasa congelada** (`rate_usd/eur/binance`, `rate_at`), `status`, `order_id?`, anulación fechada, `business_date` | Insert-only; lo único que cambia después es pasar a `anulada` |
| `sale_items` (`SaleItem`) | Líneas con `code`/`name`/precios **denormalizados** | Foto histórica: no se recalculan nunca |
| `sale_payments` (`SalePayment`) | Pagos con `at`, `business_date`, `rate_used`, `from_order_deposit_id?` **único** | Un abono no puede ser consumido por dos ventas |
| `orders` (`Order`) | Pedido por encargo. `total_usd` (recalculado por el servidor), `status`, `sale_id?` | El único agregado con edición concurrente real |
| `order_items` (`OrderItem`) | Líneas del pedido | Se reemplazan en bloque, nunca se fusionan |
| `order_deposits` (`OrderDeposit`) | Abonos: monto, `usd_equivalent`, `rate_used` congelada, `at`, `business_date`, anulación | Append-only con `rev` propio. **Siempre se fusionan** (§5) |
| `daily_closures` (`DailyClosure`) | Cierre por día contable, `date` única | Un cierre por día (una sola caja; ver §11) |
| `closure_methods` (`ClosureMethod`) | Detalle esperado/recibido por forma de pago | |
| `audit_log` (`AuditLog`) | Bitácora append-only, `data` en jsonb | El servidor la conserva completa; al cliente sólo le viaja la cola reciente |
| `company_settings` (`CompanySettings`) | Fila única (`id = 'singleton'`, CHECK): datos del negocio, prefijos y contadores, regla de tortas frías, `bs_rounding`, `timezone`, `schema_version`, `shortcuts` | `sale_next`/`order_next` son **propiedad del servidor** |

### Infraestructura de sincronización

| Tabla | Contenido | Notas |
|---|---|---|
| `devices` (`Device`) | Dispositivo: nombre, último usuario, `last_seen_at`, `last_cursor` | Permite auditar el origen de cada asiento y diagnosticar "este equipo no sincroniza desde el martes" |
| `sync_mutations` (`SyncMutation`) | Bitácora de idempotencia: `mutationId` → resultado | Si la red muere después del commit, el reenvío devuelve el resultado guardado |
| `sync_deletions` (`SyncDeletion`) | Tombstones `(entity, entity_id)` con `rev` de la **misma** secuencia | Un cliente que sólo recibe altas nunca se enteraría de un borrado |

---

## 3 · Notas de modelado

### 3.1 · Identidad de los registros

- **PK TEXT** por la razón del §1. Conviven ids semánticos heredados
  (`prod-P060`) con UUID nuevos: el backend no impone formato, sólo unicidad.
- **Los registros creados offline traen su id del cliente** (`crypto.randomUUID()`).
  El `uid()` actual del frontend (8 chars aleatorios + 4 de timestamp) es débil
  para generar ids en varios dispositivos a la vez; se recomienda cambiarlo por
  `crypto.randomUUID()` **sólo para altas nuevas** (los ids existentes no se
  tocan).
- Un `INSERT` cuya PK ya existe **no es un error**: es un reenvío. El servidor
  responde `duplicate` con la entidad que ya tenía. Es la primera línea de
  defensa de la idempotencia; la segunda es `sync_mutations`.
- **Colisiones de clave natural sí necesitan remapeo.** `cedula`, `products.code`
  y los números de documento son claves de negocio: dos dispositivos offline
  pueden generar la misma. La respuesta trae `idMap` y/o `renumbered` y el
  cliente reapunta su copia local (§6.5).

### 3.2 · Numeración de documentos (`V-00001`, `P-00001`)

El número lo asigna **siempre el servidor**, desde `company_settings.sale_next` /
`order_next`, dentro de la transacción (`UPDATE ... RETURNING` serializa por
bloqueo de fila; a este volumen es de sobra).

Una venta creada offline llega con un número provisional. Si choca:

1. el servidor asigna el siguiente libre,
2. guarda el provisional en `client_number` (así se puede encontrar la venta por
   el ticket que ya se imprimió),
3. devuelve `renumbered: { from, to }`.

`sales.number` y `orders.number` son **únicos**: nunca van a existir dos
`V-00007`. Consecuencia práctica que hay que resolver en la UI: **un ticket
impreso offline puede renumerarse**, así que debe salir marcado como provisional
(§11).

### 3.3 · La foto histórica no se toca

`sale_items`/`order_items` guardan `code`, `name`, `qty` y precios
denormalizados; `sale_payments`/`order_deposits` guardan `method_name`; `sales`
guarda `customer_name` y `user_name`. **No son redundancia por descuido**: un
comprobante viejo tiene que seguir leyéndose igual aunque el producto cambie de
nombre, de precio o de categoría. No normalizar eso "de paso".

Al mismo tiempo, la **integridad referencial sí se respeta**: `product_id` y
`price_type_id` son FK con `ON DELETE RESTRICT`. Un producto con historial
**no se puede borrar**, sólo desactivar (`active = false`). Si algún día hay que
borrarlo de verdad, primero se reapuntan las referencias (como hizo la migración
v3 del frontend al consolidar los 13 sabores) — nunca se dejan colgando: el
código del frontend ignora en silencio un `productId` inexistente
(`applyMovement` hace `if (!p) return`), y ahí una referencia huérfana no da
error, da **pérdida silenciosa de stock**.

### 3.4 · El día contable

`lib/business.closureDraft` agrupa el dinero por `fecha.slice(0,10)` sobre un
ISO **en UTC**. En Caracas (UTC−4) una venta de las 21:00 cae en el día
siguiente: el cierre de ese día no cuadra y el del siguiente aparece con dinero
que no se recibió.

En el backend el día es una columna materializada, `business_date`, que **pone la
base de datos**:

- `sales.business_date` ← `created_at`
- `orders.business_date` ← `created_at`
- `sale_payments.business_date` ← `at` (el día en que entró ESE dinero)
- `order_deposits.business_date` ← `at`

Trigger `set_business_date_*` con la zona de `company_settings.timezone`. Se
dispara en **todo** INSERT y UPDATE, no sólo cuando cambia el timestamp de
origen: si sólo escuchara a `created_at`, un UPDATE que toca únicamente
`business_date` colaría un día falso. Verificado: el trigger ignora lo que manda
el cliente.

Con eso, el cierre de caja del frontend se traduce a dos consultas indexadas:

```sql
-- Dinero que entró hoy (los pagos que vienen de un abono ya se contaron el día
-- del abono, por eso se excluyen)
SELECT p.method_id, SUM(p.usd_equivalent)
  FROM sale_payments p JOIN sales s ON s.id = p.sale_id
 WHERE s.status = 'completada' AND p.from_order_deposit_id IS NULL
   AND p.business_date = $1
 GROUP BY p.method_id;

-- Abonos recibidos hoy (pedidos aún sin facturar)
SELECT method_id, SUM(usd_equivalent)
  FROM order_deposits
 WHERE NOT voided AND business_date = $1
 GROUP BY method_id;
```

Invariante a preservar: **la suma de los días = lo facturado, sin duplicar
abonos**.

### 3.5 · Códigos de producto retirados

`products.code` único sólo impide choques entre productos vivos. La regla que de
verdad importa es que **un código retirado no vuelva a circular**: si `P001` se
reasigna, un comprobante viejo que dice "P001 · tres-leches" pasa a resolver a
otro producto. No hay FK que exprese "no está en esta otra tabla", así que va
como trigger (`products_reject_retired_code`) contra `retired_product_codes`,
sembrada con los 13 sabores que el esquema v3 del frontend consolidó.

Al borrar un producto, la API **tiene que** insertar su código ahí.

### 3.6 · Inventario: ledger + caché

```
inventory_movements:  type ∈ {entrada, salida, ajuste}
                      qty        lo que capturó el usuario
                      delta      efecto con signo, lo calcula el SERVIDOR
                      stock_after balance tras aplicar
```

- `entrada` → `delta = +qty`
- `salida` → `delta = −min(qty, stock_actual)` (recortada; ver más abajo)
- `ajuste` → `delta = qty − stock_actual`, **resuelto en el momento de aplicar**,
  no en el de capturar. Un ajuste creado offline a las 9:00 que llega a las 18:00
  no borra las ventas que ocurrieron entre medias.

`products.stock` se mueve **sólo** en la misma transacción que inserta el
movimiento. Reconciliación (debería dar 0 siempre):

```sql
SELECT p.id, p.stock, COALESCE(SUM(m.delta), 0) AS ledger,
       p.stock - COALESCE(SUM(m.delta), 0) AS descuadre
  FROM products p LEFT JOIN inventory_movements m ON m.product_id = p.id
 GROUP BY p.id, p.stock
HAVING p.stock <> COALESCE(SUM(m.delta), 0);
```

`stock` **nunca queda negativo** (CHECK `products_stock_nonneg_ck`): un POS puede
vender lo que el conteo dice que no hay (la venta no se rechaza), pero la
`salida` se recorta al stock disponible — `delta = -min(qty, stock)` — y el
faltante ("vendido sin existencia") queda derivable como `qty + delta`. El CHECK
`inventory_movements_delta_ck` sólo admite ese recorte cuando deja la existencia
exactamente en 0. `apply()` toma el lock de fila del producto (`FOR NO KEY
UPDATE`) antes de leer el stock, así que dos movimientos concurrentes sobre el
mismo producto se serializan en vez de perder una escritura.

### 3.7 · Reglas de precio que el esquema preserva

- El precio efectivo sale del **grupo** si el producto pertenece a uno, y si no
  de su precio propio (`resolvePrices`). `product_prices` se conserva siempre
  como respaldo histórico.
- Un producto agrupado se rige **sólo** por la regla de su grupo (o por ninguna,
  si el grupo no la declara). Por eso hay que poder distinguir *sin regla* de
  *con regla y sin banda*: los CHECK de `price_groups` lo garantizan.
- **La alerta de precio bajo avisa, no bloquea.** Sólo un grupo con `band`
  bloquea una venta. Las alertas **no se persisten**: se calculan al vuelo
  (`lib/pricing.priceAlerts`), y así reaccionan a cambios de precio y de
  configuración sin migraciones. No añadir tabla de alertas.
- `cold_cake_min` / `cold_cake_max` viven en `company_settings` con un CHECK que
  impide que el objetivo quede por debajo del umbral: la migración v2 del
  frontend existió justamente para arreglar eso.

---

## 4 · Sincronización: cómo se detecta lo que cambió

### 4.1 · El modelo en tres piezas

1. **`GET /bootstrap`** — al iniciar sesión o cuando el cursor caducó: estado
   completo de la ventana operativa + `cursor`.
2. **`GET /sync?since=<cursor>`** — cada ~60 s: sólo lo que cambió. El mismo
   mecanismo sirve para ponerse al día tras reconectar y para ver los cambios de
   otro dispositivo estando en línea. No hay websockets.
3. **`POST /sync`** — sube la cola de mutaciones pendientes (y también se usa en
   línea: el camino es uno solo, con o sin red).

El cliente **siempre** escribe primero en su caché local y encola la mutación.
Estando en línea, el ciclo encolar → subir → aplicar respuesta ocurre de
inmediato; sin red, la cola espera. Un solo camino de escritura significa que el
modo offline no es un camino "raro" que casi nunca se ejerce.

### 4.2 · El cursor: `rev`

Cada tabla sincronizable tiene `rev INTEGER`, tomado de **una única secuencia
global** (`sync_rev_seq`) y asignado por el trigger `sync_assign_rev` tanto en
INSERT como en UPDATE. La consulta del delta es `WHERE rev > :cursor`.

**Por qué no `updatedAt`:**

- **Empates.** Dos filas con el mismo milisegundo parten una página: con un tope
  de 500 filas se saltan registros o se entra en bucle. `rev` es un orden total
  sin empates, así que la paginación por cursor es exacta.
- **Relojes.** `now()` en Postgres es el instante de **inicio** de la
  transacción: una transacción larga sella T1 y commitea en T5, después de que un
  poll ya consumió hasta T3 → ese cambio **no se entrega nunca**. Con `rev` el
  problema se reduce (y se mitiga, ver abajo), y además no depende del reloj de
  ninguna réplica del backend.
- **Un solo número para todo.** La secuencia es global, así que un `rev` no
  aparece en dos tablas y el cliente puede ordenar el delta completo por `rev`.
  Los **tombstones comparten la misma secuencia**: un cursor cubre altas,
  cambios y borrados.

`updated_at` sigue existiendo en todas las tablas (diagnóstico, retención,
"modificado hace X"), pero **no es el cursor**.

**Ventana de reenvío.** Queda un hueco teórico: una transacción que tomó `rev`
101 y commitea después de que un poll sirvió hasta 150. Mitigación: el servidor
consulta `rev > cursor − SYNC_RESEND_WINDOW` (200 por defecto). Como el delta
manda agregados completos y el cliente los aplica por id de forma idempotente,
reenviar unas filas extra no cuesta nada; y a este ritmo de escritura 200
revisiones son horas. Si algún día hiciera falta exactitud estricta, el camino
es un outbox ordenado por commit consumido con `pg_current_snapshot()`.

**El `rev` no se bumpea si la fila no cambió de verdad.** El trigger compara las
dos versiones ignorando `rev` y `updated_at`, así que un UPDATE que no cambia
nada no mueve el cursor y no provoca un reenvío inútil a todos los dispositivos.

### 4.3 · Agregados, no filas

El delta viaja por **raíces de agregado**, con sus hijas dentro:

| Raíz | Incluye |
|---|---|
| `role` | sus permisos |
| `product` | sus precios propios y sus `comboItems` |
| `priceGroup` | sus precios |
| `order` | sus líneas |
| `orderDeposit` | (raíz propia, con `orderId`) |
| `sale` | sus líneas y sus pagos |
| `closure` | su detalle por método |

Las tablas hijas **no tienen `rev`**: un cambio en ellas bumpea el `rev` del
padre por trigger (`sync_bump_parent_rev`), de modo que es **imposible** cambiar
un precio sin que el delta reenvíe el producto. No se confía en que cada servicio
se acuerde de tocar el padre.

Dos excepciones deliberadas:

- `sale_items`, `sale_payments` y `closure_methods` **no** bumpean al padre: se
  insertan una única vez junto a él y nunca se editan, así que el trigger sólo
  conseguiría dejar obsoleto el `rev` que la API acaba de devolver.
- `order_deposits` **no** bumpea el `rev` del pedido, aunque sea "parte" de él.
  Si lo hiciera, registrar un abono en la caja invalidaría el bloqueo optimista
  de quien está editando las líneas en otro equipo, con un 409 espurio. El saldo
  es **derivado** (`orderBalance()`), no un campo del pedido: el cliente recibe
  el abono como entidad propia, lo fusiona en su copia del pedido y recalcula.

> Regla para D.A.N.I: **después de mutar filas hijas, relee la raíz** para
> devolver su `rev` nuevo.

### 4.4 · Borrados: tombstones

Un cliente que sólo recibe altas y cambios nunca se enteraría de un borrado. Por
eso hay una tabla central `sync_deletions (entity, entity_id, rev)` en lugar de
un `deleted_at` por tabla: sólo un puñado de entidades admite borrado, un
`deleted_at` en todas obligaría a un `WHERE deleted_at IS NULL` en cada consulta
(y a acordarse siempre), y complicaría los índices únicos.

- Se consulta una vez por poll: `WHERE rev > :cursor`.
- Retención `SYNC_TOMBSTONE_RETENTION_DAYS` (90). Un dispositivo desconectado
  más tiempo que eso recibe `bootstrapRequired: true` y rehace `/bootstrap`.
- Si un id borrado se vuelve a crear (raro, los ids son UUID), hay que borrar su
  tombstone en la misma transacción.

### 4.5 · Idempotencia de las mutaciones

Cada mutación de la cola lleva un `mutationId` (UUID del cliente). El servidor
lo guarda en `sync_mutations` con su resultado:

- **Primera vez** → se aplica y se guarda el resultado.
- **Reenvío** (la red murió después del commit) → se devuelve el resultado
  guardado, `status: "duplicate"`, sin re-aplicar.

Sin esto, un abono o una venta se duplican con sólo perder la respuesta. Es la
pieza que hace que la cola pueda reintentar a ciegas.

### 4.6 · Relojes de los dispositivos

Un equipo con la fecha mal puesta envenena el día contable. Reglas:

- Todas las respuestas traen `serverTime`; el cliente calcula su desfase y sella
  los timestamps de negocio ya corregidos.
- El servidor **acota** el `at`/`createdAt` que recibe al rango
  `[ahora − 30 días, ahora + 5 min]`, y guarda siempre también su propio
  `received_at` (y `client_at` en `sync_mutations`).
- El día contable no se deriva del cliente: lo pone el trigger (§3.4).

---

## 5 · Resolución de conflictos por entidad

Principios:

1. **El dinero que ya entró no se pierde ni se duplica.** Ante la duda, se
   conserva el asiento y se deja que un humano lo corrija con otro asiento.
2. **Lo facturado no se edita.** Nunca.
3. **Las listas no se fusionan solas.** Las líneas de un pedido se reemplazan en
   bloque con bloqueo optimista; fusionar arrays pierde o duplica ítems, y aquí
   eso es dinero.
4. **Las actualizaciones viajan como parche**, no como snapshot: sólo los campos
   tocados. Así dos dispositivos que editan campos distintos del mismo cliente
   no chocan, y sólo compite el mismo campo.
5. Lo **sensible a seguridad no se edita offline**.

| Entidad | ¿Offline? | Versión | Regla de conflicto |
|---|---|---|---|
| `sales` | **Sí** (venta offline) | `rev`, inmutable | Sólo INSERT. PK repetida ⇒ `duplicate`. Número repetido ⇒ el servidor **renumera** (`client_number` + `renumbered`). Un pedido ya facturado ⇒ **rechazo permanente** `order_already_billed` (índice único parcial `sales_active_order_uq`) devolviendo la venta existente. Después del alta, la **única** transición es `completada → anulada`, idempotente |
| `sale_items`, `sale_payments` | con su venta | — | Se insertan con la venta y no se modifican jamás. Un abono no puede consumirse dos veces (`from_order_deposit_id` único) |
| `orders` | **Sí** | `rev` (bloqueo optimista) | Con `baseRev` desfasado ⇒ `conflict` + estado del servidor; el cliente rebasa y reenvía con **nuevo** `mutationId`. Si está `procesado` o `cancelado` ⇒ **rechazo permanente** `terminal_state`: el cliente descarta su mutación y adopta el servidor |
| `orders.status` | **Sí** | — | **Máquina de estados monótona**: `pendiente(0) → preparacion(1) → listo(2) → procesado(3)`; `cancelado` es rama terminal. Una transición offline que retrocede (llega `preparacion` cuando el servidor ya está en `listo`) se **ignora** y se audita, no se aplica. Así dos dispositivos que empujan el pedido hacia adelante nunca pelean |
| `order_items` | con su pedido | `rev` del pedido | Se reemplazan en bloque. El servidor **recalcula** `total_usd` (jamás lo acepta del cliente) |
| `order_deposits` | **Sí** | PK propia + `rev` propio | **Siempre se fusionan** (append-only, idempotente por PK): dos cajas que abonaron sin verse conservan los dos abonos. Si la suma pasa del total, **no se rechaza**: el excedente aparece como `overpaidUsd` — caso que el frontend ya modela. En línea sí se valida contra el saldo (como hoy). Anular es idempotente y gana sobre no anular |
| `inventory_movements` | **Sí** | append-only | Idempotente por PK. `entrada`/`ajuste` conmutan; una `salida` se recorta al stock disponible al aplicar (nunca deja el stock negativo), así que el orden de aplicación decide cuánto se descuenta, no si cuadra. `ajuste` se resuelve **en el momento de aplicar** (`delta = qty − stock_actual`). Jamás se editan ni se borran (trigger) |
| `products` (catálogo) | Sí, con reservas | `rev` | Parche con LWW **por campo**. `stock` **no es escribible**: sólo cambia por movimiento. Al crear, `code` repetido **o retirado** ⇒ recodificación + `renumbered` (vía sync, `allowRecode`); por HTTP directo (sin `allowRecode`) ambos casos siguen siendo rechazo (409 `conflict`/`retired_code`). Al editar, código retirado ⇒ rechazo siempre |
| `product_prices`, `price_group_prices` | Sí | `rev` del padre | LWW **por celda** `(padre, tipo de precio)`: dos dispositivos que cambian Mayor y Detal sobreviven los dos |
| `price_groups` | Sí | `rev` | LWW por campo en nombre/regla; los precios, por celda |
| `customers` | **Sí** | `rev` | Parche con LWW por campo. Alta con `cedula` ya existente ⇒ **se fusiona** con la fila existente y la respuesta trae `idMap: { localId → serverId }`; el cliente reapunta sus pedidos/ventas locales |
| `exchange_rates` | **Sí** | append-only | Sólo INSERT, idempotente por PK. Varias tasas de la misma fuente coexisten: es un log. La "vigente" es la de `created_at` mayor. Recomendado: que el **servidor** sea el único publicador automático (§6.6) |
| `daily_closures` | Sí | `date` única | Si ya existe cierre de ese día, gana el primero y se devuelve el existente (`already_closed`). El borrador lo calcula el servidor y su número es el bueno |
| `audit_log` | **Sí** | append-only | Sólo INSERT, idempotente por PK. El cliente sube sus asientos offline y recibe la cola reciente |
| `users`, `roles`, `role_permissions` | **No** | `rev` | `online_only`. Una cola offline podría resucitar a un usuario revocado o devolverle permisos: la separación es de seguridad, no de comodidad |
| `payment_methods`, `price_types`, `categories` | **No** | `rev` | `online_only`: son configuración de bajísima frecuencia y el conflicto no compensa |
| `company_settings` | **No** | `rev` | `online_only`. `sale_next`/`order_next` **nunca** se aceptan de un cliente |

### Usuario desactivado con cola pendiente

Una mutación en cola de un usuario que ya fue desactivado **se acepta si su
timestamp de cliente (acotado) es anterior a `deactivated_at`**, y se rechaza si
es posterior. Ambos casos se auditan. Razón: esas mutaciones son hechos de
negocio que ya ocurrieron (una venta, dinero que entró); descartarlas sería
perder dinero del registro. Lo que no se permite es que siga operando después de
la revocación.

### Retryable vs permanente

La cola del cliente **tiene que** distinguirlos o entra en bucle infinito:

| `status` | Significado | Qué hace el cliente |
|---|---|---|
| `applied` | Aplicada | Saca de la cola, reemplaza su copia por `serverEntity` |
| `duplicate` | Ya estaba aplicada | Saca de la cola (igual que `applied`) |
| `conflict` | Base desfasada | Adopta `serverEntity`, rebasa, **reenvía con nuevo `mutationId`** o pide intervención del usuario |
| `rejected` | Permanente (estado terminal, validación, `online_only`, permisos) | **Saca de la cola** y avisa al usuario. Nunca reintenta |
| error de red / 5xx | Transitorio | Reintenta con backoff, mismo `mutationId` |

---

## 6 · Contrato de API

### 6.1 · Convenciones

- Base: `/api/v1`. JSON en camelCase (igual que los tipos del frontend).
- `Authorization: Bearer <accessToken>` + `X-Device-Id: <uuid>` en todo lo que no
  sea login.
- **Dinero y cantidades como números JSON**, no strings: los tipos del frontend
  son `number` y cambiar el formato obligaría a tocarlo. El servidor redondea a
  la escala de la columna al escribir. Contrapartida a respetar en el backend:
  **las sumas de informes se hacen en SQL con `numeric`**, nunca acumulando
  `number` en JS.
- `rev` viaja como número en cada entidad y hace de ETag.
- Errores: `{ error: { code, message, details? } }` con códigos estables
  (`unauthorized`, `forbidden`, `validation_failed`, `conflict`,
  `cursor_too_old`, `terminal_state`, `order_already_billed`, `online_only`,
  `already_closed`, `dependency_failed`).
- Los permisos se **aplican en el servidor**. Los del frontend son sólo UX.

### 6.2 · Autenticación

```
POST /api/v1/auth/login
  { username, password, device: { id, name?, userAgent? } }
→ { accessToken, accessExpiresIn, refreshToken, refreshExpiresAt,
    user: { id, username, fullName, email, roleId, active },
    permissions: ["view_sales", ...],
    cursor, serverTime, schemaVersion }

POST /api/v1/auth/refresh   { refreshToken }  → tokens nuevos (rotación)
POST /api/v1/auth/logout    { refreshToken }  → 204
GET  /api/v1/auth/me                          → { user, permissions, serverTime }
```

- `password_hash` (argon2id) **jamás** sale del servidor. El `User.password` en
  texto plano del frontend desaparece del wire.
- Access 15 min, refresh 30 días con rotación y detección de reutilización.
- Los usuarios `system = true` no pueden iniciar sesión (además hay un CHECK que
  los obliga a estar inactivos).
- **Login offline**: tras un login en línea correcto, el dispositivo guarda un
  verificador derivado **en el cliente** (PBKDF2/WebCrypto sobre la contraseña
  con sal por dispositivo). Permite volver a entrar sin red **en ese
  dispositivo**, caduca a los `OFFLINE_SESSION_MAX_DAYS` y se revalida al
  reconectar. El servidor no manda nada reutilizable.

### 6.3 · Estado inicial

```
GET /api/v1/bootstrap
→ { cursor, serverTime, schemaVersion,
    window: { days, from, to },
    company, roles, users, categories, priceTypes, priceGroups, products,
    paymentMethods, rates, customers, orders, sales, movements, closures,
    audit, retiredProductCodes }
```

La forma es la de `AppState` (sin `sessionUserId`, con `cursor`) para que el
frontend hidrate su caché directamente.

**Es una ventana, no el histórico completo.** Manda: catálogo, configuración,
clientes, usuarios y roles completos; tasas de los últimos 30 días más la vigente
de cada fuente; **todos** los pedidos no terminales más los terminales de la
ventana; ventas y movimientos de `BOOTSTRAP_WINDOW_DAYS` (30); cierres de 90
días; las últimas 200 entradas de bitácora. Lo viejo se consulta con los
endpoints paginados, en línea. Una caché offline no puede ser el libro mayor.

### 6.4 · Delta

```
GET /api/v1/sync?since=<cursor>&limit=500
→ { cursor, hasMore, serverTime,
    changes: { company?, roles[], users[], categories[], priceTypes[],
               priceGroups[], products[], paymentMethods[], rates[],
               customers[], orders[], orderDeposits[], sales[], movements[],
               closures[], audit[] },
    deletions: [ { entity, id } ],
    bootstrapRequired?: boolean }
```

- `since` es un **cursor opaco** (internamente el `rev`). No interpretarlo como
  fecha.
- Agregados completos; el cliente hace upsert por id. Reaplicar es inocuo.
- **Orden de aplicación** (por FK): `company` → `categories` → `priceTypes` →
  `priceGroups` → `products` → `paymentMethods` → `roles` → `users` →
  `customers` → `orders` → `orderDeposits` → `sales` → `movements` → `closures`
  → `audit` → `deletions`.
- Paginación: si hay más de `limit`, `hasMore: true` y `cursor` = el `rev` del
  último agregado entregado (los `rev` son únicos, así que el corte es exacto y
  nunca parte un agregado). El cliente vuelve a pedir de inmediato.
- Si `since` es más viejo que la retención de tombstones ⇒ `410` con
  `bootstrapRequired: true`.
- Efecto secundario: actualiza `devices.last_seen_at` y `last_cursor`.

### 6.5 · Subir la cola offline

```
POST /api/v1/sync
  { deviceId, cursor,
    mutations: [ { mutationId, entity, op, at, baseRev?, payload } ] }
→ { cursor, serverTime,
    results: [ { mutationId, status, entityId?, serverEntity?,
                 idMap?, renumbered?, reason?, retryable } ] }
```

- Se aplican **en orden**, cada una en **su propia transacción**: una mutación
  mala no bloquea la cola. Si una depende de una entidad que falló, sale
  `rejected` con `dependency_failed`.
- `status` ∈ `applied | duplicate | conflict | rejected` (§5).
- `idMap: [{ entity, localId, serverId }]` cuando hubo fusión por clave natural.
- `renumbered: { from, to }` cuando el servidor reasignó número o código.

Catálogo de operaciones:

| `entity` | `op` | Offline | Notas |
|---|---|---|---|
| `sale` | `create` | ✅ | Mueve inventario y consume los abonos del pedido |
| `sale` | `void` | ✅ | Devuelve stock. Idempotente |
| `order` | `create` | ✅ | Admite un abono adelantado en el mismo acto |
| `order` | `update` | ✅ | Parche + `baseRev`. Las líneas se reemplazan en bloque |
| `order` | `status` | ✅ | Sólo hacia adelante |
| `order` | `delete` | ✅ | Se niega si tiene abonos vigentes (como el frontend) |
| `orderDeposit` | `create` / `void` | ✅ | Siempre se fusiona |
| `movement` | `create` | ✅ | `ajuste` se resuelve al aplicar |
| `customer` | `create` / `update` | ✅ | Fusión por cédula |
| `product` | `create` / `update` | ✅ | Sin `stock` |
| `productPrice` / `priceGroupPrice` | `set` | ✅ | Por celda |
| `priceGroup` | `create` / `update` | ✅ | |
| `rate` | `create` | ✅ | |
| `closure` | `create` | ✅ | Uno por día |
| `audit` | `append` | ✅ | |
| `user`, `role`, `paymentMethod`, `priceType`, `category`, `company` | — | ❌ | `rejected: online_only` |

### 6.6 · Endpoints de dominio (en línea)

Para lo que no cabe en la caché o no tiene sentido offline. Todos con permisos y
paginación (`?page=&pageSize=`).

```
GET  /products            ?search=&categoryId=&active=
POST /products            PATCH /products/:id      (If-Match: <rev>)
DELETE /products/:id      → 409 si tiene historial; retira el código
POST /products/:id/movements

GET  /customers ?search=  POST /customers   PATCH /customers/:id

GET  /orders   ?status=&customerId=&from=&to=
POST /orders              PATCH /orders/:id        (If-Match: <rev>)
POST /orders/:id/status
POST /orders/:id/deposits
POST /orders/:id/deposits/:depositId/void
DELETE /orders/:id

GET  /sales    ?from=&to=&status=&customerId=
GET  /sales/:id           POST /sales     POST /sales/:id/void

GET  /rates    ?source=   GET /rates/current      POST /rates
POST /rates/fetch          -- trae la tasa oficial DESDE EL SERVIDOR

GET  /payment-methods     POST /payment-methods   PATCH /payment-methods/:id
DELETE /payment-methods/:id → 409 si tiene pagos/abonos/líneas de cierre;
                               desactívala (active = false) en su lugar

GET  /closures/draft?date=YYYY-MM-DD   -- borrador autoritativo del cierre
POST /closures            GET /closures ?from=&to=

GET  /audit    ?entity=&entityId=&userId=&from=&to=
GET  /company             PATCH /company           (If-Match: <rev>)
GET  /users  POST /users  PATCH /users/:id  POST /users/:id/password
GET  /roles  POST /roles  PATCH /roles/:id

GET  /health              GET /health/db           -- healthcheck de Railway
```

Dos mejoras que conviene hacer aquí y no en el navegador:

- **La tasa la trae el servidor** (`POST /rates/fetch` + cron
  `RATES_FETCH_CRON`). Hoy cada navegador llama a `ve.dolarapi.com` por su
  cuenta: eso multiplica llamadas, sufre CORS y permite que dos cajas cobren a
  tasas distintas el mismo minuto. Con un solo publicador, todos ven la misma
  tasa y un equipo offline la recibe al sincronizar.
- **El borrador del cierre lo calcula el servidor**, que es el único que ve
  todos los dispositivos. El cálculo local del frontend sigue sirviendo sin red,
  pero el bueno es el del servidor.

### 6.7 · `If-Match` y bloqueo optimista

Los `PATCH` de recurso único aceptan `If-Match: <rev>` y responden con `ETag`.
Sin `If-Match` ⇒ `428 Precondition Required` en `orders` y `company` (donde el
choque es real); con `rev` desfasado ⇒ `409 conflict` con el estado actual en el
cuerpo. Es el mismo `baseRev` de `POST /sync`, expresado en HTTP.

---

## 7 · DDL escrito a mano

`prisma/migrations/20260912120000_init/migration.sql` tiene tres bloques: la
secuencia, el cuerpo generado por `prisma migrate diff`, y **el bloque 3 escrito
a mano** con lo que el DSL de Prisma no expresa:

| Objeto | Qué garantiza |
|---|---|
| `sync_rev_seq` | Cursor global (§4.2) |
| `sync_assign_rev` / `sync_assign_rev_on_insert` | `rev` lo pone la base en INSERT y UPDATE, y no se mueve si la fila no cambió |
| `sync_bump_parent_rev` (5 triggers) | Un cambio en una fila hija reenvía el agregado |
| `business_timezone`, `set_business_date_*` (4 triggers) | El día contable no se puede equivocar ni falsear |
| `forbid_row_rewrite` (3 triggers) | `inventory_movements`, `exchange_rates` y `audit_log` son append-only de verdad |
| `products_reject_retired_code` | Un código retirado no vuelve a circular |
| `sales_active_order_uq` (único parcial) | Un pedido no se factura dos veces; anular libera |
| `price_types_single_default_uq` (único parcial) | Un solo tipo de precio por defecto |
| ~35 CHECK | Coherencia del ledger, de la regla de precio, del cierre, de las anulaciones, cédula normalizada, etc. |
| Filas de infraestructura | Rol/usuario `system`, `company_settings` singleton, los 13 códigos retirados |

### Cómo escribir las migraciones siguientes (importante)

Prisma **no ve** nada de lo anterior en su diff. Verificado con todo aplicado, en
las dos direcciones, y las dos salen **vacías**:

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script
npx prisma migrate diff --from-config-datasource            --to-schema prisma/schema.prisma --script
```

Incluye los dos índices únicos **parciales**: Prisma modela el índice pero no su
predicado, así que no los toca. (En la misma corrida se comprobó que ambos
existían y se aplicaban, o sea que el diff vacío no es un falso negativo.)

> **El riesgo real no es el diff, es el DDL fuera de las migraciones.** Todo lo
> de la tabla de arriba vive **dentro de `migration.sql`**. Un objeto creado a
> mano directamente contra una base (un índice añadido por psql "para salir del
> paso") es deuda invisible: cualquier reset por deriva se lo lleva y nadie se
> entera hasta que aparece el dato duplicado que impedía.

Aun así, el flujo seguro para escribir migraciones es:

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --script --output prisma/migrations/<timestamp>_<nombre>/migration.sql
# 1. REVISAR el script: que no traiga DROP contra los objetos de la tabla de arriba
# 2. añadir a mano el DDL nuevo que Prisma no exprese
# 3. commitear
```

Requiere `SHADOW_DATABASE_URL` (una base vacía donde replicar las migraciones).
Usar `prisma migrate dev` a ciegas es lo único peligroso: es el comando que
podría generar un DROP sin que nadie lo lea.

### Trampa que ya está resuelta (no volver a pisarla)

`rev` **no** usa `@default(dbgenerated("nextval('sync_rev_seq')"))`, que sería lo
natural. Prisma lo confunde con una secuencia propiedad de la columna y
`migrate diff` empieza a emitir, por cada tabla:

```sql
ALTER TABLE "..." ALTER COLUMN "rev" SET DEFAULT nextval('sync_rev_seq'),
ALTER COLUMN "rev" DROP DEFAULT;
DROP SEQUENCE "sync_rev_seq";
```

...o sea que la primera migración futura se llevaría el mecanismo entero por
delante. Con `@default(0)` + trigger el diff sale vacío. Comprobado en este
esquema, no es teoría.

### Verificación de la capa de datos

El DDL se aplicó contra un Postgres real (`npx prisma dev`) y se comprobaron 44
invariantes: asignación y no-bump del cursor, bump desde filas hijas, día
contable en Caracas y su no-falsificabilidad, ledger coherente, append-only,
doble facturación de un pedido, abono consumido dos veces, cobro en Bs sin tasa,
cédula sin normalizar, regla de precio incompleta, tipo de precio por defecto
duplicado, código retirado, borrado de producto con historial, tombstone en el
cursor. Conviene rehacer esas comprobaciones como tests de integración cuando
exista el Nest (§9).

---

## 8 · Despliegue en Railway

Mismo patrón que ya usa el frontend (`karelys-pedidos` → `main`,
`karelys-pedidos-test` → `test`): **dos servicios en el proyecto `hayai`**
(workspace Cortexa, ambiente `production`), apuntando al mismo repo y a ramas
distintas.

| Servicio | Rama | Base de datos |
|---|---|---|
| `hayai-pedidos-backend` | `main` | `karelys_prod` |
| `hayai-pedidos-backend-test` | `test` | `karelys_test` |

**Un solo Postgres, dos bases.** El plugin de Railway entrega una única
`DATABASE_URL` apuntando a la base `railway`, así que las dos bases se crean una
vez a mano:

```sql
CREATE DATABASE karelys_prod;
CREATE DATABASE karelys_test;
```

y en cada servicio se pone la `DATABASE_URL` completa con el nombre
correspondiente (no `${{Postgres.DATABASE_URL}}` a secas, que llevaría a
`railway` y mezclaría los datos). Alternativa si no se pudiera crear bases:
esquemas separados con `?schema=test`, que Prisma soporta igual de bien.

Comandos:

```
Build:  npm ci && npx prisma generate && npm run build
Start:  npx prisma migrate deploy && node dist/main.js
```

- `prisma generate` es **obligatorio** en build: el cliente está en
  `src/generated/` y no se versiona.
- `migrate deploy` en el arranque es seguro con varias réplicas (Prisma toma un
  lock de aviso) y **no** necesita shadow database.
- Healthcheck: `/api/v1/health`.
- Variables: las de `.env.example`. `JWT_*` **distintas** entre prod y test.

`railway.json` que conviene añadir cuando exista el Nest:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS", "buildCommand": "npx prisma generate && npm run build" },
  "deploy": {
    "startCommand": "npx prisma migrate deploy && node dist/main.js",
    "healthcheckPath": "/api/v1/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

### Primera puesta en marcha

1. `migrate deploy` crea el esquema y las filas de infraestructura.
2. **Seed del catálogo** (pendiente, §9): categorías, tipos de precio, formas de
   pago, roles, usuario administrador, productos y `ensureColdCakeFamily`
   equivalente. La forma canónica está en
   `C:\dev\karelys-pedidos\src\lib\seed.ts` y `catalog.ts`.
3. **Importación del estado real**: el dispositivo que hoy tiene el
   `localStorage` bueno sube su `AppState` por un endpoint de importación
   `POST /admin/import` (una sola vez, idempotente por id). Es el camino que
   preserva los ids semánticos y evita rehacer el catálogo a mano.

---

## 9 · Estructura de carpetas y por dónde seguir

Decisión: **el proyecto NestJS va en la raíz del repo**, no en `backend/`. Es lo
que hace que los dos servicios de Railway funcionen sin configurar
"root directory" por servicio, y es la disposición estándar de un Nest con
Prisma.

Lo que ya está:

```
/
├─ ARCHITECTURE.md          ← este documento
├─ README.md
├─ package.json             ← mínimo: prisma, @prisma/client, adapter-pg, dotenv
├─ prisma7.config.ts        ← config del CLI de Prisma 7 (la URL va aquí, no en el schema)
├─ .env.example
├─ .gitignore
└─ prisma/
   ├─ schema.prisma
   └─ migrations/
      ├─ migration_lock.toml
      └─ 20260912120000_init/migration.sql
```

Lo que monta D.A.N.I encima (`nest new` en la raíz, conservando estos archivos):

```
src/
├─ main.ts                  ← CORS con CORS_ORIGINS, ValidationPipe global, prefijo /api/v1
├─ app.module.ts
├─ generated/prisma/        ← cliente de Prisma (NO se versiona)
├─ prisma/                  ← PrismaModule + PrismaService
├─ auth/                    ← login, refresh, JwtStrategy, PermissionsGuard, @RequirePermission()
├─ sync/                    ← bootstrap.controller · sync.controller · sync.service
│  └─ mutations/            ← un handler por (entity, op); tabla de conflictos del §5
├─ catalog/                 ← products, categories, price-types, price-groups
├─ customers/
├─ orders/                  ← pedidos + abonos (orderBalance derivado, nunca persistido)
├─ sales/                   ← createSale/void: inventario, abonos, numeración
├─ inventory/               ← ledger + caché de stock
├─ rates/                   ← CRUD + cron de la tasa oficial
├─ closures/                ← borrador y cierre por business_date
├─ audit/
├─ company/
├─ admin/                   ← importación inicial del AppState
└─ common/                  ← filtro de errores, DTOs, Decimal↔number, cursor, business-date
test/                       ← integración contra Postgres real (ver §7)
```

Arranque del cliente en Prisma 7 (**no** es la API de Prisma 5/6: hace falta
driver adapter y el cliente se importa de `src/generated`):

```ts
// src/prisma/prisma.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
```

Dependencias a añadir: `@nestjs/{common,core,platform-express,config,jwt,passport,schedule,throttler}`,
`passport-jwt`, `argon2`, `class-validator`, `class-transformer`, `decimal.js`.

Base local para desarrollar sin Postgres instalado:

```bash
npx prisma dev            # levanta un Postgres local y muestra DATABASE_URL
npx prisma migrate deploy # aplica la migración inicial
```

Orden sugerido de trabajo:

1. `nest new` en la raíz + `PrismaService` + `/health`.
2. `auth` (el resto depende del `userId`).
3. Seed del catálogo + `POST /admin/import`.
4. `GET /bootstrap` y `GET /sync` (lectura primero: el frontend ya puede leer).
5. `POST /sync` con los handlers de mutación, empezando por `sale.create`,
   `order.*` y `orderDeposit.*`, que son los que llevan dinero.
6. Endpoints de dominio e informes.
7. Tests de integración con las 44 invariantes del §7 como base.

---

## 10 · Impacto en el frontend

No se ha tocado `C:\dev\karelys-pedidos`. Lo que va a necesitar:

1. **Capa de repositorio** entre la UI y el estado: hoy `store.tsx` muta y
   persiste en `localStorage`. Pasa a ser caché + cola de mutaciones con
   `mutationId`.
2. **Las actualizaciones se encolan como parche**, no como snapshot (§5).
3. **Adoptar el número y los ids que devuelve el servidor** (`renumbered`,
   `idMap`).
4. **Marcar como provisional** todo ticket emitido offline: puede renumerarse.
5. **`User.password` desaparece** del estado: la autenticación es del servidor.
   El login offline usa un verificador derivado por dispositivo.
6. **El histórico ya no está completo en local**: informes y ventas viejas pasan
   a consultas en línea paginadas.
7. **Usar el `businessDate` del servidor** en el cierre, en lugar de
   `createdAt.slice(0,10)` (que hoy cuenta mal las ventas de después de las
   20:00 hora de Caracas).
8. **Dejar de llamar a `ve.dolarapi.com` desde el navegador**: la tasa la publica
   el backend.
9. `stock` es de lectura: se cambia registrando un movimiento.
10. Distinguir en la cola `rejected` (descartar y avisar) de error de red
    (reintentar).

---

## 11 · Pendientes y decisiones abiertas

Para consultar con el dueño (no bloquean el arranque; asumí la opción estándar y
la dejo anotada):

1. **Precio real de "Oreo y Brownie" (`P059`)** — el `$1,30 / $1,36` actual se
   alineó a "Torta Quesillo" por falta de dato, no es un precio del negocio.
2. **¿Una sola caja?** `daily_closures.date` es única, o sea un cierre por día.
   Con dos cajas la clave pasaría a `(date, register_id)`.
3. **¿Se puede refacturar un pedido tras anular su venta?** Asumí que sí (el
   índice único parcial sólo cuenta las ventas `completada`).
4. **Tickets provisionales**: hace falta decidir cómo se ve un ticket offline que
   luego se renumera (§3.2).
5. **¿Los cajeros pueden editar el catálogo offline?** Hoy lo permito con LWW por
   campo. Si el negocio prefiere que el catálogo sea sólo en línea, es cambiar
   una línea en la tabla de operaciones.
6. **Retención**: bitácora completa para siempre, tombstones 90 días,
   idempotencia 30 días. Revisable.
7. **Multitenancy**: no está. Si HAYAI acaba vendiendo esto a más negocios, el
   camino es `tenant_id` + RLS (`FORCE ROW LEVEL SECURITY`, GUC `app.tenant_id`
   con `SET LOCAL`) sobre este mismo esquema; las PK TEXT y el cursor global no
   estorban. Lo que sí habría que rehacer es la unicidad (`cedula`, `code`,
   `number` pasan a ser únicas **por tenant**) y la secuencia del cursor
   (una global sigue valiendo, pero filtrada por tenant en el delta). Mejor
   hacerlo cuando exista el requisito, no "por si acaso".
