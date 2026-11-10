/**
 * test-smart-import.mjs — Pruebas de la lógica de carga inteligente
 * =================================================================
 * Ejecuta la detección (encabezado, columnas, desarrollador, extracción
 * de tickets) contra el archivo de ejemplo real, el formato clásico de
 * la app, CSV, PDF (sintético) y DOCX (sintético).
 *
 * Uso:
 *   node scripts/test-smart-import.mjs [ruta-de-un-xlsx-de-ejemplo]
 *
 * Requiere xlsx.full.min.js (SheetJS) junto al script o en la carpeta que
 * indique la variable XLSX_PATH. Descarga:
 *   https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import process from 'node:process';

const DIR = path.dirname(process.argv[1] || import.meta.url.replace('file:///', ''));
const REPO = path.resolve(DIR, '..');
const XLSX_PATH = process.env.XLSX_PATH || path.join(DIR, 'xlsx.full.min.js');

if (!fs.existsSync(XLSX_PATH)) {
  console.error(`Falta SheetJS (${XLSX_PATH}). Descárgalo del CDN o define XLSX_PATH.`);
  process.exit(2);
}

// --- Cargar librerías como <script> del navegador (comparten scope léxico global) ---
const runScript = (file) => vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
runScript(XLSX_PATH);                                    // global XLSX
runScript(path.join(REPO, 'js/parser.js'));               // const Parser
runScript(path.join(REPO, 'js/smart-import.js'));         // const SmartImport

const SI = SmartImport._internal;

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Reproduce la detección que hace SmartImport.read() sobre un grid. */
function detectSheet(grid, sheetName, fileName, despacho = true) {
  const headerRow = SI.detectHeaderRow(grid);
  const { map, headers } = SI.mapColumns(grid, headerRow);
  const sheet = {
    name: sheetName, grid, headerRow, headers, map,
    developer: SI.detectDeveloper(grid, headerRow, sheetName, fileName),
    despacho,
  };
  const res = SI.buildTickets(sheet);
  sheet.tickets = res.tickets;
  sheet.despachoCount = res.despachoCount;
  sheet.duplicatesRemoved = res.duplicatesRemoved;
  return sheet;
}

// =====================================================================
console.log('\n[1] Archivo de ejemplo real');
// =====================================================================
const examplePath = process.argv[2];

if (examplePath && fs.existsSync(examplePath)) {
  const buf = fs.readFileSync(examplePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const grids = SI.workbookToGrids(wb);
  check('workbook leído', grids.length >= 1, `grids=${grids.length}`);
  const g = grids[0];

  const headerRow = SI.detectHeaderRow(g.grid);
  check('fila de encabezado detectada', headerRow >= 0, `idx=${headerRow}`);

  const { map } = SI.mapColumns(g.grid, headerRow);
  check('columna de ticket mapeada', map.ticket !== undefined, JSON.stringify(map));
  check('columna de descripción mapeada', map.description !== undefined, JSON.stringify(map));

  const sheet = detectSheet(g.grid, g.name, 'ejemplo.xlsx');
  check('tickets extraídos', sheet.tickets.length > 0, `len=${sheet.tickets.length}`);
  check('despachos asignados', sheet.despachoCount >= 0, `n=${sheet.despachoCount}`);
  const withDespacho = sheet.tickets.filter(t => /^Despacho \d+$/.test(t.ticket));
  check('numeración consecutiva de despachos',
    withDespacho.length === sheet.despachoCount &&
    withDespacho.every((t, i) => t.ticket === `Despacho ${i + 1}`));
} else {
  console.log('  (omitido: pasa un archivo .xlsx como argumento para probar contra un caso real)');
}

// =====================================================================
console.log('\n[2] Formato clásico de la app (compatibilidad hacia atrás)');
// =====================================================================
{
  const grid = [
    ['N° Ticket', 'Descripcion', 'Proyecto', 'Tipo', 'Notas', 'Estado'],
    ['001', 'Error en login', 'POS', 'Avería', '', 'Solventado'],
    ['002', 'Agregar reporte', 'POS', 'Mejora', 'urgente', 'En proceso'],
    ['003', 'Ajuste de menú', 'Despacho', '', '', ''],
  ];
  const sheet = detectSheet(grid, 'Pedro Pérez', 'plantilla.xlsx');
  check('encabezado en fila 1', sheet.headerRow === 0, `idx=${sheet.headerRow}`);
  check('mapeo completo', sheet.map.ticket === 0 && sheet.map.description === 1 &&
    sheet.map.project === 2 && sheet.map.tipo === 3 && sheet.map.notes === 4 && sheet.map.status === 5,
    JSON.stringify(sheet.map));
  check('desarrollador = nombre de hoja', sheet.developer === 'Pedro Pérez', sheet.developer);
  check('3 tickets', sheet.tickets.length === 3, `len=${sheet.tickets.length}`);
  check('estado En proceso', sheet.tickets[1].status === 'En proceso');
  check('estado vacío → No resuelto', sheet.tickets[2].status === 'No resuelto');
}

// =====================================================================
console.log('\n[3] Formato "Planificación" (encabezado en fila 4, # Mantis, Realizado)');
// =====================================================================
{
  const grid = [
    ['PLANIFICACIÓN DE DESARROLLO - RESUMEN DE TAREAS', '', '', '', '', ''],
    ['Desarrollador: Jezer Díaz', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['N°', '# Mantis', 'Estatus', 'Actividad / Descripción', 'Realizado', 'Observación / Referencia'],
    ['1', '1654', 'Solventado', 'Pin 48523 - NO EXISTE TABLA / VISTA', 'Sí', 'Ver Ticket'],
    ['2', '-', 'Solventado', 'Mostrar Empacado en el menú', 'Sí', 'despacho'],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Si alguno de los cambios no se refleja correctamente por favor avísame para gestionar la resubida del ajuste al servidor. En ocasiones la actualización puede verse afectada por inconvenientes con Git o eventualidades técnicas durante el despliegue.', '', '', '', '', ''],
  ];
  const sheet = detectSheet(grid, 'Planificación de Tareas', 'planificacion.xlsx');
  check('encabezado en fila 4', sheet.headerRow === 3, `idx=${sheet.headerRow}`);
  check('ticket = # Mantis', sheet.map.ticket === 1, JSON.stringify(sheet.map));
  check('Realizado ignorado', !Object.values(sheet.map).includes(4));
  check('desarrollador = Jezer Díaz', sheet.developer === 'Jezer Díaz', sheet.developer);
  check('2 tickets', sheet.tickets.length === 2, `len=${sheet.tickets.length}`);
  check('despacho 1 para fila sin ticket', sheet.tickets[1].ticket === 'Despacho 1', sheet.tickets[1].ticket);
  check('nota al pie excluida', !sheet.tickets.some(t => /Si alguno de los cambios/.test(t.description)));
}

// =====================================================================
console.log('\n[4] CSV con punto y coma y tildes');
// =====================================================================
{
  const csv = '# Mantis;Estatus;Actividad / Descripción;Observación\n1654;Solventado;Corregir validación;Ver Ticket\n-;Solventado;Ajuste de menú;despacho\n';
  const wb = XLSX.read(csv, { type: 'string', raw: false });
  const grids = SI.workbookToGrids(wb);
  const sheet = detectSheet(grids[0].grid, grids[0].name, 'reporte.csv');
  check('mapeo csv', sheet.map.ticket === 0 && sheet.map.status === 1 && sheet.map.description === 2 && sheet.map.notes === 3, JSON.stringify(sheet.map));
  check('2 tickets', sheet.tickets.length === 2, `len=${sheet.tickets.length}`);
  check('despacho asignado', sheet.tickets[1].ticket === 'Despacho 1', sheet.tickets[1].ticket);
}

// =====================================================================
console.log('\n[5] PDF: reconstrucción de tabla desde ítems de texto');
// =====================================================================
{
  const mk = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y], width: str.length * 5 });
  const items = [
    mk('PLANIFICACIÓN DE DESARROLLO', 60, 800),
    mk('Desarrollador: Jezer Díaz', 60, 780),
    mk('N°', 60, 740), mk('# Mantis', 110, 740), mk('Estatus', 200, 740), mk('Actividad / Descripción', 300, 740),
    mk('1', 60, 720), mk('1654', 110, 720), mk('Solventado', 200, 720), mk('Pin 48523 - NO EXISTE TABLA', 300, 720),
    mk('2', 60, 700), mk('2789', 110, 700), mk('Solventado', 200, 700), mk('El consecutivo de código de unidad', 300, 700),
    mk('debería ser general y no por departamento', 300, 690),
    mk('3', 60, 670), mk('-', 110, 670), mk('Solventado', 200, 670), mk('Ajuste de menú', 300, 670),
    mk('Si alguno de los cambios no se refleja correctamente, por favor avísame para gestionar la resubida del ajuste al servidor.', 60, 620),
  ];
  const grid = SI.pdfItemsToGrid(items);
  const sheet = detectSheet(grid, 'pagina', 'reporte.pdf');
  check('3 tickets desde el PDF', sheet.tickets.length === 3, `len=${sheet.tickets.length}`);
  check('desarrollador desde el PDF', sheet.developer === 'Jezer Díaz', sheet.developer);
  const t2 = sheet.tickets.find(t => t.ticket === '2789');
  check('texto envuelto unido en una fila', !!t2 && /El consecutivo de código de unidad debería ser general/.test(t2.description));
  check('nota al pie excluida (PDF)', !sheet.tickets.some(t => /Si alguno de los cambios/.test(t.description)));
}

// =====================================================================
console.log('\n[6] DOCX: extracción de tablas desde el XML de Word');
// =====================================================================
{
  const xml = `<?xml version="1.0"?>
  <w:document xmlns:w="ns"><w:body>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>N°</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t># Mantis</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Estatus</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Actividad / Descripción</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1654</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Solventado</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Error &amp; validación</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body></w:document>`;
  const tbls = SI.extractBlocks(xml, 'w:tbl');
  const rows = SI.extractBlocks(tbls[0], 'w:tr');
  const cells = SI.extractBlocks(rows[1], 'w:tc').map(tc => SI.wordText(tc));
  check('celdas con texto plano y entidades decodificadas',
    JSON.stringify(cells) === JSON.stringify(['1', '1654', 'Solventado', 'Error & validación']), JSON.stringify(cells));
  const grid = [SI.extractBlocks(rows[0], 'w:tc').map(tc => SI.wordText(tc)), cells];
  const sheet = detectSheet(grid, 'Tabla 1', 'informe.docx');
  check('ticket docx', sheet.map.ticket === 1, JSON.stringify(sheet.map));
  check('1 ticket docx', sheet.tickets.length === 1 && sheet.tickets[0].ticket === '1654');
}

// =====================================================================
console.log('\n[7] Toggle Despacho apagado y deduplicación');
// =====================================================================
{
  const grid = [
    ['# Mantis', 'Estatus', 'Actividad'],
    ['1654', 'Solventado', 'Primera versión'],
    ['1654', 'Solventado', 'Versión final con nota'],
    ['-', 'Solventado', 'Tarea sin ticket A'],
    ['-', 'Solventado', 'Tarea sin ticket B'],
  ];
  const sheetOn = detectSheet(grid, 'Hoja 1', 'a.xlsx', true);
  check('deduplicación conserva la fila con más cambios',
    sheetOn.tickets.filter(t => t.ticket === '1654').length === 1 &&
    sheetOn.tickets.find(t => t.ticket === '1654').description === 'Versión final con nota');
  check('2 despachos con toggle ON', sheetOn.tickets.filter(t => t.ticket.startsWith('Despacho')).length === 2);
  check('1 duplicado eliminado', sheetOn.duplicatesRemoved === 1, `n=${sheetOn.duplicatesRemoved}`);

  const sheetOff = detectSheet(grid, 'Hoja 1', 'a.xlsx', false);
  check('con toggle OFF las filas sin ticket NO colapsan',
    sheetOff.tickets.filter(t => t.ticket === '').length === 2,
    JSON.stringify(sheetOff.tickets.map(t => t.ticket)));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Resultado: ${passes} pruebas OK, ${failures} fallas`);
process.exit(failures > 0 ? 1 : 0);
