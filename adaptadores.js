'use strict';

// ---------------------------------------------------------------------------
// Adaptadores del sistema de ventas.
//
// Acá vive TODO lo que sabe cómo es el payload del proveedor. El resto del
// server sólo conoce la venta normalizada, así que el día que cambie el POS
// se escribe un adaptador nuevo y no se toca nada más.
//
// Un adaptador recibe el cuerpo ya parseado y devuelve un array de ventas
// crudas con esta forma:
//
//   {
//     externo_id: 'A-0001-00012345',   // id del ticket EN EL POS. Obligatorio:
//                                      // es la clave contra la que se dedupe.
//     local:      'madero',            // id nuestro, pos_id, o el nombre
//     ts:         '2026-11-01T23:14:05-03:00',  // cuándo se cerró el ticket
//     monto:      28400.50,            // total del ticket, en pesos
//     items:      4,                   // opcional
//     medio:      'tarjeta'            // opcional
//   }
//
// No valida nada: de eso se encarga el server, que es el único lugar donde
// conviene tener las reglas (importes finitos, fechas parseables, local que
// exista). El adaptador sólo traduce.
// ---------------------------------------------------------------------------

const unArray = x => (Array.isArray(x) ? x : [x]);

const ADAPTADORES = {

  // Nuestro propio formato. Es el que le pasamos al proveedor si nos deja
  // elegir, y el que usa el simulador. Acepta una venta suelta, un array, o
  // un objeto { ventas: [...] }.
  generico(cuerpo) {
    const lista = Array.isArray(cuerpo) ? cuerpo : unArray(cuerpo.ventas || cuerpo);
    return lista.map(v => ({
      externo_id: v.externo_id ?? v.id ?? v.ticket ?? null,
      local: v.local ?? v.local_id ?? v.sucursal ?? null,
      ts: v.ts ?? v.fecha ?? v.timestamp ?? null,
      monto: v.monto ?? v.total ?? null,
      items: v.items ?? v.cantidad ?? null,
      medio: v.medio ?? v.medio_pago ?? null,
    }));
  },

  // ── Plantilla para el proveedor real ───────────────────────────────────
  // Cuando tengamos un payload de ejemplo, se copia este bloque, se le pone
  // el nombre del proveedor y se completan los campos. Después se setea
  // POS_ADAPTADOR con ese nombre y listo.
  //
  // miPos(cuerpo) {
  //   return unArray(cuerpo.data).map(v => ({
  //     externo_id: String(v.invoice_number),
  //     local: v.store_code,                       // mapear con locales.pos_id
  //     ts: v.closed_at,                           // ojo con la zona horaria
  //     monto: Number(v.grand_total),              // ¿viene en centavos?
  //     items: v.line_items ? v.line_items.length : null,
  //     medio: v.payment_method,
  //   }));
  // },
};

function adaptar(nombre, cuerpo) {
  const fn = ADAPTADORES[nombre];
  if (!fn) throw new Error(`No existe el adaptador "${nombre}"`);
  const salida = fn(cuerpo);
  if (!Array.isArray(salida)) throw new Error(`El adaptador "${nombre}" no devolvió un array`);
  return salida;
}

module.exports = { ADAPTADORES, adaptar };
