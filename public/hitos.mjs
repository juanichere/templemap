/* ───────────────────────────────────────────────────────────────────────────
   Los hitos de Buenos Aires.

   No tienen datos atrás: no facturan, no se clickean, no entran en ningún
   promedio. Están para que el mapa se lea. Un plano de CABA con diez cajas
   iguales no dice dónde estás parado; con el Obelisco, la Casa Rosada y las
   dos canchas, sí — y de paso se ve de una que Puerto Madero está al lado de
   Plaza de Mayo y que Núñez está lejos de todo.

   Cada uno se modela para reconocerse **desde arriba y de lejos**, que es como
   se mira este tablero. Eso manda sobre el parecido: la silueta y el color
   importan más que el detalle, porque a la distancia de la vista panorámica
   un hito mide treinta píxeles.

   Las coordenadas salen de geocodificar contra OpenStreetMap.

   ⚠️ La escala del mundo es de maqueta, no real: un local mide 15 unidades de
   ancho y la ciudad entera 442, así que 26 unidades son un kilómetro y un
   edificio de 15 "mide" medio kilómetro. Los hitos siguen esa misma mentira a
   propósito — el Obelisco acá es más ancho que una manzana. Si se los hiciera
   a escala real no se vería ninguno.
   ─────────────────────────────────────────────────────────────────────────── */

export const HITOS = [
  { id: 'obelisco',  nombre: 'Obelisco',       lat: -34.603709, lng: -58.381630, radio: 17 },
  { id: 'rosada',    nombre: 'Casa Rosada',    lat: -34.608069, lng: -58.370276, radio: 21 },
  { id: 'bombonera', nombre: 'La Bombonera',   lat: -34.635517, lng: -58.364916, radio: 25 },
  { id: 'monumental',nombre: 'Monumental',     lat: -34.545293, lng: -58.449739, radio: 27 },
  { id: 'arcos',     nombre: 'Arcos del Barrio Chino', lat: -34.557092, lng: -58.450914, radio: 16 },
  { id: 'planetario',nombre: 'Planetario',     lat: -34.569649, lng: -58.411721, radio: 18 },
];

/* ── paleta ──────────────────────────────────────────────────────────────── */
// Los colores son de los edificios, no de la marca: un Obelisco amarillo o una
// Bombonera magenta no se reconocen, y reconocerlos es todo el punto.
const C = {
  piedra: 0xe4ded0,          // el Obelisco
  rosada: 0xd4808f,          // el rosa de la Casa Rosada
  rosadaOscuro: 0xb9697a,
  bocaAzul: 0x0d3c91,
  bocaAmarillo: 0xf2c200,
  riverBlanco: 0xe7eaf0,
  riverRojo: 0xcf1036,
  cesped: 0x3f8f4c,
  chinoRojo: 0xbe3327,
  chinoTecho: 0x1d7a53,
  chinoOro: 0xd8a62a,
  hormigon: 0xcfd4dc,
  hormigonOscuro: 0x6e6a74,
  espejo: 0x2d5a86,          // el espejo de agua del Planetario
  ventana: 0x3b4660,
};

export function construirHitos(THREE, proj, { liviano = false } = {}) {
  const grupo = new THREE.Group();
  const etiquetas = [];

  /* Cada hito se enciende de noche.

     No es un adorno: sin esto, a las once de la noche —que es cuando un bar
     factura y cuando el tablero está prendido— el Obelisco es un palo gris
     contra una ciudad con todas las ventanas encendidas, y no se ve. Y
     además es lo que pasa de verdad: la Casa Rosada, el Obelisco y las dos
     canchas están iluminados.

     El emisivo es el color propio de cada uno, así que lo que se prende es el
     edificio y no una luz de otro color encima. La intensidad la maneja el
     ciclo diario con `iluminarHitos`. */
  const emisivos = [];
  const mat = (color, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color, roughness: 0.82, emissive: color, emissiveIntensity: 0, ...extra,
    });
    emisivos.push(m);
    return m;
  };

  const M = {
    piedra: mat(C.piedra, { roughness: 0.9 }),
    rosada: mat(C.rosada),
    rosadaOscuro: mat(C.rosadaOscuro),
    bocaAzul: mat(C.bocaAzul, { roughness: 0.7 }),
    bocaAmarillo: mat(C.bocaAmarillo, { roughness: 0.6 }),
    riverBlanco: mat(C.riverBlanco, { roughness: 0.7 }),
    riverRojo: mat(C.riverRojo, { roughness: 0.6 }),
    cesped: mat(C.cesped, { roughness: 0.95 }),
    chinoRojo: mat(C.chinoRojo, { roughness: 0.65 }),
    chinoTecho: mat(C.chinoTecho, { roughness: 0.6 }),
    chinoOro: mat(C.chinoOro, { roughness: 0.4, metalness: 0.55 }),
    hormigon: mat(C.hormigon, { roughness: 0.75 }),
    hormigonOscuro: mat(C.hormigonOscuro),
    espejo: mat(C.espejo, { roughness: 0.18, metalness: 0.5 }),
    ventana: mat(C.ventana, { roughness: 0.3, metalness: 0.4 }),
  };

  // Caja con su base en y=0 y no en el centro, que es como se piensa un
  // edificio. Ahorra un position.y a mano en cada pieza.
  const caja = (w, h, d, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y + h / 2, z);
    return m;
  };

  /* ── Obelisco ───────────────────────────────────────────────────────────
     El de verdad es flaco: 67 metros de alto por 6,8 de lado, uno a diez. La
     primera versión salió uno a cuatro y parecía un monolito. La esbeltez es
     lo que lo hace el Obelisco; sin eso es una piedra parada.

     Un cilindro de cuatro segmentos radiales da el prisma que afina; el giro
     de 45° deja las caras enfrentadas a la calle y no las aristas. */
  function obelisco() {
    const g = new THREE.Group();
    // el basamento escalonado
    g.add(caja(7.4, 0.9, 7.4, M.piedra));
    g.add(caja(5.6, 1.1, 5.6, M.piedra, 0, 0.9, 0));

    const H = 25;
    const cuerpo = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 2.2, H, 4), M.piedra);
    cuerpo.rotation.y = Math.PI / 4;
    cuerpo.position.y = 2 + H / 2;
    g.add(cuerpo);

    const punta = new THREE.Mesh(new THREE.ConeGeometry(1.05, 2.1, 4), M.piedra);
    punta.rotation.y = Math.PI / 4;
    punta.position.y = 2 + H + 1.05;
    g.add(punta);
    return g;
  }

  /* ── Casa Rosada ────────────────────────────────────────────────────────
     Ancha, baja y rosa. El rosa hace casi todo; la silueta aporta el cuerpo
     central más alto —el del balcón— y las cuatro torres de esquina con sus
     remates. Las torres sin remate quedaban como cajas pegadas. */
  function casaRosada() {
    const g = new THREE.Group();
    const AN = 21, FO = 13.5, AL = 7.5;

    g.add(caja(AN, AL, FO, M.rosada));
    g.add(caja(AN + 1.1, 0.7, FO + 1.1, M.rosadaOscuro, 0, AL, 0));  // cornisa

    // cuerpo central, el del balcón, apenas salido del plano del frente
    g.add(caja(6.6, 11, FO + 1.6, M.rosada));
    g.add(caja(7.5, 0.8, FO + 2.4, M.rosadaOscuro, 0, 11, 0));
    // el arco de entrada: un hueco oscuro, que es lo que se ve de frente
    g.add(caja(2.6, 4.4, 1.2, M.rosadaOscuro, 0, 0, (FO + 1.6) / 2 - 0.2));

    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (AN / 2 - 1.9), z = sz * (FO / 2 - 1.9);
      g.add(caja(3.6, 9.4, 3.6, M.rosada, x, 0, z));
      g.add(caja(4.1, 0.6, 4.1, M.rosadaOscuro, x, 9.4, z));
      // el remate: sin esto las torres son cajas pegadas al techo
      const cap = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.1, 4), M.rosadaOscuro);
      cap.rotation.y = Math.PI / 4;
      cap.position.set(x, 10 + 1.05, z);
      g.add(cap);
    }
    return g;
  }

  /* ── canchas ────────────────────────────────────────────────────────────
     Desde arriba una cancha es un anillo de tribunas con un rectángulo verde
     adentro. Lo que las distingue es la forma del anillo y el color.

     Las dos van en dos niveles —una bandeja baja adentro y una alta afuera—
     en vez de una pared vertical sola. Con un solo nivel parecían una pileta:
     lo que dice "tribuna" es el escalón. */
  function cesped(an, fo, y = 0.2) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(an, 0.8, fo), M.cesped);
    m.position.y = y + 0.4;
    return m;
  }

  /* La Bombonera no es un óvalo: son tres tribunas y una pared recta y
     vertical, que es de donde le viene el apodo y la forma. Por eso va con
     cajas y no con un cilindro. */
  function bombonera() {
    const g = new THREE.Group();
    const AN = 25, FO = 21;
    const ALTO = 7.4, BAJA = 4.2;     // bandeja alta y bandeja baja
    const GR = 3.4, GR_B = 1.9;

    g.add(cesped(AN - 11, FO - 9.5, 1));

    // anillo de tres lados, en dos escalones
    const lado = (w, h, d, x, z, mat) => g.add(caja(w, h, d, mat, x, 0, z));
    const zAtras = -(FO / 2 - GR / 2), xLado = AN / 2 - GR / 2;
    const fondo = FO - GR * 2;

    lado(AN, ALTO, GR, 0, zAtras, M.bocaAzul);
    lado(GR, ALTO, fondo, -xLado, 0, M.bocaAzul);
    lado(GR, ALTO, fondo, xLado, 0, M.bocaAzul);
    // la baja, metida para adentro
    lado(AN - GR * 2, BAJA, GR_B, 0, zAtras + GR / 2 + GR_B / 2, M.bocaAzul);
    lado(GR_B, BAJA, fondo - GR_B * 2, -(xLado - GR / 2 - GR_B / 2), 0, M.bocaAzul);
    lado(GR_B, BAJA, fondo - GR_B * 2, xLado - GR / 2 - GR_B / 2, 0, M.bocaAzul);

    // el paredón: más alto, más fino y plano. Es la seña de la cancha.
    g.add(caja(AN, ALTO + 4.4, 2.4, M.bocaAzul, 0, 0, FO / 2 - 1.2));

    /* La franja amarilla va como un filete en el BORDE DE AFUERA y no tapando
       la tribuna entera: pintada a todo lo ancho del escalón, desde arriba la
       cancha se veía amarilla con un zócalo azul, que es al revés de lo que
       es. Boca es azul con una franja. */
    const F = 1.2, ANCHO_F = 1.1;
    const borde = (w, d, x, z) => g.add(caja(w, F, d, M.bocaAmarillo, x, ALTO - F, z));
    borde(AN + 0.3, ANCHO_F, 0, -(FO / 2 - ANCHO_F / 2));
    borde(ANCHO_F, fondo + GR, -(AN / 2 - ANCHO_F / 2), 0);
    borde(ANCHO_F, fondo + GR, AN / 2 - ANCHO_F / 2, 0);
    g.add(caja(AN + 0.3, F, 2.7, M.bocaAmarillo, 0, ALTO + 3.2, FO / 2 - 1.2));
    return g;
  }

  /* El Monumental sí es un óvalo cerrado, y más grande.

     ⚠️ El anillo va más ancho ARRIBA que abajo. Una tribuna se abre hacia
     afuera a medida que sube; al revés —que es como salió la primera vez— se
     lee como un tacho, no como un estadio. */
  function monumental() {
    const g = new THREE.Group();
    const R = 15, ALTO = 9.4, ACHATE = 0.84;

    const anillo = (rAbajo, rArriba, alto, y, mat) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(rArriba, rAbajo, alto, 34, 1, true), mat);
      m.material.side = THREE.DoubleSide;
      m.position.y = y + alto / 2;
      m.scale.z = ACHATE;
      g.add(m);
      return m;
    };

    anillo(R, R + 2.2, ALTO, 0, M.riverBlanco);                    // bandeja alta
    anillo(R - 3.4, R - 2.2, 4.6, 0, M.riverBlanco);               // bandeja baja
    anillo(R + 1.9, R + 2.3, 1.7, ALTO - 1.7, M.riverRojo);        // la banda roja

    const piso = new THREE.Mesh(new THREE.CircleGeometry(R + 2.2, 34), M.hormigonOscuro);
    piso.rotation.x = -Math.PI / 2;
    piso.position.y = 0.25;
    piso.scale.y = ACHATE;
    g.add(piso);
    g.add(cesped(19, 13, 0.3));
    return g;
  }

  /* ── Arcos del Barrio Chino ─────────────────────────────────────────────
     Un paifang: columnas rojas, dintel y dos techos de tejas encimados.

     ⚠️ El techo es lo que lo hace chino, y un cono a secas no alcanza: lo que
     se reconoce es el ALERO que vuela por delante de las columnas. Por eso
     cada techo lleva su losa saliente abajo y la pirámide, bien chata,
     arriba. Con un cono solo parecía una carpa. */
  function arcos() {
    const g = new THREE.Group();
    const LUZ = 11.5;

    for (const sx of [-1, 1]) {
      const x = sx * LUZ / 2;
      g.add(caja(2, 9.5, 2, M.chinoRojo, x, 0, 0));
      g.add(caja(3, 0.8, 3, M.chinoOro, x, 0, 0));        // basa
      g.add(caja(2.5, 0.5, 2.5, M.chinoOro, x, 9.5, 0));  // capitel
    }
    g.add(caja(LUZ + 3.4, 1.9, 2.4, M.chinoRojo, 0, 10, 0));    // dintel
    g.add(caja(LUZ + 4.4, 0.7, 3, M.chinoOro, 0, 11.9, 0));     // friso

    const techo = (ancho, fondo, y) => {
      g.add(caja(ancho, 0.55, fondo, M.chinoTecho, 0, y, 0));   // el alero
      const t = new THREE.Mesh(new THREE.ConeGeometry(ancho * 0.46, 1.8, 4), M.chinoTecho);
      t.rotation.y = Math.PI / 4;
      t.position.y = y + 0.55 + 0.9;
      t.scale.z = fondo / ancho;
      g.add(t);
    };
    techo(LUZ + 7, 4.6, 12.6);
    techo(LUZ + 1, 3.2, 15.6);
    // el remate dorado de la cumbrera
    g.add(caja(0.9, 1.3, 0.9, M.chinoOro, 0, 18.2, 0));
    return g;
  }

  /* ── Planetario ─────────────────────────────────────────────────────────
     La esfera sobre tres patas. Es la silueta más distinta de la ciudad: no
     hay otra cosa redonda y levantada, así que se reconoce aunque mida veinte
     píxeles.

     El espejo de agua alrededor va porque es la mitad de la postal, y porque
     a esta escala un disco oscuro concéntrico lo separa del pasto del parque
     —si no, la base se funde con el verde y la esfera parece flotar. */
  function planetario() {
    const g = new THREE.Group();

    const agua = new THREE.Mesh(new THREE.CircleGeometry(11, 30), M.espejo);
    agua.rotation.x = -Math.PI / 2;
    agua.position.y = 0.14;
    g.add(agua);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(6.4, 7.2, 1.2, 28), M.hormigonOscuro);
    base.position.y = 0.6;
    g.add(base);

    // Patas de sección rectangular y no cilíndricas: las del Planetario son
    // aletas de hormigón, y un cilindro se lee como una columna cualquiera.
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
      const pata = new THREE.Mesh(new THREE.BoxGeometry(1.5, 9, 2.6), M.hormigon);
      pata.position.set(Math.cos(a) * 3.4, 1.2 + 4.5, Math.sin(a) * 3.4);
      pata.rotation.y = -a;
      pata.rotation.z = -Math.cos(a) * 0.26;
      pata.rotation.x = Math.sin(a) * 0.26;
      g.add(pata);
    }

    const yEsfera = 1.2 + 9 + 3.6;
    const esfera = new THREE.Mesh(new THREE.SphereGeometry(5.8, 26, 18), M.hormigon);
    esfera.position.y = yEsfera;
    g.add(esfera);

    const anillo = new THREE.Mesh(
      new THREE.CylinderGeometry(5.9, 5.9, 1.25, 26, 1, true), M.ventana);
    anillo.material.side = THREE.DoubleSide;
    anillo.position.y = yEsfera - 0.8;
    g.add(anillo);
    return g;
  }

  const FORMAS = { obelisco, rosada: casaRosada, bombonera, monumental, arcos, planetario };

  /* ── etiquetas ──────────────────────────────────────────────────────────
     Tamaño fijo en pantalla, como las placas de los locales, pero mucho más
     discretas: sin recuadro, en gris, y **se desvanecen cuando la cámara se
     aleja**. En la vista panorámica no se ven; acercándote aparecen. Si
     estuvieran siempre, seis carteles más compitiendo con las diez placas de
     facturación —que son el dato— dejarían la pantalla ilegible. */
  function etiqueta(texto) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = '600 38px "Barlow Condensed", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(23,21,27,.72)';
    const an = g.measureText(texto.toUpperCase()).width + 26;
    g.fillRect((512 - an) / 2, 10, an, 44);
    g.fillStyle = 'rgba(244,242,238,.9)';
    g.fillText(texto.toUpperCase(), 256, 33);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthTest: false, sizeAttenuation: false,
    }));
    sp.scale.set(0.082, 0.0103, 1);
    sp.renderOrder = 9;                   // debajo de las placas de los locales
    return sp;
  }

  for (const H of HITOS) {
    const [x, z] = proj(H.lat, H.lng);
    const g = FORMAS[H.id]();
    g.position.set(x, 0.12, z);
    if (!liviano) {
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    }
    grupo.add(g);

    const sp = etiqueta(H.nombre);
    sp.position.set(x, altoDe(H.id), z);
    grupo.add(sp);
    etiquetas.push(sp);

    H.wx = x; H.wz = z;
  }

  // El césped no se ilumina: una cancha vacía de noche tiene las tribunas
  // encendidas y el campo apagado, y un rectángulo verde brillante se lee
  // como un error.
  M.cesped.emissiveIntensity = 0;

  return { grupo, etiquetas, hitos: HITOS, materiales: emisivos, cesped: M.cesped };
}

/* Cuánto se encienden, de 0 (mediodía) a 1 (noche cerrada). Va bajo a
   propósito: tienen que leerse, no competir con los carteles de los locales,
   que son lo que el tablero vino a mostrar. */
export function iluminarHitos(materiales, cesped, noche) {
  const i = noche * 0.42;
  for (const m of materiales) m.emissiveIntensity = i;
  if (cesped) cesped.emissiveIntensity = noche * 0.08;
}

// A qué altura cuelga el nombre de cada uno: apenas arriba de su punto más
// alto, que no es el mismo para una cancha que para el Obelisco.
function altoDe(id) {
  return { obelisco: 34, rosada: 17, bombonera: 18, monumental: 15, arcos: 22, planetario: 24 }[id] || 20;
}

/* Qué tan visibles están los nombres. 1 cuando la cámara está encima, 0 en la
   vista panorámica. La transición es larga a propósito: un cartel que aparece
   de golpe al cruzar un umbral se lee como un parpadeo. */
export function opacidadEtiquetas(distanciaCamara) {
  return Math.max(0, Math.min(1, (700 - distanciaCamara) / 260));
}
