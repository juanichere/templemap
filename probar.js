'use strict';

// ---------------------------------------------------------------------------
// Smoke test del circuito entero contra un server corriendo.
//
//   BASE=http://127.0.0.1:3000 APP_PASSWORD=... HOOK_SECRET=... node probar.js
//
// Prueba lo que de verdad importa y es fácil de romper sin darse cuenta: la
// firma del webhook, la idempotencia, la validación de cada campo, el corte
// del día comercial a las 6 y que la venta salga por el stream.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PASS = process.env.APP_PASSWORD || 'temple123';
const SECRET = process.env.HOOK_SECRET || '';

let ok = 0, mal = 0;
const marca = (bien, texto, extra) => {
  console.log(`${bien ? ' ok ' : 'MAL '} ${texto}${extra ? `  → ${extra}` : ''}`);
  bien ? ok++ : mal++;
};

function hook(cuerpo) {
  const crudo = JSON.stringify(cuerpo);
  const headers = { 'Content-Type': 'application/json' };
  if (SECRET) {
    headers['x-temple-firma'] = crypto.createHmac('sha256', SECRET).update(crudo).digest('hex');
  }
  return fetch(`${BASE}/hook/ventas`, { method: 'POST', headers, body: crudo });
}

const venta = (extra = {}) => ({
  externo_id: `TEST-${crypto.randomUUID()}`,
  local: 'madero',
  ts: new Date().toISOString(),
  monto: 28400,
  items: 3,
  medio: 'tarjeta',
  ...extra,
});

(async () => {
  if (!SECRET) {
    console.log('Sin HOOK_SECRET no se puede probar la firma. Exportalo y repetí.');
    process.exit(1);
  }

  // --- firma ---------------------------------------------------------------
  let r = await fetch(`${BASE}/hook/ventas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-temple-firma': 'a'.repeat(64) },
    body: JSON.stringify(venta()),
  });
  marca(r.status === 401, 'firma inválida → 401', `dio ${r.status}`);

  r = await fetch(`${BASE}/hook/ventas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(venta()),
  });
  marca(r.status === 401, 'sin firma → 401', `dio ${r.status}`);

  // --- alta e idempotencia -------------------------------------------------
  const v = venta();
  r = await hook(v);
  let j = await r.json();
  marca(r.status === 200 && j.nuevas === 1, 'venta válida entra', JSON.stringify(j));

  r = await hook(v);
  j = await r.json();
  marca(r.status === 200 && j.nuevas === 0 && j.repetidas === 1,
    'la misma venta no se cuenta dos veces', JSON.stringify(j));

  // --- validación ----------------------------------------------------------
  const malas = [
    [venta({ monto: 'cero' }), 'monto que no es número'],
    [venta({ monto: -5 }), 'monto negativo'],
    [venta({ local: 'no-existe' }), 'local desconocido'],
    [venta({ ts: 'cuando sea' }), 'fecha ilegible'],
    [venta({ externo_id: '' }), 'sin id externo'],
    [venta({ ts: new Date(Date.now() + 90 * 86400000).toISOString() }), 'fecha en el futuro'],
  ];
  for (const [cuerpo, texto] of malas) {
    r = await hook(cuerpo);
    j = await r.json();
    marca(r.status === 422 && j.rechazadas.length === 1, `rechaza ${texto}`,
      j.rechazadas && j.rechazadas[0] && j.rechazadas[0].error);
  }

  // --- lote mezclado -------------------------------------------------------
  r = await hook([venta(), venta({ monto: 0 }), venta()]);
  j = await r.json();
  marca(r.status === 422 && j.nuevas === 2 && j.rechazadas.length === 1,
    'un lote mezclado guarda las buenas y reporta la mala', JSON.stringify(j));

  // --- día comercial -------------------------------------------------------
  // Las 3 de la mañana de un día pertenecen al día comercial ANTERIOR: el día
  // de un bar cierra a las 6, no a medianoche.
  //
  // La fecha sale del día comercial que informa el server y NO de la fecha UTC
  // de esta máquina. Construirla con Date.UTC() hacía que la prueba fallara
  // después de las 21 de Argentina, cuando en UTC ya es el día siguiente: la
  // "madrugada" se iba a mañana y caía en el mismo día comercial que el resto.
  // Argentina está fija en UTC−3 todo el año, así que el offset va escrito.
  const { dia_comercial: diaHoy } = await (await fetch(`${BASE}/salud`)).json();
  const madrugada = new Date(`${diaHoy}T03:00:00-03:00`);
  r = await hook(venta({ ts: madrugada.toISOString(), externo_id: `TEST-MADRUGADA-${Date.now()}` }));
  marca(r.status === 200, 'entra una venta de la madrugada');

  // --- sesión y lecturas ---------------------------------------------------
  r = await fetch(`${BASE}/api/estado`);
  marca(r.status === 401, 'el estado pide sesión', `dio ${r.status}`);

  r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: PASS + 'x' }),
  });
  marca(r.status === 401, 'contraseña incorrecta → 401', `dio ${r.status}`);

  r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: PASS }),
  });
  const { token } = await r.json();
  marca(!!token, 'login devuelve token');

  const auth = { 'x-token': token };
  const estado = await (await fetch(`${BASE}/api/estado`, { headers: auth })).json();
  const madero = estado.locales.find(L => L.id === 'madero');
  marca(madero && madero.hoy.tickets >= 1, 'el estado ya muestra las ventas de hoy',
    madero && `${madero.hoy.tickets} tickets`);
  marca(estado.cadena.objetivo_mensual > estado.cadena.objetivo_diario * 20,
    'el objetivo del mes se arma día por día',
    `${estado.cadena.objetivo_mensual} vs ${estado.cadena.objetivo_diario}`);

  const ventas = await (await fetch(`${BASE}/api/ventas?desde=2000-01-01`, { headers: auth })).json();
  const dias = new Set(ventas.ventas.map(x => x.dia_com));
  marca(dias.size >= 2, 'la venta de la madrugada quedó en el día anterior',
    [...dias].join(', '));

  // --- stream --------------------------------------------------------------
  const llego = await new Promise(async resolve => {
    const ctrl = new AbortController();
    const t = setTimeout(() => { ctrl.abort(); resolve(false); }, 4000);
    try {
      const resp = await fetch(`${BASE}/api/stream`, { headers: auth, signal: ctrl.signal });
      const lector = resp.body.getReader();
      let buffer = '';
      // la primera venta que entre después de conectarnos tiene que aparecer acá
      setTimeout(() => hook(venta({ monto: 12345 })), 400);
      while (true) {
        const { value, done } = await lector.read();
        if (done) break;
        buffer += Buffer.from(value).toString('utf8');
        if (buffer.includes('event: venta') && buffer.includes('12345')) {
          clearTimeout(t); ctrl.abort(); resolve(true); break;
        }
      }
    } catch (err) { resolve(false); }
  });
  marca(llego, 'la venta sale por el stream SSE');

  console.log(`\n${ok} bien, ${mal} mal`);
  process.exit(mal ? 1 : 0);
})();
