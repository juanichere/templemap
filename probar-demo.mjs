// ---------------------------------------------------------------------------
// Prueba el ciclo de vida del simulador en producción.
//
//   node probar-demo.mjs
//
// Levanta su propio server con NODE_ENV=production y una base descartable,
// porque es justo el modo que las otras pruebas no ejercitan: en desarrollo el
// simulador siempre se puede prender y acá la gracia es que se cierre solo.
//
// Lo que se verifica es la promesa entera: se puede prender mientras la base
// no tenga una venta real, se apaga en el momento exacto en que entra la
// primera, no se puede volver a prender, y borrar lo inventado no toca lo real.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

let ok = 0, mal = 0;
const m = (b, t, e) => { console.log(`${b ? ' ok ' : 'MAL '} ${t}${e ? '  → ' + e : ''}`); b ? ok++ : mal++; };
const dormir = ms => new Promise(r => setTimeout(r, ms));

const PUERTO = 3177;
const B = `http://127.0.0.1:${PUERTO}`;
const PASS = 'clave-de-prueba-larga';
const SECRET = 'secreto-de-prueba';

const dir = await mkdtemp(join(tmpdir(), 'minimundo-demo-'));
const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production', PORT: String(PUERTO), DATA_DIR: dir,
    APP_PASSWORD: PASS, HOOK_SECRET: SECRET,
    SIMULADOR: '0', SIMULADOR_EN_PROD: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let salida = '';
server.stdout.on('data', d => { salida += d; });
server.stderr.on('data', d => { salida += d; });

const limpiar = async () => {
  server.kill();
  await rm(dir, { recursive: true, force: true });
};
process.on('exit', () => server.kill());

try {
  // esperar a que levante
  for (let i = 0; i < 50; i++) {
    try { await fetch(B + '/salud'); break; } catch { await dormir(200); }
  }

  const salud = () => fetch(B + '/salud').then(r => r.json());
  const { token } = await (await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: PASS }),
  })).json();
  const H = { 'x-token': token, 'Content-Type': 'application/json' };
  const estado = () => fetch(B + '/api/estado', { headers: H }).then(r => r.json());
  const sim = cuerpo => fetch(B + '/api/simulador', {
    method: 'POST', headers: H, body: JSON.stringify(cuerpo),
  });

  // Una venta real, firmada como la mandaría el POS.
  const mandarReal = async () => {
    const cuerpo = JSON.stringify({
      ventas: [{
        externo_id: 'REAL-' + crypto.randomUUID(), local: 'soho',
        ts: new Date().toISOString(), monto: 42000, items: 3, medio: 'tarjeta',
      }],
    });
    const firma = crypto.createHmac('sha256', SECRET).update(cuerpo).digest('hex');
    return fetch(B + '/hook/ventas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-temple-firma': firma },
      body: cuerpo,
    });
  };

  // ── 1 · base limpia: se puede prender ────────────────────────────────
  let s = await salud();
  m(s.simulador_disponible === true && s.ventas_reales === false,
    'con la base sin ventas reales, el simulador está disponible');

  const r1 = await sim({ on: true, velocidad: 400 });
  m(r1.status === 200 && (await r1.clone().json()).on === true,
    'se prende en producción', `HTTP ${r1.status}`);

  // ── 2 · el tablero avisa ─────────────────────────────────────────────
  await dormir(2500);
  let e = await estado();
  m(e.simulador === true && e.simulado === true,
    'el tablero sabe que está prendido y que los números son inventados');
  const falsas = e.cadena.hoy.tickets;
  m(falsas > 0, 'entraron ventas inventadas', `${falsas} tickets`);

  // ── 3 · apagado: el cartel NO se va, porque la plata falsa sigue ──────
  await sim({ on: false });
  e = await estado();
  m(e.simulador === false && e.simulado === true,
    'apagado, el cartel sigue: los números falsos no se fueron solos');

  // ── 4 · la primera venta real lo cierra ──────────────────────────────
  await sim({ on: true, velocidad: 400 });
  m((await salud()).simulador === true, 'se vuelve a prender');

  const real = await mandarReal();
  m(real.status === 200, 'entra una venta real', `HTTP ${real.status}`);

  s = await salud();
  m(s.simulador === false, 'la venta real apagó el simulador en el acto');
  m(s.ventas_reales === true && s.simulador_disponible === false,
    'y lo dejó cerrado');

  const r2 = await sim({ on: true, velocidad: 400 });
  const cuerpo2 = await r2.json();
  m(r2.status === 403, 'ya no se puede volver a prender', `HTTP ${r2.status}`);
  m(/ventas reales/i.test(cuerpo2.detalle || ''), 'y dice por qué', cuerpo2.detalle);

  e = await estado();
  m(e.simulador_disponible === false,
    'el tablero deja de ofrecer el botón');

  // ── 5 · borrar lo inventado no toca lo real ──────────────────────────
  const antes = (await estado()).cadena.hoy.tickets;
  const borr = await (await fetch(B + '/api/simulador/datos', { method: 'DELETE', headers: H })).json();
  e = await estado();
  m(borr.borradas > 0 && e.cadena.hoy.tickets === 1,
    'borrar lo inventado deja la venta real',
    `${antes} tickets → ${e.cadena.hoy.tickets}, borradas ${borr.borradas}`);
  m(e.simulado === false, 'y recién ahí se apaga el cartel');
  m(e.cadena.hoy.monto === 42000, 'el monto que queda es el de la venta real',
    `$ ${e.cadena.hoy.monto}`);

  m(/simulador apagado/i.test(salida), 'quedó avisado en el log del server');
} finally {
  await limpiar();
}

console.log(`\n${ok} bien, ${mal} mal`);
process.exit(mal ? 1 : 0);
