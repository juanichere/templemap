# TEMPLE Minimundo — backend

Recibe las ventas del sistema de ventas por webhook, las guarda, y las empuja
en vivo al mundo 3D que muestra los locales sobre el mapa de Buenos Aires.

Proceso único Node/Express + SQLite, como Aperturas. Sin build step.

```bash
npm install
npm run dev          # nodemon
npm start            # producción
npm run probar       # smoke test del circuito entero contra un server corriendo
```

Node ≥ 20. Deploy en Railway (nixpacks, `railway.toml`). **Hay que setear
`DATA_DIR=/data` con un volumen persistente**, si no la base se pierde en cada
redeploy — el mismo cuidado que en Aperturas.

---

## Lo que hay que mandarle al proveedor del POS

Esta es la parte para reenviar. Todo lo demás es nuestro.

### Endpoint

```
POST https://<nuestro-dominio>/hook/ventas
Content-Type: application/json
```

### Autenticación

Preferimos **firma HMAC**. El proveedor calcula `HMAC-SHA256` del cuerpo crudo
con un secreto compartido y lo manda en hexadecimal:

```
x-temple-firma: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

Si su sistema no soporta firmar, aceptamos un token fijo en un header:

```
x-temple-token: <token que acordemos>
```

**Sin ninguna de las dos configuradas el endpoint rechaza todo con 503.** Falla
cerrado a propósito: un endpoint abierto acá significa que cualquiera inventa
facturación.

### Cuerpo

Una venta, un array de ventas, o `{ "ventas": [...] }`. Mandar un lote por
minuto está perfecto; no hace falta una request por ticket.

```json
{
  "externo_id": "0001-00012345",
  "local": "PM-01",
  "ts": "2026-11-01T23:14:05-03:00",
  "monto": 28400.50,
  "items": 4,
  "medio": "tarjeta"
}
```

| Campo | Obligatorio | Qué es |
|---|---|---|
| `externo_id` | sí | Id del ticket **en el POS**. Es la clave contra la que deduplicamos. |
| `local` | sí | Cómo identifica el POS a la sucursal. Nos pasan la lista y la mapeamos. |
| `ts` | sí | Cuándo se cerró el ticket. ISO 8601 **con zona horaria**. |
| `monto` | sí | Total del ticket, en pesos. Si lo mandan en centavos, avisen. |
| `items` | no | Cantidad de ítems. |
| `medio` | no | Medio de pago. |

### Respuestas

| Código | Qué significa | Qué hacer |
|---|---|---|
| `200` | Todo entró (o ya estaba) | Nada |
| `422` | Algo se rechazó, con el detalle por ticket | **Reintentar el lote** |
| `401` | Firma o token inválidos | Revisar el secreto |
| `400` | El JSON no parsea | Revisar el cuerpo |

```json
{ "recibidas": 3, "nuevas": 2, "repetidas": 0,
  "rechazadas": [{ "externo_id": "0001-9", "error": "monto inválido" }] }
```

**Reintentar es gratis y es lo correcto.** El alta es idempotente por
`(local, externo_id)`: mandar dos veces el mismo ticket no lo cuenta dos veces.
Por eso preferimos devolver 422 y que reintenten antes que tragarnos un error
en silencio y perder ventas.

---

## Conectar el POS de verdad

Cuatro pasos, en orden:

1. **Escribir el adaptador.** En `adaptadores.js` hay una plantilla comentada.
   Traduce el payload del proveedor a nuestra forma y no hace nada más — la
   validación vive en el server, un solo lugar. Después, `POS_ADAPTADOR=<nombre>`.
2. **Mapear los locales.** Cargar en cada local el `pos_id` con el que el POS lo
   identifica, en **Ajustes** (`/monitor.html`). Sin eso, las ventas se rechazan
   con `local desconocido` — a propósito, para que no entren a una sucursal que
   no es. El panel avisa cuántos locales todavía no lo tienen.
3. **Setear `HOOK_SECRET`** (o `HOOK_TOKEN`) y pasarle el valor al proveedor.
4. **Apagar el simulador** y borrar sus datos: `DELETE /api/simulador/datos`.

El histórico se carga mandando los tickets viejos por el mismo webhook. Como el
alta es idempotente, se puede reintentar el backfill las veces que haga falta.

---

## Endpoints

### Público
- `POST /hook/ventas` — el webhook. Auth propia, **ignora la cookie**: un POST
  cross-site desde un navegador no puede inventar ventas.
- `GET /salud` — estado del proceso, sin datos de negocio.

### Con sesión (`POST /api/login` con `{ pass }` deja una cookie y devuelve token)
- `GET /api/estado` — todo lo que necesita el tablero: locales, acumulado del
  día y del mes, objetivos diario y mensual, totales de la cadena.
- `GET /api/stream` — **SSE**. Manda `hola` con el estado completo al conectar y
  después un `venta` por cada ticket. Latido cada 20 s.
- `GET /api/ventas?desde&hasta&local&limite` — histórico.
- `GET /api/locales/:id/dias?mes=YYYY-MM` — facturación por día, para el gráfico.
- `PUT /api/locales/:id/objetivo` `{ diario }`
- `PUT /api/locales/:id/objetivo-mensual` `{ periodo, monto }`
- `PUT /api/locales/:id/pos-id` `{ pos_id }`
- `POST /api/simulador` `{ on, velocidad }` · `DELETE /api/simulador/datos`

**Las lecturas aceptan header `x-token` o cookie; las escrituras, sólo header.**
La cookie hace falta porque `EventSource` no puede mandar headers — el mismo
problema que `<img src>` en Aperturas, y la misma solución. Al ignorar la cookie
en las escrituras, no hay superficie de CSRF.

---

## Decisiones que conviene conocer antes de tocar esto

**El día comercial cierra a las 6 de la mañana.** Una venta de las 3 AM del
sábado es del viernes. Un bar que factura hasta las 4 no puede tener el pico
partido en dos días. El día se calcula al recibir la venta y se **guarda** en la
fila (`dia_com`), porque SQLite no sabe de zonas horarias y agrupar por día en
la consulta sería un dolor.

**Idempotencia por `(local_id, externo_id)`, con índice único.** Los webhooks
reintentan. Cobrar dos veces la misma venta es el peor error posible acá.

**Los agregados se calculan con SQL contra el índice, no se llevan en memoria.**
Así no hay forma de que queden viejos después de un backfill, de borrar los
datos del simulador o del cambio de día.

**El objetivo mensual no es el diario por 30.** Depende de cuántos viernes y
sábados caen, que facturan más del doble que un lunes: se suma día por día con
el factor de cada uno (`locales.js`). Se puede pisar a mano por período con
`PUT /api/locales/:id/objetivo-mensual`.

**Se valida campo por campo.** SQLite no tipa las columnas: un monto que venga
como `"<img onerror=…>"` se guardaría tal cual y después sale impreso en el
tablero. Mismo criterio que en Aperturas.

**El simulador entra por el mismo camino que el webhook** (`registrarVentas`).
Eso es lo que lo hace útil: lo que se prueba con datos falsos es exactamente el
circuito que va a correr con el POS enchufado, no una maqueta aparte. Las ventas
quedan marcadas `origen='simulador'`, se borran con un endpoint, y **el
simulador está bloqueado con `NODE_ENV=production`** salvo que se habilite
explícitamente — no querés facturación inventada en el tablero real.

---

## Front end

- **`public/index.html`** — el mundo 3D. Los locales de TEMPLE sobre el mapa de
  Buenos Aires, facturando en vivo. Es lo que se sirve en `/`.
- **`public/monitor.html`** — tablero de texto con los mismos datos, el
  simulador y el panel de **Ajustes**.

### Ajustes

En `/monitor.html`, abajo de todo. Se edita en la fila —input + `change`, sin
abrir un formulario— igual que los responsables en Aperturas, y **si el server
rechaza, el input vuelve al valor guardado**: dejar en pantalla un número que no
entró es peor que no dejar editar.

- **Clave en el POS** (`pos_id`). Arriba de la tabla avisa cuántos locales
  todavía no la tienen, porque hasta que se carguen sus ventas se rechazan.
- **Objetivo diario.** Es el número contra el que se mide todo el tablero.
  Ojo: los que vienen de fábrica salen de la curva del local y son un valor de
  arranque, no un objetivo de administración. Hay que pisarlos.
- **Objetivo del mes.** Vacío = derivado del diario día por día. Si se carga un
  número, manda ese; vaciarlo vuelve al derivado.

Los importes entran como se escriben acá: `1.850.000,50`, `400.000.000` y
`12500.75` se leen los tres bien.

Los dos le pegan a los mismos dos endpoints: `/api/estado` para el snapshot y
`/api/stream` para lo que va pasando.

### Dos mundos: ciudad y país

El toggle **País / Ciudad** cambia entre dos mundos a escalas distintas, y no
es alejar la cámara: entre uno y otro hay un factor 230, así que a escala de
país los edificios de CABA no llegarían a un píxel.

- **Ciudad** — los 9 locales porteños sobre el mapa de Buenos Aires.
- **País** — la cadena entera sobre Argentina. Los 9 de CABA entran como **un
  solo marcador**, que además es la puerta a la vista ciudad: a esa escala CABA
  mide 2 unidades y los nueve quedarían uno encima del otro.

El ranking acompaña: en ciudad son los locales de CABA, en país son los
marcadores, con Buenos Aires contando como uno. Los totales de la cadena no
cambian entre vistas — lo que cambia es cómo se agrupan.

El contorno del país es `public/argentina.json`, un polígono simplificado de
Natural Earth (2 KB). Si no carga, la vista ciudad sigue andando y lo único que
pasa es que el toggle no aparece.

### Cómo arranca el mundo

1. Pide `/api/estado`. Si vuelve 401, muestra la puerta de contraseña.
2. Con el snapshot **construye la ciudad**: cuántos locales hay, dónde están y
   cuáles van en el mapa lo decide el server, no el HTML.
3. Se engancha al stream. El evento `hola` trae el estado completo, y cada
   `venta` suma a los totales y dispara el pulso, la moneda y el sonido.

**El snapshot pisa los totales, no los suma.** Por eso una reconexión después
de un corte deja todo bien sin tener que adivinar qué eventos se perdieron: el
stream manda un `hola` nuevo cada vez que reconecta. Además se resincroniza
sola cada 5 minutos, que es también cómo se entera del cambio de día y de mes.

**El reloj es el de Buenos Aires**, no el del navegador: esto se puede estar
mirando desde cualquier lado.

El prototipo que anda como artifact es otra cosa: tiene su propio simulador
adentro y sirve para mostrarlo sin levantar nada. **No puede ser el front de
producción**, porque ahí corre con una CSP que bloquea `fetch` a cualquier host
y no puede consumir esta API.
