# TEMPLE Minimundo — backend

Recibe las ventas del sistema de ventas por webhook, las guarda, y las empuja
en vivo al mundo 3D que muestra los locales sobre el mapa de Buenos Aires.

Proceso único Node/Express + SQLite, como Aperturas. Sin build step.

```bash
npm install
npm run dev               # nodemon
npm start                 # producción
npm run probar            # smoke test del circuito de ventas
npm run probar:objetivos  # el ida y vuelta de la planilla de objetivos
npm run probar:clima      # el sol contra efemérides conocidas, y el clima
```

Node ≥ 20.

---

## Deploy

Igual que Aperturas: Railway con nixpacks, push a git → auto-deploy.

**El server no arranca sin `APP_PASSWORD` propia** (mínimo 8 caracteres) cuando
detecta que está en un servidor — mira `NODE_ENV=production` y también las
variables que Railway setea solo, para no depender de que alguien se acuerde.
Un deploy al que se le olvidó la variable dejaría la facturación de la cadena
en internet con la clave de ejemplo.

Las claves generadas para este proyecto están en **`.env`** (que está en
`.gitignore`, no se commitea). Son las mismas que hay que cargar en Railway.

```bash
# 1 · subir el código
git push -u origin main

# 2 · entrar a Railway (abre el navegador)
railway login

# 3 · crear el proyecto y vincular esta carpeta
railway init

# 4 · variables del servicio
railway variables --set APP_PASSWORD=... --set HOOK_SECRET=... \
  --set DATA_DIR=/data --set NODE_ENV=production
```

Después, en el dashboard:

- **Volumen** montado en `/data`. Sin esto la base se pierde en cada redeploy.
- **Source** → conectar `juanichere/temple-minimundo` para el auto-deploy.
- **Generate domain**.

Para verificar: `GET /salud` tiene que devolver `"hook": "firma"`. Si dice
`"sin configurar"`, falta `HOOK_SECRET` y el webhook va a rechazar todo.

El `SIMULADOR` queda en `0`: en producción está bloqueado salvo que se habilite
a mano con `SIMULADOR_EN_PROD=1`, justamente para que no entre facturación
inventada al tablero real.

El clima no necesita ninguna variable para andar. `CLIMA_API_KEY` sólo hace
falta con la licencia comercial de Open-Meteo, y `CLIMA_OFF=1` lo apaga.
`GET /salud` dice en qué modo está.

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
- `GET /api/clima` — el clima de cada local. Siempre 200: si la API de afuera
  no contesta devuelve `ok: false` con el motivo y el tablero sigue andando.
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

**El alta de locales sólo agrega, y las correcciones van aparte.** El seed no
pisa un local que ya existe: si alguien cargó un objetivo o un `pos_id` a mano,
el próximo deploy no se lo lleva puesto. El precio es que un dato **mal**
sembrado se queda mal para siempre en una base que ya existe — y las
coordenadas salieron de geocodificar direcciones, así que va a volver a pasar.
Para eso está `CORRECCIONES` en `server.js`: cada una se aplica **una vez** y se
marca en `ajustes`, así que si después alguien edita ese campo a mano, el deploy
siguiente lo respeta. Así se movió Temple Lab de Las Heras a Gorriti sin tocar
la base a mano ni perder nada.

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
- **Objetivo del mes.** Es el número que manda.
- **Objetivo de hoy.** Sale de repartir el del mes; no se edita a mano.

Los importes entran como se escriben acá: `1.850.000,50`, `400.000.000` y
`12500.75` se leen los tres bien.

### El mes manda, no el día

**Administración fija el objetivo del MES y el de cada día sale de repartirlo**
según cuánto pesa ese día de la semana. Al revés —pedir un objetivo por día—
serían 365 números por local y nadie los va a cargar.

Y el reparto no es lineal: un sábado pesa 1,35 y un lunes 0,55, así que el
objetivo de un sábado es más del doble que el del lunes aunque el mes sea el
mismo. Los factores están en `locales.js`.

Mientras un mes no tenga objetivo cargado se usa **un estimado** derivado del
`objetivo_diario` del local, que es un valor de arranque inventado para que el
tablero tenga contra qué medir desde el primer día. El panel lo dice en cada
fila: **cargado** o **estimado**. Importa saber cuál de los dos estás mirando
antes de discutir el número.

### Cargar los objetivos por planilla

En **Objetivos por planilla**: se baja una grilla de locales × meses, se llena
en Excel y se vuelve a subir. Mismo ida y vuelta que el presupuesto en
Aperturas, y por la misma razón: el equipo trabaja en Excel.

- Primera columna **Local** (acepta el nombre, el id o el `pos_id`), y una
  columna por mes. Los encabezados entienden `2026-11`, `11/2026`,
  `Noviembre` y `nov-26`.
- También acepta el formato largo: columnas `Local`, `Periodo`, `Objetivo`.
- **Las celdas vacías no tocan nada.** Importar sólo agrega o pisa lo que
  viene; lo que no está en la planilla queda como está, así que se puede subir
  un mes suelto sin arrastrar el resto.
- Siempre pasa por una **previsualización** que sale de leer la planilla
  entera: lo que muestra es exactamente lo que va a pasar, no una estimación
  aparte que puede mentir. Las filas con problemas se listan con su número
  **como lo cuenta Excel**.
- El CSV se lee probando **UTF-8 estricto y, si falla, windows-1252**: Excel en
  Windows guarda en ANSI y leerlo como UTF-8 convierte "Gestión" en basura. El
  que se baja lleva BOM para que Excel respete los acentos.

`npm run probar:objetivos` prueba todo ese ida y vuelta contra un server
corriendo, incluida la aritmética del reparto.

Los dos le pegan a los mismos dos endpoints: `/api/estado` para el snapshot y
`/api/stream` para lo que va pasando.

### El sol se calcula, el clima se pregunta

Son dos cosas distintas y por eso se resuelven distinto.

**La posición del sol es astronomía** (`public/sol.mjs`): da el mismo número
siempre y no depende de que nadie esté arriba. Antes el ciclo día/noche corría
con una ventana fija de 6:40 a 20:00, y eso es falso casi todo el año: en Buenos
Aires el sol se pone a las 17:50 en junio y a las 20:06 en diciembre, y al
mediodía llega a 32° en invierno contra 79° en verano. Ahora el ciclo sale de la
**altura real del sol** para la fecha y las coordenadas, y el sol del mundo 3D
se para en su **azimut real** — así que al mediodía está al norte y las sombras
caen al sur, como corresponde al hemisferio en el que estamos.

Debajo del horizonte no se corta en seco: el crepúsculo civil llega hasta −6° y
se apaga del todo cerca de −12°. Es la media hora en la que la ciudad se prende
y el cielo queda violeta. La luz de la hora dorada sale sola: el sol es naranja
pegado al horizonte y blanco a 14° arriba.

Amanecer y atardecer se buscan **numéricamente** y no con la fórmula cerrada del
ángulo horario: cuesta unas 150 evaluaciones de trigonometría una vez por día y
a cambio no hay que acertarle a los signos ni a las normalizaciones. De yapa, el
día polar sale solo — si el sol nunca cruza el horizonte no hay cruce que
devolver. No es teórico: la cadena llega a Río Gallegos, donde el día de
invierno dura 7 h 48 contra las 9 h 48 de Buenos Aires.

**El clima no se puede calcular**, así que se pide afuera: Open-Meteo, por
`clima.js`. Tres decisiones:

- **Lo pide el servidor, no el navegador.** Un tablero en modo TV abierto todo
  el día haría cientos de pedidos a un tercero; así la respuesta se comparte
  entre todos los tableros conectados y la clave, cuando haya, no viaja al
  cliente. Caché de 10 minutos, que es cada cuánto actualiza la API.
- **Los locales se agrupan por celda del modelo** (0.1°, unos 11 km). Los diez
  de CABA están dentro de diez kilómetros: pedir diez puntos devolvería diez
  veces el mismo número. Dieciocho locales entran en nueve puntos, y van todos
  en una sola request.
- **Si falla, devuelve lo último que funcionó marcado como viejo.** Un dato de
  quince minutos atrás sirve; un hueco en la pantalla, no. Y si nunca funcionó,
  el mundo se dibuja despejado. El clima es un adorno, no una dependencia:
  `/api/clima` nunca contesta otra cosa que un 200.

⚠️ **La API libre de Open-Meteo es para uso no comercial.** Si esto pasa a ser
una herramienta de la empresa corresponde la licencia paga, y es sólo setear
`CLIMA_API_KEY`: con clave el módulo va solo al host de clientes. `CLIMA_OFF=1`
lo apaga del todo.

Lo que el clima le hace al mundo: el cielo se va al gris y el sol pega menos
según el porcentaje de nubes, la niebla sube la densidad de la bruma, la lluvia
cae en rayitas inclinadas con el viento, la nieve en puntos que se mecen, y la
tormenta agrega relámpagos con el trueno 850 ms después, porque el sonido tarda.

⚠️ **Lo que más vende la lluvia no son las gotas: es el asfalto.** Una ciudad
con lluvia y la calle seca se ve falsa, así que el suelo se oscurece y baja su
rugosidad. Y las nubes van a opacidad 0.2 a propósito: una capa opaca encima de
la ciudad taparía justo los locales, que es lo que se mira.

⚠️ Las gotas son **rayitas y no puntos**. Una gota de lluvia vista de lejos es
una raya; con puntos parece nieve.

⚠️ Con el sol en su posición real, el reflejo especular sobre el río cae donde
tiene que caer — y sobre un espejo de 5000 unidades eso es un fogonazo que se
come media pantalla. De día el agua se pone más mate (que además es lo que pasa:
con sol hay viento y oleaje) y de noche vuelve a ser un espejo.

El chip de la barra se muestra **siempre**, aunque no haya clima: el amanecer y
el atardecer se saben igual. Lo que falta en ese caso es la temperatura, no el
chip. Y "Resto del país" trae la temperatura de cada ciudad, que con la cadena
estirada 4000 km de norte a sur es un dato real: hoy iban 21° en Santiago del
Estero contra 5° en Bariloche.

### Temple Lab, la fábrica

`locales.tipo` vale `bar` o `fabrica`, y es lo único que distingue al Lab en los
datos. Con eso el mundo le dibuja **nave, tres tanques de acero y chimenea con
humo** en lugar de un local, y la lista y la ficha le ponen su chapa. Factura
como cualquier otro —tiene barra— así que entra en el ranking y en el objetivo.

Está en **Gorriti 4346, Palermo**, a seis cuadras de Casa Temple y Soho: los
cuatro de la zona entran en el mismo racimo del mapa, y por eso importa lo del
escalonado de las placas que está acá abajo.

La columna `dir_a_confirmar` sigue existiendo y pinta un "dirección a confirmar"
en la ficha. Las coordenadas de los demás locales salieron de geocodificar
direcciones del sitio oficial, así que el día que alguna aparezca corrida hay
dónde marcarlo mientras se averigua.

### A escala, Palermo es Palermo

Casa Temple y Soho están en la misma esquina —Costa Rica 4677 y 4699, veinte
metros— y a 26 unidades de mundo por kilómetro quedarían uno encima del otro.
Se separan, pero **sólo el ancho de una vereda**: 19 unidades, unos 730 metros.

Antes eran 52 —dos kilómetros— y eso mentía fuerte: los mandaba a barrios
distintos y de paso empujaba a Hollywood y a Recoleta, que estaban bien donde
estaban. Mejor dos edificios pegados en la misma esquina, que es lo que son,
aunque se les solape la vereda.

⚠️ Las placas de nombre tienen **tamaño fijo en pantalla**, así que a escala
real se tapan entre ellas. Cada local cuelga la suya a distinta altura, y la
altura sale de **mirar a los vecinos**: el escalón más bajo que no esté usado
por otro local a menos de 90 unidades. Antes era el índice del array módulo 4,
que alcanzaba cuando se separaban dos kilómetros; a escala real, no.

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
