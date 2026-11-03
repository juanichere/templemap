'use strict';

/* ───────────────────────────────────────────────────────────────────────────
   El clima de cada local.

   Lo único de todo el proyecto que no se puede calcular ni medir acá adentro:
   hay que preguntárselo a alguien. Se pide del lado del servidor y no del
   navegador por tres razones: un tablero en modo TV abierto todo el día haría
   cientos de pedidos a un tercero, la respuesta se comparte entre todos los
   tableros conectados, y la clave (cuando haya) no viaja al cliente.

   Si falla, se devuelve lo último que funcionó marcado como viejo. Un dato de
   quince minutos atrás sirve; un hueco en la pantalla, no. Y si nunca
   funcionó, el mundo se dibuja despejado: el clima es un adorno, no una
   dependencia.
   ─────────────────────────────────────────────────────────────────────────── */

const CADUCA = 10 * 60 * 1000;          // la API actualiza cada 15 min
const REINTENTO = 60 * 1000;            // si falló, no martillar
const ESPERA = 8000;

const APAGADO = process.env.CLIMA_OFF === '1';
const API_KEY = process.env.CLIMA_API_KEY || '';

// Con clave hay que ir al host de clientes; sin clave, al público. Open-Meteo
// da la API libre para uso no comercial: si esto pasa a ser una herramienta de
// la empresa, corresponde la licencia paga, y es sólo setear CLIMA_API_KEY.
const HOST = API_KEY ? 'https://customer-api.open-meteo.com' : 'https://api.open-meteo.com';

const CAMPOS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
  'is_day', 'weather_code', 'cloud_cover', 'precipitation', 'wind_speed_10m',
].join(',');

/* ── códigos WMO ─────────────────────────────────────────────────────────── */

// `tipo` es lo que lee el mundo 3D para decidir qué dibujar; `fuerza` es
// cuánto. El texto es lo que lee una persona.
const CODIGOS = {
  0:  ['Despejado',               'despejado', 0],
  1:  ['Mayormente despejado',    'despejado', 0],
  2:  ['Parcialmente nublado',    'nubes',     0],
  3:  ['Nublado',                 'nubes',     0],
  45: ['Niebla',                  'niebla',    0.6],
  48: ['Niebla con escarcha',     'niebla',    0.9],
  51: ['Llovizna leve',           'llovizna',  0.25],
  53: ['Llovizna',                'llovizna',  0.4],
  55: ['Llovizna intensa',        'llovizna',  0.55],
  56: ['Llovizna helada',         'llovizna',  0.4],
  57: ['Llovizna helada intensa', 'llovizna',  0.55],
  61: ['Lluvia leve',             'lluvia',    0.4],
  63: ['Lluvia',                  'lluvia',    0.65],
  65: ['Lluvia fuerte',           'lluvia',    1],
  66: ['Lluvia helada',           'lluvia',    0.5],
  67: ['Lluvia helada fuerte',    'lluvia',    0.9],
  71: ['Nevada leve',             'nieve',     0.35],
  73: ['Nevada',                  'nieve',     0.6],
  75: ['Nevada fuerte',           'nieve',     1],
  77: ['Cellisca',                'nieve',     0.4],
  80: ['Chaparrones',             'lluvia',    0.5],
  81: ['Chaparrones fuertes',     'lluvia',    0.8],
  82: ['Chaparrones violentos',   'lluvia',    1],
  85: ['Chaparrones de nieve',    'nieve',     0.5],
  86: ['Nevada intensa',          'nieve',     1],
  95: ['Tormenta',                'tormenta',  0.8],
  96: ['Tormenta con granizo',    'tormenta',  1],
  99: ['Tormenta con granizo',    'tormenta',  1],
};

function leerCodigo(codigo) {
  const c = CODIGOS[codigo];
  if (c) return { texto: c[0], tipo: c[1], fuerza: c[2] };
  // La tabla WMO está completa, pero un código nuevo no tiene que romper nada.
  return { texto: 'Sin dato', tipo: 'despejado', fuerza: 0 };
}

/* ── agrupar los locales ─────────────────────────────────────────────────── */

/* Los nueve locales de CABA están dentro de diez kilómetros: pedir nueve
   puntos devolvería nueve veces el mismo número de la misma celda del modelo.
   Se agrupan redondeando a 0.1° (~11 km), que es la resolución con la que el
   clima es un hecho de la ciudad y no de la esquina. Diecisiete locales
   quedan en nueve pedidos, y van todos en una sola request. */
const clave = (lat, lng) => `${lat.toFixed(1)},${lng.toFixed(1)}`;

function agrupar(locales) {
  const puntos = new Map();
  for (const L of locales) {
    if (typeof L.lat !== 'number' || typeof L.lng !== 'number') continue;
    const k = clave(L.lat, L.lng);
    if (!puntos.has(k)) puntos.set(k, { lat: L.lat, lng: L.lng, ids: [] });
    puntos.get(k).ids.push(L.id);
  }
  return [...puntos.values()];
}

/* ── el pedido ───────────────────────────────────────────────────────────── */

async function pedir(puntos, zona) {
  const q = new URLSearchParams({
    latitude: puntos.map(p => p.lat.toFixed(4)).join(','),
    longitude: puntos.map(p => p.lng.toFixed(4)).join(','),
    current: CAMPOS,
    timezone: zona,
    forecast_days: '1',
  });
  if (API_KEY) q.set('apikey', API_KEY);

  const corte = AbortSignal.timeout(ESPERA);
  const r = await fetch(`${HOST}/v1/forecast?${q}`, { signal: corte });
  if (!r.ok) throw new Error(`la API del clima respondió ${r.status}`);

  const cuerpo = await r.json();
  // Con un solo punto devuelve un objeto; con varios, un array.
  const lista = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
  if (lista.length !== puntos.length) {
    throw new Error(`pedí ${puntos.length} puntos y volvieron ${lista.length}`);
  }

  const porLocal = {};
  lista.forEach((d, i) => {
    const c = d && d.current;
    if (!c) return;
    const dato = {
      temp: redondear(c.temperature_2m, 1),
      aparente: redondear(c.apparent_temperature, 1),
      humedad: redondear(c.relative_humidity_2m, 0),
      nubes: redondear(c.cloud_cover, 0),
      precip: redondear(c.precipitation, 1),
      viento: redondear(c.wind_speed_10m, 0),
      codigo: c.weather_code,
      de_dia: c.is_day === 1,
      ...leerCodigo(c.weather_code),
    };
    for (const id of puntos[i].ids) porLocal[id] = dato;
  });
  return porLocal;
}

const redondear = (v, d) => (typeof v === 'number' && Number.isFinite(v)
  ? Math.round(v * 10 ** d) / 10 ** d : null);

/* ── caché ───────────────────────────────────────────────────────────────── */

let cache = { t: 0, locales: null, error: null, intento: 0 };
let enVuelo = null;

async function refrescar(locales, zona) {
  const puntos = agrupar(locales);
  if (!puntos.length) return;
  try {
    cache = { t: Date.now(), locales: await pedir(puntos, zona), error: null, intento: Date.now() };
  } catch (err) {
    // Se guarda el error pero NO se borra lo último bueno.
    cache = { ...cache, error: String(err.message || err), intento: Date.now() };
  }
}

/* Devuelve el clima de todos los locales, del caché si está fresco.

   Los pedidos simultáneos comparten el mismo vuelo: un tablero que se abre
   mientras otro está esperando la respuesta no dispara un segundo pedido. */
async function climaDe(locales, zona) {
  if (APAGADO) return { ok: false, apagado: true, locales: {} };

  const viejo = Date.now() - cache.t > CADUCA;
  const puedeReintentar = Date.now() - cache.intento > REINTENTO;

  if ((viejo && puedeReintentar) || !cache.locales) {
    if (!enVuelo) enVuelo = refrescar(locales, zona).finally(() => { enVuelo = null; });
    // Con algo en el caché se contesta ya y se refresca por detrás: el
    // tablero no tiene que esperar ocho segundos a un tercero.
    if (cache.locales) { /* al fondo */ } else await enVuelo;
  }

  return {
    ok: !!cache.locales,
    actualizado: cache.t ? new Date(cache.t).toISOString() : null,
    vencido: !!cache.locales && Date.now() - cache.t > CADUCA * 3,
    error: cache.locales ? null : cache.error,
    aviso: cache.locales && cache.error ? cache.error : null,
    fuente: 'open-meteo',
    locales: cache.locales || {},
  };
}

module.exports = { climaDe, leerCodigo, CODIGOS, APAGADO };
