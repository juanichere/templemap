/* ───────────────────────────────────────────────────────────────────────────
   Dónde está el sol.

   Se calcula acá y no se le pide a ninguna API: es astronomía, da el mismo
   número siempre, y el ciclo día/noche del mundo no puede depender de que un
   servicio de terceros esté arriba. El clima sí se pide afuera (no se puede
   calcular), pero el amanecer no.

   Precisión: las fórmulas de posición solar de bajo orden del Astronomical
   Almanac, buenas a ~0.01° entre 1950 y 2050. Para decidir el color del cielo
   sobra, y el error en el amanecer es de segundos.
   ─────────────────────────────────────────────────────────────────────────── */

const RAD = Math.PI / 180;
const GRA = 180 / Math.PI;

// Días (fraccionarios) desde J2000.0 = 2000-01-01 12:00 UTC.
const diasJ2000 = fecha => fecha.getTime() / 86400000 - 10957.5;

// El sol se tiene por salido cuando el borde superior toca el horizonte: medio
// disco (0.267°) más la refracción de la atmósfera (0.566°).
const H_HORIZONTE = -0.833 * RAD;

/* ── posición ────────────────────────────────────────────────────────────── */

// Altitud sobre el horizonte y azimut desde el norte creciendo hacia el este,
// los dos en radianes. `lng` en grados, negativa al oeste.
export function posicionSolar(fecha, lat, lng) {
  const d = diasJ2000(fecha);

  // Coordenadas eclípticas del sol.
  const L = (280.460 + 0.9856474 * d) * RAD;            // longitud media
  const g = (357.528 + 0.9856003 * d) * RAD;            // anomalía media
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 3.56e-7 * d) * RAD;             // oblicuidad

  // A ecuatoriales.
  const sinLam = Math.sin(lambda);
  const ar = Math.atan2(Math.cos(eps) * sinLam, Math.cos(lambda));  // ascensión recta
  const dec = Math.asin(Math.sin(eps) * sinLam);                    // declinación

  // Ángulo horario: cuánto le falta al sol para pasar por este meridiano.
  const gmst = (280.46061837 + 360.98564736629 * d) * RAD;
  const H = gmst + lng * RAD - ar;

  const fi = lat * RAD;
  const sf = Math.sin(fi), cf = Math.cos(fi);
  const sd = Math.sin(dec), cd = Math.cos(dec);
  const sH = Math.sin(H), cH = Math.cos(H);

  return {
    altitud: Math.asin(sf * sd + cf * cd * cH),
    azimut: Math.atan2(-sH * cd, sd * cf - cd * sf * cH),
    declinacion: dec,
  };
}

/* ── husos horarios ──────────────────────────────────────────────────────── */

// Minutos que la zona le lleva a UTC en ese instante. Sale de Intl y no de una
// tabla propia: el navegador ya tiene la base de datos de husos, con sus
// cambios de horario incluidos.
export function offsetZona(fecha, zona) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zona, timeZoneName: 'longOffset' })
    .formatToParts(fecha);
  const txt = (p.find(x => x.type === 'timeZoneName') || {}).value || '';
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(txt);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

// La hora del reloj de pared en esa zona, como número decimal (13.5 = 13:30).
export function horaDecimal(fecha, zona) {
  const h = fecha.getTime() / 3600000 + offsetZona(fecha, zona) / 60;
  return ((h % 24) + 24) % 24;
}

// El instante UTC de la medianoche con la que arranca el día civil que corre
// en esa zona. Se resuelve el offset dos veces porque la primera se evalúa en
// "ahora" y la segunda en la medianoche misma, que puede caer del otro lado de
// un cambio de hora.
function medianocheLocal(fecha, zona) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(fecha);
  const v = t => Number(p.find(x => x.type === t).value);
  const base = Date.UTC(v('year'), v('month') - 1, v('day'));
  let t = base - offsetZona(fecha, zona) * 60000;
  t = base - offsetZona(new Date(t), zona) * 60000;
  return t;
}

/* ── amanecer y atardecer ────────────────────────────────────────────────── */

// Se buscan numéricamente en vez de con la fórmula cerrada del ángulo horario.
// Cuesta ~150 evaluaciones de trigonometría una vez por día, y a cambio no hay
// que acertarle a los signos ni a las normalizaciones de la fórmula —y el día
// polar sale solo: si el sol nunca cruza el horizonte, no hay cruce que
// devolver. Importa de verdad: la cadena llega hasta Río Gallegos.
export function horasSolares(fecha, lat, lng, zona) {
  const t0 = medianocheLocal(fecha, zona);
  const off = offsetZona(new Date(t0), zona);
  const alturaEn = min => posicionSolar(new Date(t0 + min * 60000), lat, lng).altitud - H_HORIZONTE;
  const aLocal = min => ((((t0 + min * 60000) / 3600000 + off / 60) % 24) + 24) % 24;

  // Barrido grueso de 10 minutos para encontrar los cruces, y bisección para
  // ajustarlos al segundo.
  const cruces = [];
  let prev = alturaEn(0);
  for (let m = 10; m <= 1440; m += 10) {
    const act = alturaEn(m);
    if ((prev < 0) !== (act < 0)) {
      let a = m - 10, b = m;
      for (let i = 0; i < 9; i++) {
        const c = (a + b) / 2;
        if ((alturaEn(a) < 0) === (alturaEn(c) < 0)) a = c; else b = c;
      }
      cruces.push({ min: (a + b) / 2, subiendo: prev < 0 });
    }
    prev = act;
  }

  // Mediodía solar: el máximo del día, al minuto.
  let mejor = 0, maxAlt = -9;
  for (let m = 0; m <= 1440; m += 10) {
    const h = posicionSolar(new Date(t0 + m * 60000), lat, lng).altitud;
    if (h > maxAlt) { maxAlt = h; mejor = m; }
  }

  const sube = cruces.find(c => c.subiendo);
  const baja = cruces.filter(c => !c.subiendo).pop();

  return {
    amanecer: sube ? aLocal(sube.min) : null,
    atardecer: baja ? aLocal(baja.min) : null,
    mediodia: aLocal(mejor),
    alturaMaxima: maxAlt * GRA,
    // Sin cruces: o el sol no se puso nunca, o no salió nunca.
    siempreDeDia: !cruces.length && maxAlt > H_HORIZONTE,
    siempreDeNoche: !cruces.length && maxAlt <= H_HORIZONTE,
  };
}

/* ── luz ─────────────────────────────────────────────────────────────────── */

/* Cuánta luz de día hay, 0..1, a partir de la altura del sol.

   No es lineal con la hora, que es lo que hacía antes el mundo con una ventana
   fija de 6:40 a 20:00. Un día de junio en Buenos Aires tiene el sol a 32° al
   mediodía y uno de diciembre a 78°: el invierno tiene que verse más apagado,
   y el atardecer tiene que correrse dos horas entre una estación y la otra.

   Debajo del horizonte no se va a cero de golpe: el crepúsculo civil llega
   hasta −6° y todavía se ve, y se apaga del todo cerca de −12°. Es la media
   hora larga en la que la ciudad se prende y el cielo queda violeta. */
export function luzDeAltitud(altitud) {
  const g = altitud * GRA;
  if (g >= 0) return 0.10 + 0.90 * Math.sin(altitud) ** 0.75;
  return Math.max(0, (g + 12) / 12) * 0.10;
}

export const hhmm = h => (h == null ? '—'
  : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`);
