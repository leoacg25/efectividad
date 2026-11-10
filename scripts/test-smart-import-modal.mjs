/**
 * test-smart-import-modal.mjs — Pruebas del modal de previsualización
 * ==================================================================
 * Simula un DOM mínimo para verificar el cableado de la UI de carga
 * inteligente: render inicial, cambio de mapeo de columnas, toggle de
 * despacho, confirmación, cancelación y pestañas multi-hoja.
 *
 * Uso:
 *   node scripts/test-smart-import-modal.mjs [ruta-de-un-xlsx-de-ejemplo]
 *
 * Requiere xlsx.full.min.js (SheetJS) junto al script o en la carpeta que
 * indique la variable XLSX_PATH.
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

// --- DOM stub mínimo ---
const elements = {};
function makeEl(id) {
  return {
    id, _listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    innerHTML: '', textContent: '', disabled: false, dataset: {},
    addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); },
    fire(type, event) { [...(this._listeners[type] || [])].forEach(fn => fn(event)); },
    closest() { return null; }, appendChild() {},
  };
}
globalThis.document = {
  getElementById: (id) => (elements[id] ??= makeEl(id)),
  createElement: () => makeEl('tmp'),
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll: () => [],
  head: { appendChild() {} },
};

// --- Cargar librerías ---
const runScript = (file) => vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
runScript(XLSX_PATH);
runScript(path.join(REPO, 'js/parser.js'));
runScript(path.join(REPO, 'js/smart-import.js'));

let failures = 0, passes = 0;
function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`); }
}

const body = document.getElementById('smart-import-body');
const confirmBtn = document.getElementById('smart-import-confirm');
const cancelBtn = document.getElementById('smart-import-cancel');
const summaryEl = document.getElementById('smart-import-summary');
const fileEl = document.getElementById('smart-import-file');

function fakeFile(name, buf) {
  return { name, size: buf.length, arrayBuffer: async () => buf };
}
const tick = () => new Promise(r => setTimeout(r, 150));

// =====================================================================
console.log('\n[A] Modal con archivo real (si se provee uno)');
// =====================================================================
const examplePath = process.argv[2];

if (examplePath && fs.existsSync(examplePath)) {
  const buf = fs.readFileSync(examplePath);
  const pending = SmartImport.open(fakeFile(path.basename(examplePath), buf));
  await tick();

  check('cabecera del modal muestra archivo y formato', /XLSX/i.test(fileEl.textContent), fileEl.textContent);

  let html = body.innerHTML;
  check('mapeo con selectores por columna', /name="smart-col-\d+"/.test(html));
  check('toggle despacho presente', /name="smart-despacho"/.test(html));
  check('botón confirmar con conteo', /\d+/.test(confirmBtn.textContent), confirmBtn.textContent);
  check('resumen del pie presente', summaryEl.textContent.length > 0, summaryEl.textContent);

  // Remapear la columna de ticket → Ignorar
  const selectBlocks = (h) => [...h.matchAll(/name="smart-col-(\d+)">([\s\S]*?)<\/select>/g)];
  const ticketCol = selectBlocks(html).find(m => m[2].includes('<option value="ticket" selected>'));
  if (ticketCol) {
    body.fire('change', { target: { name: `smart-col-${ticketCol[1]}`, value: '' } });
    check('remapear ticket → Ignorar actualiza la tabla',
      !selectBlocks(body.innerHTML).some(m => m[2].includes('<option value="ticket" selected>')));
  } else {
    check('remapear ticket → Ignorar actualiza la tabla', false, 'no había columna de ticket mapeada');
  }

  confirmBtn.fire('click');
  const data = await pending;
  check('confirmación resuelve con datos', !!data && Object.keys(data.programmers).length > 0,
    JSON.stringify(Object.keys(data?.programmers || {})));
  check('tickets con forma correcta',
    Object.values(data?.programmers || {}).every(list => list.every(t =>
      t.id && 'ticket' in t && 'description' in t && 'status' in t && 'tipo' in t)));
} else {
  console.log('  (omitido: pasa un archivo .xlsx como argumento para probar contra un caso real)');
}

// =====================================================================
console.log('\n[B] Cancelar el modal');
// =====================================================================
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['# Mantis', 'Estatus', 'Actividad'],
    ['1654', 'Solventado', 'Tarea única'],
  ]), 'Hoja 1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const pending = SmartImport.open(fakeFile('uno.xlsx', buf));
  await tick();
  cancelBtn.fire('click');
  const data = await pending;
  check('cancelación resuelve null', data === null);
}

// =====================================================================
console.log('\n[C] Archivo multi-hoja (pestañas y cambio de hoja activa)');
// =====================================================================
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['N° Ticket', 'Descripción', 'Proyecto', 'Notas', 'Estado'],
    ['10', 'Tarea de Ana 1', 'POS', '', 'Solventado'],
    ['11', 'Tarea de Ana 2', 'POS', '', 'En proceso'],
  ]), 'Ana');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['# Mantis', 'Estatus', 'Actividad'],
    ['20', 'Solventado', 'Tarea de Luis'],
  ]), 'Luis');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const pending = SmartImport.open(fakeFile('dos-hojas.xlsx', buf));
  await tick();

  let html = body.innerHTML;
  check('pestañas de 2 hojas', (html.match(/data-sheet-idx=/g) || []).length === 2);
  check('pestaña activa = Ana (con 2 tickets)',
    /smart-import__tab--active[^>]*data-sheet-idx="0"[\s\S]*?<span class="smart-import__tab-count">2</.test(html));

  body.fire('click', { target: { closest: () => ({ dataset: { sheetIdx: '1' } }) } });
  html = body.innerHTML;
  check('cambio de pestaña a Luis', /Tarea de Luis/.test(html));
  check('input de programador = Luis', /name="smart-dev" value="Luis"/.test(html));

  confirmBtn.fire('click');
  const data = await pending;
  check('confirmación multi-hoja: Ana (2) + Luis (1)',
    data?.programmers?.['Ana']?.length === 2 && data?.programmers?.['Luis']?.length === 1,
    JSON.stringify(Object.entries(data?.programmers || {}).map(([k, v]) => [k, v.length])));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Resultado modal: ${passes} pruebas OK, ${failures} fallas`);
process.exit(failures > 0 ? 1 : 0);
