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
  { id: 'obelisco',  nombre: 'Obelisco',       lat: -34.603709, lng: -58.381630, radio: 26 },
  { id: 'rosada',    nombre: 'Casa Rosada',    lat: -34.608069, lng: -58.370276, radio: 30 },
  { id: 'bombonera', nombre: 'La Bombonera',   lat: -34.635517, lng: -58.364916, radio: 38 },
  { id: 'monumental',nombre: 'Monumental',     lat: -34.545293, lng: -58.449739, radio: 40 },
  { id: 'arcos',     nombre: 'Arcos del Barrio Chino', lat: -34.557092, lng: -58.450914, radio: 24 },
  { id: 'planetario',nombre: 'Planetario',     lat: -34.569649, lng: -58.411721, radio: 26 },
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
  };

  // Caja con su base en y=0 y no en el centro, que es como se piensa un
  // edificio. Ahorra un position.y a mano en cada pieza.
  const caja = (w, h, d, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y + h / 2, z);
    return m;
  };

  /* ── Obelisco ───────────────────────────────────────────────────────────
     Un prisma de cuatro caras que afina hacia arriba. Cuatro segmentos
     radiales en un cilindro dan exactamente eso; el giro de 45° deja las
     caras enfrentadas a la calle y no las aristas. */
  function obelisco() {
    const g = new THREE.Group();
    g.add(caja(11, 2.2, 11, M.piedra));

    const cuerpo = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 4.6, 36, 4), M.piedra);
    cuerpo.rotation.y = Math.PI / 4;
    cuerpo.position.y = 2.2 + 18;
    g.add(cuerpo);

    // la punta: la pirámide chiquita que lo remata
    const punta = new THREE.Mesh(new THREE.ConeGeometry(2.1, 3.4, 4), M.piedra);
    punta.rotation.y = Math.PI / 4;
    punta.position.y = 2.2 + 36 + 1.4;
    g.add(punta);
    return g;
  }

  /* ── Casa Rosada ────────────────────────────────────────────────────────
     Ancha, baja y rosa. El rosa hace casi todo el trabajo de reconocerla; la
     silueta aporta el cuerpo central más alto con su arco y las torres de las
     esquinas. */
  function casaRosada() {
    const g = new THREE.Group();
    const AN = 30, FO = 19, AL = 11;

    g.add(caja(AN, AL, FO, M.rosada));
    // cornisa: un reborde apenas más ancho, que le da sombra propia al frente
    g.add(caja(AN + 1.6, 1.1, FO + 1.6, M.rosadaOscuro, 0, AL, 0));
    // cuerpo central, el del balcón
    g.add(caja(9.5, 15.5, FO + 2.4, M.rosada));
    g.add(caja(10.8, 1.2, FO + 3.4, M.rosadaOscuro, 0, 15.5, 0));

    // torres de las esquinas
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      g.add(caja(5.2, 14, 5.2, M.rosada, sx * (AN / 2 - 2.6), 0, sz * (FO / 2 - 2.6)));
      g.add(caja(5.9, 1, 5.9, M.rosadaOscuro,
        sx * (AN / 2 - 2.6), 14, sz * (FO / 2 - 2.6)));
    }
    return g;
  }

  /* ── canchas ────────────────────────────────────────────────────────────
     Las dos son el mismo problema: desde arriba una cancha es un anillo de
     tribunas con un rectángulo verde adentro. Lo que las distingue es la
     forma del anillo y el color. */
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
    const AN = 42, FO = 35, GRUESO = 5.5;
    /* ⚠️ Las tribunas van en 10 y no en 13.

       La Bombonera de verdad es alta y encajonada —de ahí el apodo—, pero
       mirada desde los 40° de la cámara del tablero, una pared de 13 contra un
       hueco de 18 tapa el piso entero: quedaba una caja azul con un agujero
       negro, no una cancha. Bajas a 10 y con el hueco un poco más grande se ve
       el verde, que es lo que la hace reconocible de una.

       El paredón sí queda alto: es la seña de la cancha y va de un solo lado,
       así que no tapa nada cuando la cámara gira. */
    const ALTO = 10;

    g.add(cesped(AN - 13, FO - 11, 1.4));
    // las tres tribunas
    g.add(caja(AN, ALTO, GRUESO, M.bocaAzul, 0, 0, -(FO / 2 - GRUESO / 2)));
    g.add(caja(GRUESO, ALTO, FO - GRUESO * 2, M.bocaAzul, -(AN / 2 - GRUESO / 2), 0, 0));
    g.add(caja(GRUESO, ALTO, FO - GRUESO * 2, M.bocaAzul, AN / 2 - GRUESO / 2, 0, 0));
    // el paredón: más alto, más fino y plano
    g.add(caja(AN, ALTO + 5.5, 3.6, M.bocaAzul, 0, 0, FO / 2 - 1.8));

    // la franja amarilla, arriba de todo el anillo
    const F = GRUESO + 0.5;
    g.add(caja(AN + 0.5, 1.8, F, M.bocaAmarillo, 0, ALTO - 2, -(FO / 2 - GRUESO / 2)));
    g.add(caja(F, 1.8, FO - GRUESO * 2, M.bocaAmarillo, -(AN / 2 - GRUESO / 2), ALTO - 2, 0));
    g.add(caja(F, 1.8, FO - GRUESO * 2, M.bocaAmarillo, AN / 2 - GRUESO / 2, ALTO - 2, 0));
    g.add(caja(AN + 0.5, 1.8, 4.1, M.bocaAmarillo, 0, ALTO + 1.7, FO / 2 - 1.8));
    return g;
  }

  /* El Monumental sí es un óvalo cerrado, y más grande. Un cilindro abierto
     de los dos lados es el anillo de tribunas; escalado en un eje, el óvalo. */
  function monumental() {
    const g = new THREE.Group();
    const R = 21, ALTO = 14;

    const anillo = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R + 2.5, ALTO, 30, 1, true), M.riverBlanco);
    anillo.material.side = THREE.DoubleSide;
    anillo.position.y = ALTO / 2;
    anillo.scale.z = 0.86;
    g.add(anillo);

    // la banda roja arriba, que es lo que lo hace River de un vistazo
    const banda = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.4, R + 0.9, 2.6, 30, 1, true), M.riverRojo);
    banda.material.side = THREE.DoubleSide;
    banda.position.y = ALTO - 1.3;
    banda.scale.z = 0.86;
    g.add(banda);

    // el piso de la bandeja, para que no se vea el pasto por abajo del anillo
    const piso = new THREE.Mesh(new THREE.CircleGeometry(R + 2.5, 30), M.hormigonOscuro);
    piso.rotation.x = -Math.PI / 2;
    piso.position.y = 0.3;
    piso.scale.y = 0.86;
    g.add(piso);
    g.add(cesped(24, 17));
    return g;
  }

  /* ── Arcos del Barrio Chino ─────────────────────────────────────────────
     Un paifang: columnas rojas, dintel, y dos techos de tejas encimados con
     los aleros para arriba. Los dos techos importan — con uno solo parece un
     cartel de ruta. Van como conos de cuatro caras, que es la simplificación
     que a esta distancia se lee igual. */
  function arcos() {
    const g = new THREE.Group();
    const LUZ = 17;                       // la separación entre columnas

    for (const sx of [-1, 1]) {
      g.add(caja(3.1, 14, 3.1, M.chinoRojo, sx * LUZ / 2, 0, 0));
      g.add(caja(4.6, 1.1, 4.6, M.chinoOro, sx * LUZ / 2, 0, 0));   // basa
    }
    g.add(caja(LUZ + 5, 2.8, 3.8, M.chinoRojo, 0, 14, 0));          // dintel
    g.add(caja(LUZ + 6.4, 1, 4.6, M.chinoOro, 0, 16.8, 0));         // friso

    const techo = (ancho, alto, y) => {
      const t = new THREE.Mesh(new THREE.ConeGeometry(ancho, alto, 4), M.chinoTecho);
      t.rotation.y = Math.PI / 4;
      t.position.y = y + alto / 2;
      t.scale.z = 0.4;                    // un paifang es ancho y poco profundo
      return t;
    };
    g.add(techo(14.5, 4.2, 17.8));
    g.add(techo(9.2, 3.4, 22));
    return g;
  }

  /* ── Planetario ─────────────────────────────────────────────────────────
     La esfera sobre tres patas. Es la silueta más distinta de todas: no hay
     otra cosa redonda y levantada en toda la ciudad, así que se reconoce
     incluso cuando mide veinte píxeles. */
  function planetario() {
    const g = new THREE.Group();

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(13, 14, 1.6, 28), M.hormigonOscuro);
    base.position.y = 0.8;
    g.add(base);

    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
      const pata = new THREE.Mesh(
        new THREE.CylinderGeometry(1.1, 1.9, 13, 10), M.hormigon);
      // inclinada hacia afuera: apoya ancho abajo y junta arriba, como las de verdad
      pata.position.set(Math.cos(a) * 5.2, 1.6 + 6.5, Math.sin(a) * 5.2);
      pata.rotation.z = -Math.cos(a) * 0.3;
      pata.rotation.x = Math.sin(a) * 0.3;
      g.add(pata);
    }

    const esfera = new THREE.Mesh(new THREE.SphereGeometry(8.4, 22, 16), M.hormigon);
    esfera.position.y = 1.6 + 13 + 5.6;
    g.add(esfera);

    // el anillo de ventanas, que le marca el ecuador
    const anillo = new THREE.Mesh(
      new THREE.CylinderGeometry(8.5, 8.5, 1.8, 22, 1, true), M.hormigonOscuro);
    anillo.material.side = THREE.DoubleSide;
    anillo.position.y = esfera.position.y - 1.2;
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
  return { obelisco: 48, rosada: 24, bombonera: 27, monumental: 24, arcos: 31, planetario: 36 }[id] || 26;
}

/* Qué tan visibles están los nombres. 1 cuando la cámara está encima, 0 en la
   vista panorámica. La transición es larga a propósito: un cartel que aparece
   de golpe al cruzar un umbral se lee como un parpadeo. */
export function opacidadEtiquetas(distanciaCamara) {
  return Math.max(0, Math.min(1, (700 - distanciaCamara) / 260));
}
