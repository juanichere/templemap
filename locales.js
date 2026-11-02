'use strict';

// ---------------------------------------------------------------------------
// Los locales de TEMPLE.
//
// Las direcciones salen del sitio oficial y las coordenadas de geocodificar
// esas direcciones contra OpenStreetMap. `pos_id` es la clave con la que el
// sistema de ventas identifica a cada local: queda vacía hasta que tengamos el
// webhook, y es lo único que hay que completar para enchufarlo.
// ---------------------------------------------------------------------------

// ⚠️ `pico`, `ticket` y los objetivos que salen de ellos son valores de
// arranque inventados para que el tablero tenga contra qué medir desde el
// primer día. NO son facturación real de TEMPLE. Se reemplazan desde
// Ajustes (/monitor.html) con los números de administración.

// Peso de la demanda hora por hora, 0..23. Un bar factura de noche.
const PERFILES = {
  noche:       [.55,.35,.15,.05,0,0,0,0,0,0,0,.10,.35,.45,.30,.20,.25,.45,.70,.95,1,1,.90,.75],
  turistico:   [0,0,0,0,0,0,0,0,0,.10,.30,.60,.95,1,.90,.70,.50,.35,.25,.15,.10,.05,0,0],
  barrio:      [.20,.10,.03,0,0,0,0,0,0,0,0,.15,.50,.60,.40,.25,.30,.45,.60,.85,.95,.90,.70,.40],
  afterOffice: [.70,.60,.35,.12,.02,0,0,0,0,0,0,.05,.25,.30,.25,.20,.30,.60,.90,1,.95,.90,.85,.80],
};

// Cuánto factura cada día de la semana contra un día promedio. Domingo → sábado.
const FACTOR_DIA = [.80, .55, .62, .72, .88, 1.25, 1.35];

// El día comercial de un bar cierra a las 6 de la mañana, no a medianoche: una
// venta de las 3 AM del sábado pertenece al viernes.
const INICIO_DIA = 6;

const BASE = [
  // --- Ciudad de Buenos Aires (van en el mapa 3D) --------------------------
  { id: 'madero',    nombre: 'Puerto Madero',       dir: 'Juana Manuela Gorriti 867',  barrio: 'Puerto Madero',
    lat: -34.614545, lng: -58.365323, pico: 46, ticket: 31000, perfil: 'noche',       en_mapa: 1 },
  { id: 'soho',      nombre: 'Soho',                dir: 'Costa Rica 4699',            barrio: 'Palermo Soho',
    lat: -34.588097, lng: -58.426976, pico: 42, ticket: 29000, perfil: 'noche',       en_mapa: 1 },
  { id: 'hollywood', nombre: 'Hollywood',           dir: 'Honduras 5602',              barrio: 'Palermo Hollywood',
    lat: -34.584100, lng: -58.436469, pico: 40, ticket: 30000, perfil: 'noche',       en_mapa: 1 },
  { id: 'recoleta',  nombre: 'Recoleta',            dir: 'Vicente López 2102',         barrio: 'Recoleta',
    lat: -34.588608, lng: -58.394353, pico: 34, ticket: 30000, perfil: 'noche',       en_mapa: 1 },
  { id: 'caminito',  nombre: 'Caminito',            dir: 'Magallanes 855',             barrio: 'La Boca',
    lat: -34.639659, lng: -58.362612, pico: 30, ticket: 22000, perfil: 'turistico',   en_mapa: 1 },
  { id: 'club',      nombre: 'Club Temple',         dir: 'Av. Corrientes 1660, local 8', barrio: 'San Nicolás',
    lat: -34.604388, lng: -58.392163, pico: 30, ticket: 26000, perfil: 'afterOffice', en_mapa: 1 },
  { id: 'monroe',    nombre: 'Monroe',              dir: 'Av. Monroe 1845',            barrio: 'Belgrano',
    lat: -34.555369, lng: -58.454787, pico: 28, ticket: 25000, perfil: 'barrio',      en_mapa: 1 },
  { id: 'casa',      nombre: 'Casa Temple',         dir: 'Costa Rica 4677',            barrio: 'Palermo Soho',
    lat: -34.588123, lng: -58.426796, pico: 26, ticket: 34000, perfil: 'noche',       en_mapa: 1 },
  { id: 'chino',     nombre: 'Barrio Chino',        dir: 'Echeverría 1664',            barrio: 'Belgrano',
    lat: -34.558753, lng: -58.448631, pico: 24, ticket: 24000, perfil: 'barrio',      en_mapa: 1 },

  // --- Resto del país (no van en el mapa de CABA, sí en el del país) -------
  { id: 'maschwitz', nombre: 'Maschwitz',           dir: 'Mendoza 1731, Ing. Maschwitz', barrio: 'Buenos Aires',
    lat: -34.382541, lng: -58.748123, pico: 26, ticket: 26000, perfil: 'noche',     en_mapa: 0 },
  { id: 'cordoba',   nombre: 'Córdoba',             dir: 'Belgrano 838',               barrio: 'Córdoba',
    lat: -31.424642, lng: -64.192441, pico: 30, ticket: 25000, perfil: 'noche',     en_mapa: 0 },
  { id: 'rosario',   nombre: 'Rosario',             dir: 'Alvear 122',                 barrio: 'Santa Fe',
    lat: -32.935585, lng: -60.652872, pico: 28, ticket: 25000, perfil: 'noche',     en_mapa: 0 },
  { id: 'bariloche', nombre: 'Bariloche',           dir: 'Carlos Bustos',              barrio: 'Río Negro',
    lat: -41.148777, lng: -71.438464, pico: 24, ticket: 28000, perfil: 'turistico', en_mapa: 0 },
  { id: 'salta',     nombre: 'Salta',               dir: 'Av. Belgrano 213',           barrio: 'Salta',
    lat: -24.787172, lng: -65.405602, pico: 22, ticket: 23000, perfil: 'noche',     en_mapa: 0 },
  { id: 'santiago',  nombre: 'Santiago del Estero', dir: 'Av. Roca Sur 861',           barrio: 'Santiago del Estero',
    lat: -27.787173, lng: -64.25441, pico: 18, ticket: 22000, perfil: 'barrio',    en_mapa: 0 },
  { id: 'comodoro',  nombre: 'Comodoro Rivadavia',  dir: 'Rawson 666',                 barrio: 'Chubut',
    lat: -45.864584, lng: -67.483971, pico: 18, ticket: 24000, perfil: 'barrio',    en_mapa: 0 },
  { id: 'gallegos',  nombre: 'Río Gallegos',        dir: '9 de Julio 102',             barrio: 'Santa Cruz',
    lat: -51.61854, lng: -69.218361, pico: 15, ticket: 23000, perfil: 'barrio',    en_mapa: 0 },
];

// El objetivo diario sale de la curva del local: horas-pico equivalentes por
// tickets por ticket promedio, contra un día promedio (de ahí el 0.9). Es un
// valor de arranque razonable y se edita en la base cuando administración
// ponga los suyos; nada más lo recalcula.
const LOCALES = BASE.map(L => {
  const suma = PERFILES[L.perfil].reduce((a, b) => a + b, 0);
  return {
    ...L,
    pos_id: '',                       // ← completar cuando llegue el webhook
    objetivo_diario: Math.round(suma * L.pico * L.ticket * 0.9 / 1000) * 1000,
    activo: 1,
  };
});

// Cuánto "pesa" un tramo del mes, sumando el factor de cada día. El rango es
// [desde, hasta) en días del mes.
function sumaFactores(anio, mes /* 1..12 */, desde, hasta) {
  let s = 0;
  for (let d = desde; d < hasta; d++) s += FACTOR_DIA[new Date(anio, mes - 1, d).getDay()];
  return s;
}

// Igual que el diario, el objetivo del mes NO es el diario por 30: depende de
// cuántos viernes y sábados caen, que facturan más del doble que un lunes.
// Esto se usa sólo como respaldo, para los meses sin objetivo cargado.
function objetivoMensual(objetivoDiario, anio, mes /* 1..12 */) {
  const dias = new Date(anio, mes, 0).getDate();
  return Math.round(objetivoDiario * sumaFactores(anio, mes, 1, dias + 1) / 0.9);
}

// El camino que importa: administración fija el objetivo del MES y el de cada
// día sale de repartirlo según cuánto pesa ese día de la semana. Pedir un
// objetivo por día sería pedir 365 números por local y nadie los va a cargar.
function objetivoDelDia(objetivoMes, anio, mes /* 1..12 */, dia) {
  const dias = new Date(anio, mes, 0).getDate();
  const total = sumaFactores(anio, mes, 1, dias + 1);
  if (!total) return 0;
  return objetivoMes * FACTOR_DIA[new Date(anio, mes - 1, dia).getDay()] / total;
}

module.exports = {
  LOCALES, PERFILES, FACTOR_DIA, INICIO_DIA,
  sumaFactores, objetivoMensual, objetivoDelDia,
};
