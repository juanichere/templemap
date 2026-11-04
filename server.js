'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const {
  LOCALES, PERFILES, FACTOR_DIA, INICIO_DIA,
  sumaFactores, objetivoMensual, objetivoDelDia,
} = require('./locales');
const { adaptar, ADAPTADORES } = require('./adaptadores');
const { climaDe } = require('./clima');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'minimundo.db');

// "Esto no es la compu de alguien": Railway siempre setea sus propias
// variables, así que alcanza con mirarlas y no depender de que alguien se
// haya acordado de poner NODE_ENV.
const EN_SERVIDOR = process.env.NODE_ENV === 'production'
  || !!process.env.RAILWAY_ENVIRONMENT
  || !!process.env.RAILWAY_SERVICE_ID;

const APP_PASSWORD = process.env.APP_PASSWORD || (EN_SERVIDOR ? '' : 'temple123');
const HOOK_SECRET = process.env.HOOK_SECRET || '';
const HOOK_TOKEN = process.env.HOOK_TOKEN || '';
const POS_ADAPTADOR = process.env.POS_ADAPTADOR || 'generico';

const TZ = 'America/Argentina/Buenos_Aires';
const EN_PROD = process.env.NODE_ENV === 'production';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS locales (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  dir TEXT DEFAULT '',
  barrio TEXT DEFAULT '',
  lat REAL, lng REAL,
  en_mapa INTEGER DEFAULT 1,
  pos_id TEXT DEFAULT '',                -- cómo lo llama el sistema de ventas
  objetivo_diario INTEGER DEFAULT 0,
  ticket_prom INTEGER DEFAULT 0,
  pico INTEGER DEFAULT 0,                -- sólo lo usa el simulador
  perfil TEXT DEFAULT 'noche',           -- sólo lo usa el simulador
  tipo TEXT DEFAULT 'bar',               -- 'bar' | 'fabrica' (la cervecería)
  dir_a_confirmar INTEGER DEFAULT 0,     -- la dirección es la mejor conjetura
  activo INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id TEXT NOT NULL REFERENCES locales(id),
  externo_id TEXT NOT NULL,              -- id del ticket en el POS
  ts TEXT NOT NULL,                      -- ISO, cuándo se cerró el ticket
  dia_com TEXT NOT NULL,                 -- día comercial YYYY-MM-DD (cierra 06:00)
  monto REAL NOT NULL,
  items INTEGER,
  medio TEXT,
  origen TEXT DEFAULT 'hook',            -- hook | simulador
  recibido_en TEXT DEFAULT (datetime('now'))
);

-- La clave de la idempotencia. Un webhook reintenta, y cobrar dos veces la
-- misma venta es el peor error posible acá.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_externo ON ventas(local_id, externo_id);
CREATE INDEX IF NOT EXISTS idx_ventas_dia ON ventas(dia_com, local_id);

CREATE TABLE IF NOT EXISTS objetivos (
  local_id TEXT NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
  periodo TEXT NOT NULL,                 -- YYYY-MM
  monto INTEGER NOT NULL,
  PRIMARY KEY (local_id, periodo)
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  creado TEXT DEFAULT (datetime('now')),
  ultimo_uso TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
`);

// Migraciones chicas: CREATE TABLE IF NOT EXISTS no agrega columnas nuevas a
// una base que ya existe.
{
  const cols = db.prepare('PRAGMA table_info(ventas)').all().map(c => c.name);
  if (!cols.includes('hora_local')) {
    db.exec('ALTER TABLE ventas ADD COLUMN hora_local INTEGER');
  }
  // La base de producción ya existe, así que CREATE TABLE IF NOT EXISTS no le
  // agrega una columna: hay que pedirla.
  const cl = db.prepare('PRAGMA table_info(locales)').all().map(c => c.name);
  if (!cl.includes('tipo')) db.exec("ALTER TABLE locales ADD COLUMN tipo TEXT DEFAULT 'bar'");
  if (!cl.includes('dir_a_confirmar')) {
    db.exec('ALTER TABLE locales ADD COLUMN dir_a_confirmar INTEGER DEFAULT 0');
  }
}

// Alta de locales: sólo agrega los que faltan. Si alguien editó un objetivo o
// cargó el pos_id a mano, no se lo pisamos en el próximo deploy.
{
  const existe = db.prepare('SELECT 1 FROM locales WHERE id = ?');
  const insertar = db.prepare(`
    INSERT INTO locales (id, nombre, dir, barrio, lat, lng, en_mapa, pos_id,
                         objetivo_diario, ticket_prom, pico, perfil, tipo,
                         dir_a_confirmar, activo)
    VALUES (@id, @nombre, @dir, @barrio, @lat, @lng, @en_mapa, @pos_id,
            @objetivo_diario, @ticket, @pico, @perfil, @tipo,
            @dir_a_confirmar, @activo)`);
  const tx = db.transaction(ls => { for (const L of ls) if (!existe.get(L.id)) insertar.run(L); });
  tx(LOCALES);
}

/* Correcciones puntuales a datos ya sembrados.

   El alta de arriba sólo agrega los que faltan, a propósito: así un objetivo o
   un pos_id cargado a mano no se pierde en el próximo deploy. Pero eso también
   significa que un dato MAL sembrado se queda mal para siempre en una base que
   ya existe — y las coordenadas de los locales salieron de geocodificar
   direcciones, así que alguna más va a estar corrida.

   Cada corrección se aplica UNA vez y se marca. Si después alguien la edita a
   mano, el próximo deploy no se la pisa. */
const CORRECCIONES = [
  // El Lab estaba sembrado en Av. Las Heras 1822, que era la mejor conjetura
  // que había antes de que la empresa pasara la dirección de verdad.
  { clave: 'lab_gorriti', id: 'lab', campos: {
    dir: 'Gorriti 4346', barrio: 'Palermo',
    lat: -34.593929, lng: -58.424871, dir_a_confirmar: 0,
  } },
];

{
  const hecha = db.prepare('SELECT 1 FROM ajustes WHERE clave = ?');
  const marcar = db.prepare(
    "INSERT OR REPLACE INTO ajustes (clave, valor) VALUES (?, datetime('now'))");
  const tx = db.transaction(() => {
    for (const c of CORRECCIONES) {
      const clave = `correccion_${c.clave}`;
      if (hecha.get(clave)) continue;
      const cols = Object.keys(c.campos);
      db.prepare(`UPDATE locales SET ${cols.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`)
        .run({ ...c.campos, id: c.id });
      marcar.run(clave);
    }
  });
  tx();
}

// ---------------------------------------------------------------------------
// Fechas
//
// El día comercial cierra a las 6 de la mañana: una venta de las 3 AM del
// sábado es del viernes. Se calcula acá y se GUARDA en la fila, porque SQLite
// no sabe de zonas horarias y agrupar por día en la consulta sería un dolor.
// ---------------------------------------------------------------------------
const fmtDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

function diaComercial(fecha) {
  const t = new Date(fecha).getTime() - INICIO_DIA * 3600000;
  return fmtDia.format(new Date(t));           // YYYY-MM-DD
}

// La hora local de la venta, guardada en la fila por el mismo motivo que el
// día: SQLite no sabe de zonas horarias y el tablero agrupa por hora.
const fmtHora = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', hourCycle: 'h23',
});
const horaLocal = fecha => Number(fmtHora.format(new Date(fecha)));

function diaAnterior(dia) {
  const [a, m, d] = dia.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d) - 86400000);
  return t.toISOString().slice(0, 10);
}

function limitesMes(dia) {
  const [a, m] = dia.split('-').map(Number);
  const desde = `${a}-${String(m).padStart(2, '0')}-01`;
  const sig = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
  return { desde, hasta: sig, periodo: desde.slice(0, 7), anio: a, mes: m };
}

const hoyComercial = () => diaComercial(new Date());

// ---------------------------------------------------------------------------
// Locales en memoria y resolución de claves
// ---------------------------------------------------------------------------
let LOC = [];
let PORID = new Map();

const normalizar = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .trim().toLowerCase();

function cargarLocales() {
  LOC = db.prepare('SELECT * FROM locales ORDER BY en_mapa DESC, nombre').all();
  PORID = new Map();
  for (const L of LOC) {
    PORID.set(normalizar(L.id), L.id);
    PORID.set(normalizar(L.nombre), L.id);
    if (L.pos_id) PORID.set(normalizar(L.pos_id), L.id);
  }
}
cargarLocales();

const resolverLocal = clave => (clave == null ? null : PORID.get(normalizar(clave)) || null);

// ---------------------------------------------------------------------------
// Validación
//
// SQLite no tipa las columnas: un monto que venga como "<img onerror=...>" se
// guarda tal cual y después sale impreso en el tablero. Se valida campo por
// campo lo que es cada cosa, igual que en Aperturas.
// ---------------------------------------------------------------------------
const MAX_MONTO = 1e12;
const FUTURO_OK = 36 * 3600000;                // 36 h de tolerancia de reloj
const PASADO_OK = 5 * 365 * 24 * 3600000;

function validar(cruda) {
  const externo_id = String(cruda.externo_id ?? '').trim();
  if (!externo_id || externo_id.length > 120) return { error: 'externo_id inválido' };

  const local_id = resolverLocal(cruda.local);
  if (!local_id) return { error: `local desconocido: ${String(cruda.local).slice(0, 40)}` };

  const t = new Date(cruda.ts ?? '').getTime();
  if (!Number.isFinite(t)) return { error: 'ts no es una fecha' };
  const ahora = Date.now();
  if (t > ahora + FUTURO_OK) return { error: 'ts en el futuro' };
  if (t < ahora - PASADO_OK) return { error: 'ts demasiado viejo' };

  const monto = Number(cruda.monto);
  if (!Number.isFinite(monto) || monto <= 0 || monto > MAX_MONTO) {
    return { error: 'monto inválido' };
  }

  let items = cruda.items == null ? null : Math.trunc(Number(cruda.items));
  if (items != null && (!Number.isFinite(items) || items < 0 || items > 9999)) items = null;

  let medio = cruda.medio == null ? null : String(cruda.medio).slice(0, 40);
  if (medio === '') medio = null;

  const ts = new Date(t).toISOString();
  return {
    venta: {
      local_id, externo_id, ts,
      dia_com: diaComercial(ts), hora_local: horaLocal(ts),
      monto, items, medio,
    },
  };
}

// ---------------------------------------------------------------------------
// Registro de ventas — el único camino de entrada, lo use el webhook o el
// simulador. Así lo que se prueba con datos falsos es exactamente lo mismo que
// va a correr con el POS enchufado.
// ---------------------------------------------------------------------------
const insertarVenta = db.prepare(`
  INSERT OR IGNORE INTO ventas
    (local_id, externo_id, ts, dia_com, hora_local, monto, items, medio, origen)
  VALUES
    (@local_id, @externo_id, @ts, @dia_com, @hora_local, @monto, @items, @medio, @origen)`);

function registrarVentas(crudas, origen) {
  const nuevas = [];
  const rechazadas = [];
  let repetidas = 0;

  const tx = db.transaction(() => {
    for (const cruda of crudas) {
      const { venta, error } = validar(cruda);
      if (error) { rechazadas.push({ externo_id: cruda.externo_id ?? null, error }); continue; }
      const r = insertarVenta.run({ ...venta, origen });
      if (r.changes) nuevas.push(venta); else repetidas++;
    }
  });
  tx();

  /* La primera venta real apaga el simulador, acá y no en el próximo
     reinicio. Es el momento exacto en que los datos falsos pasan de ser una
     demo a ser un problema, y no depende de que alguien se acuerde.

     Las falsas quedan en la base —marcadas origen=simulador— porque borrar
     datos solo, sin que nadie lo pida, es peor. El tablero avisa que están y
     se borran con un botón. */
  if (origen === 'hook' && nuevas.length && SIM.on && motivoBloqueo()) {
    apagarSimulador();
    console.warn('  Entró la primera venta real: simulador apagado.');
  }

  // Por el stream sale sólo lo de hoy: un backfill de meses no tiene que
  // inundar a los tableros conectados ni hacerles festejar objetivos viejos.
  const hoy = hoyComercial();
  for (const v of nuevas) if (v.dia_com === hoy) emitir('venta', v);

  return { nuevas: nuevas.length, repetidas, rechazadas };
}

// ---------------------------------------------------------------------------
// Agregados
//
// Se calculan con SQL contra el índice en vez de llevarlos en memoria: así no
// hay forma de que queden viejos después de un backfill, de un borrado del
// simulador o del cambio de día.
// ---------------------------------------------------------------------------
const qDia = db.prepare(`
  SELECT local_id, SUM(monto) AS monto, COUNT(*) AS tickets
  FROM ventas WHERE dia_com = ? GROUP BY local_id`);

const qRango = db.prepare(`
  SELECT local_id, SUM(monto) AS monto, COUNT(*) AS tickets
  FROM ventas WHERE dia_com >= ? AND dia_com < ? GROUP BY local_id`);

const qPorDia = db.prepare(`
  SELECT dia_com, SUM(monto) AS monto
  FROM ventas WHERE dia_com >= ? AND dia_com < ? AND local_id = ? GROUP BY dia_com`);

const qHoras = db.prepare(`
  SELECT local_id, hora_local AS h, SUM(monto) AS monto
  FROM ventas WHERE dia_com = ? GROUP BY local_id, hora_local`);

const qDiasMes = db.prepare(`
  SELECT local_id, dia_com AS d, SUM(monto) AS monto
  FROM ventas WHERE dia_com >= ? AND dia_com < ? GROUP BY local_id, dia_com`);

const tot = fila => ({ monto: fila ? fila.monto : 0, tickets: fila ? fila.tickets : 0 });

function estado() {
  const dia = hoyComercial();
  const ayer = diaAnterior(dia);
  const { desde, hasta, periodo, anio, mes } = limitesMes(dia);
  const mesAnterior = limitesMes(diaAnterior(desde));
  const diasMes = new Date(anio, mes, 0).getDate();

  const hoy = new Map(qDia.all(dia).map(r => [r.local_id, r]));
  const deAyer = new Map(qDia.all(ayer).map(r => [r.local_id, r]));
  const delMes = new Map(qRango.all(desde, hasta).map(r => [r.local_id, r]));
  const delMesPasado = new Map(
    qRango.all(mesAnterior.desde, mesAnterior.hasta).map(r => [r.local_id, r])
  );
  const objManual = new Map(
    db.prepare('SELECT local_id, monto FROM objetivos WHERE periodo = ?').all(periodo)
      .map(r => [r.local_id, r.monto])
  );

  // Historia para los gráficos: por hora el día de hoy, por día el mes. Van en
  // el mismo payload para que el tablero arranque con una sola request.
  const horas = new Map();
  for (const r of qHoras.all(dia)) {
    if (!horas.has(r.local_id)) horas.set(r.local_id, new Array(24).fill(0));
    if (r.h >= 0 && r.h < 24) horas.get(r.local_id)[r.h] = r.monto;
  }
  const dias = new Map();
  for (const r of qDiasMes.all(desde, hasta)) {
    if (!dias.has(r.local_id)) dias.set(r.local_id, new Array(diasMes).fill(0));
    const i = Number(r.d.slice(8, 10)) - 1;
    if (i >= 0 && i < diasMes) dias.get(r.local_id)[i] = r.monto;
  }

  const nroDia = Number(dia.slice(8, 10));

  const locales = LOC.filter(L => L.activo).map(L => {
  // Manda el objetivo del mes: el del día sale de repartirlo según cuánto
  // pesa ese día de la semana. Sólo si el mes no está cargado se usa el
  // objetivo diario del local como respaldo.
  const cargado = objManual.get(L.id);
  const mensual = cargado ?? objetivoMensual(L.objetivo_diario, anio, mes);
  const diario = cargado != null
    ? Math.round(objetivoDelDia(cargado, anio, mes, nroDia))
    : L.objetivo_diario;
  return {
    id: L.id,
    nombre: L.nombre,
    dir: L.dir,
    barrio: L.barrio,
    lat: L.lat,
    lng: L.lng,
    en_mapa: !!L.en_mapa,
    tipo: L.tipo || 'bar',
    dir_a_confirmar: !!L.dir_a_confirmar,
    objetivo_diario: diario,
    objetivo_cargado: cargado != null,
    objetivo_mensual: mensual,
    // Forma de la demanda hora por hora. Hoy es un perfil cargado a mano; el
    // día que haya meses de historia, sale de la curva real del local.
    curva: PERFILES[L.perfil] || PERFILES.noche,
    hoy: tot(hoy.get(L.id)),
    ayer: tot(deAyer.get(L.id)),
    mes: tot(delMes.get(L.id)),
    mes_anterior: tot(delMesPasado.get(L.id)),
    horas: horas.get(L.id) || new Array(24).fill(0),
    dias: dias.get(L.id) || new Array(diasMes).fill(0),
  };
  });

  const sumar = (campo, clave) => locales.reduce((a, L) => a + L[campo][clave], 0);

  return {
    ahora: new Date().toISOString(),
    dia_comercial: dia,
    periodo,
    dias_mes: diasMes,
    inicio_dia: INICIO_DIA,
    zona: TZ,
    // Para que el tablero pueda calcular "lo esperado a esta altura" sin
    // duplicar las constantes del negocio: salen de acá.
    factores_dia: FACTOR_DIA,
    fsum_previos: sumaFactores(anio, mes, 1, Number(dia.slice(8, 10))),
    fsum_mes: sumaFactores(anio, mes, 1, diasMes + 1),
    locales,
    cadena: {
      hoy: { monto: sumar('hoy', 'monto'), tickets: sumar('hoy', 'tickets') },
      ayer: { monto: sumar('ayer', 'monto'), tickets: sumar('ayer', 'tickets') },
      mes: { monto: sumar('mes', 'monto'), tickets: sumar('mes', 'tickets') },
      mes_anterior: {
        monto: sumar('mes_anterior', 'monto'), tickets: sumar('mes_anterior', 'tickets'),
      },
      objetivo_diario: locales.reduce((a, L) => a + L.objetivo_diario, 0),
      objetivo_mensual: locales.reduce((a, L) => a + L.objetivo_mensual, 0),
    },
    /* Tres cosas distintas, y antes había una sola.

       `simulador` es si está corriendo. `simulado` es si hay plata inventada
       dentro de los números que se están mostrando — que es lo que de verdad
       hay que avisarle a quien mira, y seguía siendo cierto después de apagar
       el simulador: el cartel desaparecía y los números falsos quedaban.
       `simulador_disponible` es si se puede prender, para que el tablero
       muestre el botón sólo mientras sirva. */
    simulador: SIM.on,
    simulado: SIM.on || hayFalsasEnElMes(desde, hasta),
    simulador_disponible: motivoBloqueo() === null,
  };
}

// ¿Hay ventas del simulador adentro de lo que se está mostrando? El mes, que
// es el rango más largo que mira el tablero.
const qFalsas = db.prepare(
  "SELECT 1 FROM ventas WHERE origen = 'simulador' AND dia_com BETWEEN ? AND ? LIMIT 1");
const hayFalsasEnElMes = (desde, hasta) => !!qFalsas.get(desde, hasta);

// ---------------------------------------------------------------------------
// SSE
//
// Se eligió SSE y no WebSocket porque el flujo es en una sola dirección y el
// navegador reconecta solo cuando se corta, que en obra pasa seguido.
// ---------------------------------------------------------------------------
const clientes = new Set();

function emitir(evento, dato) {
  const linea = `event: ${evento}\ndata: ${JSON.stringify(dato)}\n\n`;
  for (const res of clientes) {
    try { res.write(linea); } catch (err) { clientes.delete(res); }
  }
}

setInterval(() => {
  for (const res of clientes) {
    try { res.write(': latido\n\n'); } catch (err) { clientes.delete(res); }
  }
}, 20000).unref();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const igual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function cookies(req) {
  const out = {};
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

// Las sesiones sin uso por 180 días se limpian al arrancar, igual que en
// Aperturas: la app se mira a diario y volver a loguearse seguido es fricción.
db.prepare("DELETE FROM sesiones WHERE ultimo_uso < datetime('now','-180 days')").run();

const buscarSesion = db.prepare('SELECT token FROM sesiones WHERE token = ?');
const tocarSesion = db.prepare("UPDATE sesiones SET ultimo_uso = datetime('now') WHERE token = ?");

function sesionValida(token) {
  if (!token) return false;
  if (!buscarSesion.get(token)) return false;
  tocarSesion.run(token);
  return true;
}

// Lecturas: header o cookie. La cookie hace falta porque EventSource no puede
// mandar headers, igual que <img src> en Aperturas.
function requiereLectura(req, res, next) {
  const token = req.get('x-token') || cookies(req).tm_sesion;
  if (!sesionValida(token)) return res.status(401).json({ error: 'NO_AUTORIZADO' });
  next();
}

// Escrituras: SÓLO header. Al ignorar la cookie, un POST cross-site no puede
// tocar nada: no hay superficie de CSRF.
function requiereEscritura(req, res, next) {
  if (!sesionValida(req.get('x-token'))) return res.status(401).json({ error: 'NO_AUTORIZADO' });
  next();
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Webhook ---------------------------------------------------------------
// Va ANTES de express.json() y con el cuerpo crudo: la firma HMAC se calcula
// sobre los bytes exactos que mandó el proveedor, no sobre un re-serializado.
app.post('/hook/ventas', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (HOOK_SECRET) {
    const firma = req.get('x-temple-firma') || '';
    const esperada = crypto.createHmac('sha256', HOOK_SECRET).update(crudo).digest('hex');
    if (!firma || !igual(firma, esperada)) {
      return res.status(401).json({ error: 'FIRMA_INVALIDA' });
    }
  } else if (HOOK_TOKEN) {
    if (!igual(req.get('x-temple-token') || '', HOOK_TOKEN)) {
      return res.status(401).json({ error: 'TOKEN_INVALIDO' });
    }
  } else {
    // Sin secreto configurado no se acepta nada. Falla cerrado a propósito:
    // un endpoint abierto acá significa que cualquiera inventa facturación.
    return res.status(503).json({ error: 'HOOK_SIN_CONFIGURAR' });
  }

  let cuerpo;
  try {
    cuerpo = JSON.parse(crudo.toString('utf8') || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'JSON_INVALIDO' });
  }

  let crudas;
  try {
    crudas = adaptar(POS_ADAPTADOR, cuerpo);
  } catch (err) {
    return res.status(500).json({ error: 'ADAPTADOR', detalle: err.message });
  }

  const r = registrarVentas(crudas, 'hook');

  // Con algo rechazado se devuelve 422 para que el proveedor reintente. El
  // reintento es gratis porque el alta es idempotente por (local, externo_id).
  const codigo = r.rechazadas.length ? 422 : 200;
  res.status(codigo).json({ recibidas: crudas.length, ...r });
});

app.use(express.json({ limit: '1mb' }));

// --- Sesión ----------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const pass = String(req.body && req.body.pass || '');
  if (!pass || !igual(pass, APP_PASSWORD)) {
    return res.status(401).json({ error: 'CLAVE_INCORRECTA' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token) VALUES (?)').run(token);
  const seguro = req.secure || req.get('x-forwarded-proto') === 'https';
  res.cookie('tm_sesion', token, {
    httpOnly: true, sameSite: 'lax', secure: seguro, maxAge: 365 * 24 * 3600 * 1000, path: '/',
  });
  res.json({ token });
});

app.post('/api/logout', requiereLectura, (req, res) => {
  const token = req.get('x-token') || cookies(req).tm_sesion;
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
  res.clearCookie('tm_sesion', { path: '/' });
  res.json({ ok: true });
});

// --- Lecturas --------------------------------------------------------------
app.get('/api/estado', requiereLectura, (req, res) => res.json(estado()));

app.get('/api/stream', requiereLectura, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',        // que ningún proxy lo bufferee
  });
  res.write('retry: 5000\n\n');
  res.write(`event: hola\ndata: ${JSON.stringify(estado())}\n\n`);
  clientes.add(res);
  req.on('close', () => clientes.delete(res));
});

app.get('/api/ventas', requiereLectura, (req, res) => {
  const desde = String(req.query.desde || hoyComercial());
  const hasta = String(req.query.hasta || '9999-12-31');
  const limite = Math.min(5000, Math.max(1, Number(req.query.limite) || 500));
  const local = resolverLocal(req.query.local);
  const filas = local
    ? db.prepare(`SELECT local_id, externo_id, ts, dia_com, monto, items, medio, origen
                  FROM ventas WHERE dia_com >= ? AND dia_com <= ? AND local_id = ?
                  ORDER BY ts DESC LIMIT ?`).all(desde, hasta, local, limite)
    : db.prepare(`SELECT local_id, externo_id, ts, dia_com, monto, items, medio, origen
                  FROM ventas WHERE dia_com >= ? AND dia_com <= ?
                  ORDER BY ts DESC LIMIT ?`).all(desde, hasta, limite);
  res.json({ ventas: filas });
});

app.get('/api/locales/:id/dias', requiereLectura, (req, res) => {
  const id = resolverLocal(req.params.id);
  if (!id) return res.status(404).json({ error: 'NO_EXISTE' });
  const { desde, hasta } = limitesMes(String(req.query.mes || hoyComercial()).slice(0, 7) + '-01');
  res.json({ local: id, dias: qPorDia.all(desde, hasta, id) });
});

// --- Configuración ---------------------------------------------------------
// Lo que se edita, no lo que se mide: /api/estado tiene los números del día y
// del mes, acá están los objetivos y la clave con la que el POS llama a cada
// local. Van separados porque se miran en momentos distintos.
app.get('/api/locales', requiereLectura, (req, res) => {
  const hoy = hoyComercial();
  const hoyNro = Number(hoy.slice(8, 10));
  const { periodo, anio, mes } = limitesMes(hoy);
  const manual = new Map(
    db.prepare('SELECT local_id, monto FROM objetivos WHERE periodo = ?').all(periodo)
      .map(r => [r.local_id, r.monto])
  );
  res.json({
    periodo,
    locales: LOC.map(L => ({
      id: L.id,
      nombre: L.nombre,
      dir: L.dir,
      barrio: L.barrio,
      en_mapa: !!L.en_mapa,
      activo: !!L.activo,
      pos_id: L.pos_id || '',
      // El del mes es el que manda. `objetivo_diario` es el respaldo que se
      // usa sólo en los meses sin cargar; `diario_hoy` es lo que de verdad
      // se está midiendo hoy, salga de donde salga.
      objetivo_mensual: manual.get(L.id) ?? objetivoMensual(L.objetivo_diario, anio, mes),
      mensual_manual: manual.has(L.id),
      objetivo_diario: L.objetivo_diario,
      diario_hoy: manual.has(L.id)
        ? Math.round(objetivoDelDia(manual.get(L.id), anio, mes, hoyNro))
        : L.objetivo_diario,
    })),
  });
});

// --- Objetivos -------------------------------------------------------------
app.put('/api/locales/:id/objetivo', requiereEscritura, (req, res) => {
  const id = resolverLocal(req.params.id);
  if (!id) return res.status(404).json({ error: 'NO_EXISTE' });
  const diario = Number(req.body && req.body.diario);
  if (!Number.isFinite(diario) || diario < 0 || diario > MAX_MONTO) {
    return res.status(400).json({ error: 'MONTO_INVALIDO' });
  }
  db.prepare('UPDATE locales SET objetivo_diario = ? WHERE id = ?').run(Math.round(diario), id);
  cargarLocales();
  res.json({ ok: true });
});

app.put('/api/locales/:id/objetivo-mensual', requiereEscritura, (req, res) => {
  const id = resolverLocal(req.params.id);
  if (!id) return res.status(404).json({ error: 'NO_EXISTE' });
  const periodo = String(req.body && req.body.periodo || '');
  if (!/^\d{4}-\d{2}$/.test(periodo)) return res.status(400).json({ error: 'PERIODO_INVALIDO' });

  // monto null borra el override y el mes vuelve a salir del objetivo diario.
  // Hace falta: si no, un número cargado por error queda fijo para siempre.
  if (req.body.monto === null) {
    db.prepare('DELETE FROM objetivos WHERE local_id = ? AND periodo = ?').run(id, periodo);
    return res.json({ ok: true, derivado: true });
  }

  const monto = Number(req.body.monto);
  if (!Number.isFinite(monto) || monto < 0 || monto > MAX_MONTO) {
    return res.status(400).json({ error: 'MONTO_INVALIDO' });
  }
  db.prepare(`INSERT INTO objetivos (local_id, periodo, monto) VALUES (?, ?, ?)
              ON CONFLICT(local_id, periodo) DO UPDATE SET monto = excluded.monto`)
    .run(id, periodo, Math.round(monto));
  res.json({ ok: true });
});

/* ── objetivos por planilla ────────────────────────────────────────────────
   Cargar un objetivo por local y por día serían 365 números por local y nadie
   los va a cargar. Administración piensa por mes, así que se baja una grilla
   de locales × meses, se llena en Excel y se vuelve a subir. Mismo ida y
   vuelta que el presupuesto en Aperturas, y por la misma razón.
   ────────────────────────────────────────────────────────────────────────── */

const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function parsearPeriodo(txt, anioDefecto) {
  const s = normalizar(txt).replace(/\s+/g, ' ');
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})$/))) {
    const mes = Number(m[2]);
    return mes >= 1 && mes <= 12 ? `${m[1]}-${String(mes).padStart(2, '0')}` : null;
  }
  if ((m = s.match(/^(\d{1,2})[-/](\d{4})$/))) {
    const mes = Number(m[1]);
    return mes >= 1 && mes <= 12 ? `${m[2]}-${String(mes).padStart(2, '0')}` : null;
  }
  // "noviembre", "nov", "noviembre 2026", "nov-26"
  const nombre = s.match(/^([a-z]+)\s*[-/ ]?\s*(\d{2,4})?$/);
  if (nombre) {
    const i = MESES_ES.findIndex(n => n.startsWith(nombre[1].slice(0, 3)) && nombre[1].length >= 3);
    if (i >= 0) {
      let a = nombre[2] ? Number(nombre[2]) : anioDefecto;
      if (a < 100) a += 2000;
      return `${a}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  return null;
}

// "1.850.000,50" y "12500.75" tienen que dar lo que corresponde. La coma es
// decimal, que es como se escribe acá; el punto es de miles sólo si separa
// grupos de tres.
function montoDeTexto(txt) {
  const s = String(txt).trim().replace(/[\s$]/g, '');
  if (!s || s === '-') return null;
  if (!/^-?[\d.,]+$/.test(s)) return NaN;
  const coma = s.includes(','), punto = s.includes('.');
  let limpio;
  if (coma && punto) {
    limpio = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma) limpio = s.replace(',', '.');
  else if (punto) limpio = /^-?\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s;
  else limpio = s;
  const v = Number(limpio);
  return Number.isFinite(v) ? v : NaN;
}

function partirCSV(texto) {
  const sinBom = texto.replace(/^﻿/, '');
  const primera = sinBom.split(/\r?\n/)[0] || '';
  const sep = (primera.split(';').length > primera.split(',').length) ? ';' : ',';
  const filas = [];
  for (const linea of sinBom.split(/\r?\n/)) {
    if (!linea.trim()) { filas.push([]); continue; }
    const campos = [];
    let act = '', comillas = false;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (comillas) {
        if (c === '"' && linea[i + 1] === '"') { act += '"'; i++; }
        else if (c === '"') comillas = false;
        else act += c;
      } else if (c === '"') comillas = true;
      else if (c === sep) { campos.push(act); act = ''; }
      else act += c;
    }
    campos.push(act);
    filas.push(campos.map(s => s.trim()));
  }
  return filas;
}

function leerTexto(buf) {
  // Excel en Windows guarda el CSV en ANSI: leerlo como UTF-8 convierte
  // "Gestión" en basura. Se prueba estricto y si falla se cae a 1252.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (err) {
    try { return new TextDecoder('windows-1252').decode(buf); }
    catch (err2) { return buf.toString('latin1'); }
  }
}

// Devuelve { filas:[{local_id, nombre, periodo, monto}], ignoradas:[...] }
function interpretarObjetivos(texto) {
  const grilla = partirCSV(texto);
  const cab = grilla.find(f => f.length > 1);
  if (!cab) return { error: 'La planilla está vacía.' };
  const desde = grilla.indexOf(cab) + 1;
  const anioHoy = Number(hoyComercial().slice(0, 4));

  const col = cab.map(c => normalizar(c));
  const iLocal = col.findIndex(c => ['local', 'nombre', 'id', 'sucursal'].includes(c));
  if (iLocal < 0) return { error: 'Falta una columna "Local" en la primera fila.' };
  const iPeriodo = col.findIndex(c => ['periodo', 'mes'].includes(c));
  const iMonto = col.findIndex(c => ['objetivo', 'monto', 'importe'].includes(c));

  // Formato largo (una fila por local y mes) o grilla (una columna por mes).
  const columnas = iPeriodo >= 0 && iMonto >= 0
    ? null
    : cab.map((c, i) => (i === iLocal ? null : parsearPeriodo(c, anioHoy)));
  if (columnas && !columnas.some(Boolean)) {
    return { error: 'Ninguna columna parece un mes. Usá 2026-11, 11/2026 o "Noviembre".' };
  }

  const filas = [], ignoradas = [];
  for (let n = desde; n < grilla.length; n++) {
    const f = grilla[n];
    if (!f.length || !f.some(c => c !== '')) continue;
    const nro = n + 1;                       // como lo cuenta Excel
    const local_id = resolverLocal(f[iLocal]);
    if (!local_id) {
      ignoradas.push({ fila: nro, motivo: `local desconocido: ${(f[iLocal] || '(vacío)').slice(0, 40)}` });
      continue;
    }
    const celdas = columnas
      ? columnas.map((p, i) => (p ? { periodo: p, txt: f[i] } : null)).filter(Boolean)
      : [{ periodo: parsearPeriodo(f[iPeriodo], anioHoy), txt: f[iMonto] }];

    for (const celda of celdas) {
      if (!celda.periodo) {
        ignoradas.push({ fila: nro, motivo: `mes ilegible: ${String(f[iPeriodo]).slice(0, 20)}` });
        continue;
      }
      const monto = montoDeTexto(celda.txt);
      if (monto === null) continue;          // celda vacía: no se toca nada
      if (Number.isNaN(monto) || monto < 0 || monto > MAX_MONTO) {
        ignoradas.push({ fila: nro, motivo: `importe inválido en ${celda.periodo}: ${String(celda.txt).slice(0, 20)}` });
        continue;
      }
      filas.push({ local_id, periodo: celda.periodo, monto: Math.round(monto) });
    }
  }
  return { filas, ignoradas };
}

app.get('/api/objetivos.csv', requiereLectura, (req, res) => {
  const anio = Number(req.query.anio) || Number(hoyComercial().slice(0, 4));
  const periodos = Array.from({ length: 12 }, (_, i) => `${anio}-${String(i + 1).padStart(2, '0')}`);
  const cargados = new Map();
  for (const r of db.prepare('SELECT local_id, periodo, monto FROM objetivos').all()) {
    cargados.set(r.local_id + '|' + r.periodo, r.monto);
  }
  const lineas = [['Local', ...periodos].join(';')];
  for (const L of LOC.filter(l => l.activo)) {
    lineas.push([L.nombre, ...periodos.map(p => cargados.get(L.id + '|' + p) ?? '')].join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="objetivos-${anio}.csv"`);
  res.send('﻿' + lineas.join('\r\n') + '\r\n');   // BOM: Excel y los acentos
});

app.post('/api/objetivos/import',
  express.raw({ type: '*/*', limit: '2mb' }),
  requiereEscritura,
  (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!buf.length) return res.status(400).json({ error: 'ARCHIVO_VACIO' });

    const r = interpretarObjetivos(leerTexto(buf));
    if (r.error) return res.status(400).json({ error: 'PLANILLA', detalle: r.error });

    const periodos = [...new Set(r.filas.map(f => f.periodo))].sort();
    const locales = new Set(r.filas.map(f => f.local_id));
    const resumen = {
      a_cargar: r.filas.length,
      locales: locales.size,
      periodos,
      ignoradas: r.ignoradas,
    };

    // Previsualización: se muestra exactamente lo que va a pasar antes de
    // tocar nada. Importar sólo agrega o pisa lo que viene; lo que no está
    // en la planilla queda como está.
    if (req.query.preview === '1') return res.json({ preview: true, ...resumen });

    const guardar = db.prepare(`INSERT INTO objetivos (local_id, periodo, monto)
      VALUES (?, ?, ?) ON CONFLICT(local_id, periodo) DO UPDATE SET monto = excluded.monto`);
    db.transaction(() => { for (const f of r.filas) guardar.run(f.local_id, f.periodo, f.monto); })();
    res.json({ preview: false, ...resumen });
  });

app.put('/api/locales/:id/pos-id', requiereEscritura, (req, res) => {
  const id = resolverLocal(req.params.id);
  if (!id) return res.status(404).json({ error: 'NO_EXISTE' });
  const pos = String(req.body && req.body.pos_id || '').slice(0, 80);
  db.prepare('UPDATE locales SET pos_id = ? WHERE id = ?').run(pos, id);
  cargarLocales();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Simulador
//
// Genera ventas con las mismas curvas horarias del mundo 3D y las mete por
// registrarVentas(), el mismo camino que el webhook. Eso es lo que lo hace
// útil: lo que se prueba hoy es exactamente el circuito que va a correr con el
// POS conectado, no una maqueta aparte.
// ---------------------------------------------------------------------------
const SIM = { on: false, velocidad: 1, timer: null, acc: new Map(), n: 0 };

function tickSimulador(segundos) {
  const ahora = new Date();
  const hora = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hourCycle: 'h23',
  }).format(ahora));
  const dow = new Date(hoyComercial() + 'T12:00:00').getDay();
  const horas = segundos * SIM.velocidad / 3600;
  const lote = [];

  for (const L of LOC) {
    if (!L.activo || !L.pico) continue;
    const curva = PERFILES[L.perfil] || PERFILES.noche;
    const tasa = L.pico * curva[hora % 24] * FACTOR_DIA[dow];
    if (tasa <= 0) continue;
    let acc = (SIM.acc.get(L.id) || 0) + tasa * horas;
    let n = 0;
    while (acc >= 1 && n < 20) {
      acc -= 0.6 + Math.random() * 0.8;
      const monto = Math.round(
        L.ticket_prom * (0.35 + Math.random() * 0.5 + Math.random() * 0.8) / 100
      ) * 100;
      lote.push({
        externo_id: `SIM-${Date.now().toString(36)}-${(SIM.n++).toString(36)}`,
        local: L.id,
        ts: new Date().toISOString(),
        monto,
        items: 1 + Math.floor(Math.random() * 7),
        medio: Math.random() < 0.6 ? 'tarjeta' : 'efectivo',
      });
      n++;
    }
    SIM.acc.set(L.id, Math.min(acc, 3));
  }

  if (lote.length) registrarVentas(lote, 'simulador');
}

/* ¿Entró alguna venta de verdad alguna vez?

   No se cachea a propósito. Es una consulta por índice sobre una columna con
   dos valores, y el día que entre el primer ticket real el simulador tiene que
   cerrarse en ese mismo momento, no en el próximo reinicio. */
const hayVentasReales = () =>
  !!db.prepare("SELECT 1 FROM ventas WHERE origen = 'hook' LIMIT 1").get();

/* Por qué no se puede prender, o null si se puede.

   Antes esto era una variable de entorno (`SIMULADOR_EN_PROD`) y en producción
   quedaba bloqueado siempre. Pero el tablero tiene que poder mostrarse andando
   **antes** de que el POS esté conectado: un tablero en cero no se puede
   enseñar ni probar.

   Así que el permiso ya no es una variable sino un hecho: mientras la base no
   tenga una sola venta real, el simulador está disponible; apenas entra la
   primera, se cierra solo y para siempre. Que es exactamente cuando empieza a
   ser peligroso. Nadie se tiene que acordar de apagarlo.

   `SIMULADOR_EN_PROD=1` sigue existiendo como anulación explícita, para probar
   el circuito contra una base que ya tiene ventas reales. */
function motivoBloqueo() {
  if (!EN_PROD || process.env.SIMULADOR_EN_PROD === '1') return null;
  if (hayVentasReales()) {
    return 'Ya entraron ventas reales. El simulador queda cerrado para que la '
      + 'facturación de verdad no se mezcle con la inventada.';
  }
  return null;
}

function prenderSimulador(velocidad) {
  const motivo = motivoBloqueo();
  if (motivo) throw new Error(motivo);
  SIM.velocidad = Math.min(500, Math.max(1, Number(velocidad) || 1));
  if (SIM.on) return;
  SIM.on = true;
  SIM.timer = setInterval(() => tickSimulador(1), 1000);
}

function apagarSimulador() {
  SIM.on = false;
  if (SIM.timer) clearInterval(SIM.timer);
  SIM.timer = null;
}

app.post('/api/simulador', requiereEscritura, (req, res) => {
  const quiere = !!(req.body && req.body.on);
  try {
    if (quiere) prenderSimulador(req.body.velocidad);
    else apagarSimulador();
  } catch (err) {
    return res.status(403).json({ error: 'BLOQUEADO', detalle: err.message });
  }
  res.json({ on: SIM.on, velocidad: SIM.velocidad, disponible: motivoBloqueo() === null });
});

app.delete('/api/simulador/datos', requiereEscritura, (req, res) => {
  const r = db.prepare("DELETE FROM ventas WHERE origen = 'simulador'").run();
  res.json({ borradas: r.changes });
});

// --- Clima -----------------------------------------------------------------
// Lo pide el servidor y no cada tablero: ver clima.js. El tablero lo consulta
// cada diez minutos y nunca lo necesita para dibujarse, así que un error acá
// no puede devolver otra cosa que un 200 con ok:false.
app.get('/api/clima', requiereLectura, async (req, res) => {
  try {
    res.json(await climaDe(LOC.filter(L => L.activo), TZ));
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err), locales: {} });
  }
});

// --- Salud y estáticos -----------------------------------------------------
app.get('/salud', (req, res) => {
  const fila = db.prepare('SELECT COUNT(*) AS n FROM ventas').get();
  res.json({
    ok: true,
    ventas: fila.n,
    clientes: clientes.size,
    simulador: SIM.on,
    simulador_disponible: motivoBloqueo() === null,
    ventas_reales: hayVentasReales(),
    adaptador: POS_ADAPTADOR,
    hook: HOOK_SECRET ? 'firma' : HOOK_TOKEN ? 'token' : 'sin configurar',
    clima: process.env.CLIMA_OFF === '1' ? 'apagado'
      : process.env.CLIMA_API_KEY ? 'open-meteo con clave' : 'open-meteo libre',
    dia_comercial: hoyComercial(),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Sin contraseña propia no se levanta. Un deploy al que se le olvidó la
// variable dejaría la facturación de la cadena en internet con la clave de
// ejemplo, y eso no se arregla con un aviso en los logs que nadie lee.
if (!APP_PASSWORD || APP_PASSWORD.length < 8) {
  console.error('\n  No arranco: falta APP_PASSWORD (mínimo 8 caracteres).');
  console.error('  Es la contraseña del tablero. En Railway va en las variables del servicio.\n');
  process.exit(1);
}
if (EN_SERVIDOR && !HOOK_SECRET && !HOOK_TOKEN) {
  console.warn('  OJO: el webhook está sin configurar y va a rechazar todo con 503.');
}

app.listen(PORT, () => {
  console.log(`Minimundo en :${PORT}`);
  console.log(`  base       ${DB_PATH}`);
  console.log(`  adaptador  ${POS_ADAPTADOR} (${Object.keys(ADAPTADORES).join(', ')})`);
  console.log(`  webhook    ${HOOK_SECRET ? 'firma HMAC' : HOOK_TOKEN ? 'token fijo' : 'SIN CONFIGURAR — rechaza todo'}`);
  if (process.env.SIMULADOR === '1') {
    try { prenderSimulador(process.env.SIMULADOR_VELOCIDAD); console.log('  simulador  prendido'); }
    catch (err) { console.log(`  simulador  ${err.message}`); }
  }
});
