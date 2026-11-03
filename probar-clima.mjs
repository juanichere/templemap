// ---------------------------------------------------------------------------
// Prueba el sol y el clima.
//
//   BASE=http://127.0.0.1:3000 APP_PASSWORD=... node probar-clima.mjs
//
// El sol se prueba contra valores conocidos: el amanecer de Buenos Aires en el
// solsticio de invierno es un hecho verificable, y si el cálculo se desvía un
// minuto se nota acá y no en pantalla seis meses después. El clima se prueba
// contra el servidor: que pida sesión, que traiga un dato por local y que no
// salga a buscarlo de nuevo en cada request.
// ---------------------------------------------------------------------------

import { posicionSolar, horasSolares, luzDeAltitud, hhmm } from './public/sol.mjs';
import clima from './clima.js';

const B = process.env.BASE || 'http://127.0.0.1:3000';
const PASS = process.env.APP_PASSWORD || 'temple123';
let ok = 0, mal = 0;
const m = (b, t, e) => { console.log(`${b ? ' ok ' : 'MAL '} ${t}${e ? '  → ' + e : ''}`); b ? ok++ : mal++; };

const Z = 'America/Argentina/Buenos_Aires';
const CABA = [-34.6037, -58.3816];

// ── 1 · el sol ─────────────────────────────────────────────────────────────
// Tolerancia de dos minutos: las efemérides publicadas redondean y la fórmula
// es la de bajo orden. Más de eso ya es un error de cuenta.
const cerca = (h, txt) => {
  if (h == null) return false;
  const [hh, mm] = txt.split(':').map(Number);
  return Math.abs(h * 60 - (hh * 60 + mm)) <= 2;
};

for (const [fecha, sale, pone, nombre] of [
  ['2026-06-21', '08:00', '17:51', 'solsticio de invierno'],
  ['2026-12-21', '05:37', '20:06', 'solsticio de verano'],
]) {
  const s = horasSolares(new Date(fecha + 'T15:00:00Z'), CABA[0], CABA[1], Z);
  m(cerca(s.amanecer, sale) && cerca(s.atardecer, pone),
    `Buenos Aires, ${nombre}`, `sale ${hhmm(s.amanecer)} y se pone ${hhmm(s.atardecer)}`);
}

// Para el equinoccio se prueba la propiedad y no la hora: el día dura doce
// horas y pico en cualquier latitud —el "y pico" son la refracción y el
// diámetro del sol, que lo hacen salir antes y ponerse después—. Un horario
// escrito a mano acá sería un número sacado del mismo modelo que se prueba.
for (const [lat, lng, donde] of [
  [CABA[0], CABA[1], 'Buenos Aires'], [-51.62, -69.22, 'Río Gallegos'], [-24.79, -65.41, 'Salta'],
]) {
  const s = horasSolares(new Date('2026-03-20T15:00:00Z'), lat, lng, Z);
  const dur = s.atardecer - s.amanecer;
  m(Math.abs(dur - 12.12) < 0.08, `el equinoccio dura doce horas en ${donde}`,
    `${hhmm(dur)} (sale ${hhmm(s.amanecer)}, se pone ${hhmm(s.atardecer)})`);
}

// La altura máxima del sol al mediodía es 90 − |latitud − declinación|, y en
// los solsticios la declinación es ±23.44. Es aritmética, tiene que dar.
{
  const inv = horasSolares(new Date('2026-06-21T15:00:00Z'), CABA[0], CABA[1], Z);
  const ver = horasSolares(new Date('2026-12-21T15:00:00Z'), CABA[0], CABA[1], Z);
  m(Math.abs(inv.alturaMaxima - 31.96) < 0.2 && Math.abs(ver.alturaMaxima - 78.84) < 0.2,
    'la altura del sol al mediodía',
    `${inv.alturaMaxima.toFixed(1)}° en invierno y ${ver.alturaMaxima.toFixed(1)}° en verano`);
}

// Río Gallegos está a −51.6: el día de invierno tiene que ser mucho más corto
// que el de Buenos Aires. Es justo el caso que el modelo viejo, con su ventana
// fija de horas, no podía representar.
{
  const g = horasSolares(new Date('2026-06-21T15:00:00Z'), -51.62, -69.22, Z);
  const b = horasSolares(new Date('2026-06-21T15:00:00Z'), CABA[0], CABA[1], Z);
  const dur = s => s.atardecer - s.amanecer;
  m(dur(g) < dur(b) - 1.5, 'el día de invierno es más corto en el sur',
    `${dur(g).toFixed(1)} h en Río Gallegos contra ${dur(b).toFixed(1)} h en Buenos Aires`);
}

// En el hemisferio sur el sol del mediodía está al norte: azimut cerca de 0.
{
  const s = horasSolares(new Date('2026-06-21T15:00:00Z'), CABA[0], CABA[1], Z);
  const t0 = new Date('2026-06-21T00:00:00-03:00').getTime() + s.mediodia * 3600000;
  const p = posicionSolar(new Date(t0), CABA[0], CABA[1]);
  m(Math.abs(p.azimut * 180 / Math.PI) < 2, 'al mediodía el sol está al norte',
    `azimut ${(p.azimut * 180 / Math.PI).toFixed(1)}°`);
}

// El sol sale por el este y se pone por el oeste, siempre.
{
  const s = horasSolares(new Date('2026-11-02T15:00:00Z'), CABA[0], CABA[1], Z);
  const en = h => posicionSolar(
    new Date(new Date('2026-11-02T00:00:00-03:00').getTime() + h * 3600000), CABA[0], CABA[1]);
  const a = en(s.amanecer + 0.1).azimut * 180 / Math.PI;
  const p = en(s.atardecer - 0.1).azimut * 180 / Math.PI;
  m(a > 60 && a < 120 && p < -60 && p > -120, 'sale por el este y se pone por el oeste',
    `${a.toFixed(0)}° al amanecer, ${p.toFixed(0)}° al atardecer`);
}

// La luz: cero de noche cerrada, máxima con el sol alto, y sin saltos.
{
  const g = x => luzDeAltitud(x * Math.PI / 180);
  m(g(-20) === 0 && g(-13) === 0, 'de noche cerrada no hay luz');
  m(g(-3) > 0 && g(-3) < g(0) && g(0) < g(20) && g(20) < g(70),
    'la luz crece con la altura del sol', `−3°=${g(-3).toFixed(2)} 0°=${g(0).toFixed(2)} 70°=${g(70).toFixed(2)}`);
  m(g(0) > 0.05, 'en el horizonte todavía hay crepúsculo', g(0).toFixed(2));
}

// ── 2 · la tabla de códigos WMO ────────────────────────────────────────────
m(clima.leerCodigo(0).tipo === 'despejado' && clima.leerCodigo(95).tipo === 'tormenta'
  && clima.leerCodigo(75).tipo === 'nieve' && clima.leerCodigo(45).tipo === 'niebla'
  && clima.leerCodigo(65).tipo === 'lluvia', 'los códigos WMO se traducen');
m(clima.leerCodigo(65).fuerza > clima.leerCodigo(61).fuerza,
  'la lluvia fuerte pesa más que la leve');
m(clima.leerCodigo(999).tipo === 'despejado',
  'un código desconocido no rompe nada', clima.leerCodigo(999).texto);

// ── 3 · el endpoint ────────────────────────────────────────────────────────
m((await fetch(B + '/api/clima')).status === 401, 'el clima pide sesión');

const { token } = await (await fetch(B + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pass: PASS }),
})).json();
const H = { 'x-token': token };

const t0 = Date.now();
const c1 = await (await fetch(B + '/api/clima', { headers: H })).json();
const demora = Date.now() - t0;

if (!c1.ok) {
  // Sin internet el módulo tiene que decirlo, no tirar el tablero abajo.
  m(c1.error != null && typeof c1.locales === 'object',
    'sin clima contesta igual, con el motivo', c1.error);
} else {
  const estado = await (await fetch(B + '/api/estado', { headers: H })).json();
  const ids = estado.locales.map(l => l.id);
  m(ids.every(id => c1.locales[id]), 'todos los locales tienen clima',
    `${Object.keys(c1.locales).length} de ${ids.length}`);

  const d = c1.locales[ids[0]];
  m(typeof d.temp === 'number' && typeof d.nubes === 'number'
    && typeof d.texto === 'string' && typeof d.tipo === 'string'
    && typeof d.fuerza === 'number' && typeof d.de_dia === 'boolean',
    'el dato viene con la forma que espera el mundo', JSON.stringify(d));

  // Los nueve locales de CABA caen en la misma celda del modelo: tienen que
  // traer el mismo número, que es la prueba de que se agruparon y no se
  // pidieron por separado.
  const caba = estado.locales.filter(l => l.en_mapa).map(l => c1.locales[l.id].temp);
  m(new Set(caba).size === 1, 'los locales de CABA comparten un solo pedido',
    `${caba.length} locales, ${new Set(caba).size} temperatura(s)`);

  const c2 = await (await fetch(B + '/api/clima', { headers: H })).json();
  m(c2.actualizado === c1.actualizado, 'la segunda consulta sale del caché',
    `${c1.actualizado} las dos veces`);
  console.log(`      (el primer pedido tardó ${demora} ms; el segundo, nada)`);
}

console.log(`\n${ok} bien, ${mal} mal`);
process.exit(mal ? 1 : 0);
