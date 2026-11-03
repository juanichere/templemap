// ---------------------------------------------------------------------------
// Prueba el ida y vuelta de la planilla de objetivos contra un server corriendo.
//
//   BASE=http://127.0.0.1:3000 APP_PASSWORD=... node probar-objetivos.mjs
//
// Ojo: escribe objetivos de verdad en la base. Correrlo contra una de prueba.
// ---------------------------------------------------------------------------

const B = process.env.BASE || 'http://127.0.0.1:3000';
const PASS = process.env.APP_PASSWORD || 'temple123';
let ok = 0, mal = 0;
const m = (b, t, e) => { console.log(`${b ? ' ok ' : 'MAL '} ${t}${e ? '  → ' + e : ''}`); b ? ok++ : mal++; };

const { token } = await (await fetch(B + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pass: PASS }) })).json();
const H = { 'x-token': token };

// 1 · la plantilla
const bytes = new Uint8Array(await (await fetch(B + '/api/objetivos.csv?anio=2026', { headers: H })).arrayBuffer());
const csv = new TextDecoder('utf-8').decode(bytes);
const lineas = csv.replace(/^﻿/, '').trim().split('\r\n');
m(lineas[0].startsWith('Local;2026-01;'), 'la plantilla sale con los 12 meses', lineas[0].slice(0, 32));
const cuantos = (await (await fetch(B + '/api/estado', { headers: H })).json()).locales.length;
m(lineas.length === cuantos + 1, 'una fila por local',
  `${lineas.length - 1} filas para ${cuantos} locales`);
m(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'lleva BOM para que Excel respete los acentos');

// 2 · una planilla llena a mano, con las mañas del equipo
const subir = async (texto, preview) => {
  const r = await fetch(B + '/api/objetivos/import' + (preview ? '?preview=1' : ''), {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/octet-stream' },
    body: new TextEncoder().encode(texto) });
  return { status: r.status, j: await r.json() };
};

const planilla = [
  'Local;2026-11;Diciembre;2027-01',
  'Puerto Madero;300.000.000;320.000.000;280000000',
  'Soho;250.000.000;;260.000.000',          // celda vacía: no toca nada
  'Caminito;180000000,50;190.000.000;',
  'Local Que No Existe;100;100;100',
  'Monroe;ochenta;90.000.000;',
].join('\r\n');

let r = await subir(planilla, true);
m(r.status === 200 && r.j.preview === true, 'la previsualización no escribe nada');
m(r.j.a_cargar === 8, 'cuenta sólo las celdas con número (3+2+2+0+1)', `${r.j.a_cargar}`);
m(r.j.locales === 4, 'cuatro locales reconocidos', `${r.j.locales}`);
m(JSON.stringify(r.j.periodos) === '["2026-11","2026-12","2027-01"]',
  'entiende 2026-11, "Diciembre" y 2027-01', r.j.periodos.join(' '));
m(r.j.ignoradas.length === 2, 'reporta las dos filas con problema',
  r.j.ignoradas.map(x => `f${x.fila}: ${x.motivo}`).join(' | '));

// Barrio Chino no está en la planilla: sirve para ver que lo que no viene
// cargado se queda como está, corra este test una vez o diez.
const antes = await (await fetch(B + '/api/estado', { headers: H })).json();
const chinoAntes = antes.locales.find(L => L.id === 'chino').objetivo_cargado;

// 3 · aplicar
r = await subir(planilla, false);
m(r.status === 200 && r.j.preview === false, 'la importación corre');

// 4 · el objetivo del día sale de repartir el mes
const e = await (await fetch(B + '/api/estado', { headers: H })).json();
const pm = e.locales.find(L => L.id === 'madero');
m(pm.objetivo_cargado === true, 'Puerto Madero quedó con objetivo cargado');
m(pm.objetivo_mensual === 300000000, 'el mes es el que se cargó', String(pm.objetivo_mensual));

// noviembre 2026 arranca domingo: 4 semanas + domingo y lunes
const F = [.80, .55, .62, .72, .88, 1.25, 1.35];
let suma = 0;
for (let d = 1; d <= 30; d++) suma += F[new Date(2026, 10, d).getDay()];
const esperado = Math.round(300000000 * F[new Date(2026, 10, Number(e.dia_comercial.slice(8))).getDay()] / suma);
m(pm.objetivo_diario === esperado, 'el día sale del mes según el peso de ese día',
  `${pm.objetivo_diario} vs ${esperado} (suma de factores ${suma.toFixed(2)})`);

const soho = e.locales.find(L => L.id === 'soho');
m(soho.objetivo_mensual === 250000000, 'Soho también', String(soho.objetivo_mensual));
const chino = e.locales.find(L => L.id === 'chino');
m(chino.objetivo_cargado === chinoAntes, 'el que no está en la planilla queda como estaba');

// 5 · reimportar no duplica ni rompe
r = await subir(planilla, false);
const e2 = await (await fetch(B + '/api/estado', { headers: H })).json();
m(e2.locales.find(L => L.id === 'madero').objetivo_mensual === 300000000,
  'reimportar la misma planilla deja todo igual');

// 6 · la plantilla ahora vuelve con lo cargado
const csv2 = await (await fetch(B + '/api/objetivos.csv?anio=2026', { headers: H })).text();
m(csv2.includes('300000000'), 'la plantilla baja con los valores ya cargados');

console.log(`\n${ok} bien, ${mal} mal`);
process.exit(mal ? 1 : 0);
