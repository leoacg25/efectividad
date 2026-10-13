# Dashboard de Efectividad

Aplicación web para medir y gestionar la efectividad de un equipo de programadores a partir de tickets de trabajo. Se carga una planilla Excel, se actualizan estados y notas, y el dashboard calcula métricas, ranking y reportes. Los datos se sincronizan entre equipos con Firebase.

El nombre interno de la interfaz es **EffectiveDev**.

## Qué permite hacer

- Iniciar sesión con correo y contraseña (Firebase Auth).
- Importar tickets desde Excel: una hoja por programador.
- Ver el dashboard con KPIs, gráfica de barras, gráfica circular y ranking.
- Abrir la ficha de cada programador para editar tickets, notas y estado.
- Crear programadores, agregar tickets a mano y transferirlos entre personas.
- Asignar perfiles especiales (**Líder Técnico** y **Evaluación**). Esos perfiles muestran el promedio del equipo, no su propia efectividad.
- Guardar una planificación evaluada, consultar periodos anteriores y abrir una planificación nueva desde una plantilla.
- Exportar CSV, PDF, Excel y un respaldo JSON. Importar Excel o JSON.
- Llevar un seguimiento aparte en **Pos Web** (mejoras y fallas), sincronizado entre equipos.
- Compartir la ficha de un programador en solo lectura con `?compartir=Nombre`.

## Cómo se calcula la efectividad

```
efectividad = solventados / (total − no aplica − información adicional) × 100
```

Los tickets en **No Aplica** e **Información Adicional** quedan fuera del denominador. Si no queda ningún ticket evaluable, el porcentaje es 0.

Umbrales visuales:

| Porcentaje | Color |
| --- | --- |
| 75 % o más | Verde |
| 40 % a 74 % | Amarillo |
| Menos de 40 % | Rojo |

Estados de un ticket: **Solventado**, **No Aplica**, **Información Adicional**, **En proceso**, **No resuelto**.

Tipos: **Mejora/requerimiento** y **Avería/Falla**.

## Formato del Excel

Cada hoja es un programador. El nombre de la hoja es el nombre de la persona.

Columnas requeridas:

| Columna | Uso |
| --- | --- |
| `N° Ticket` | Número del ticket |
| `Descripcion` | Descripción |
| `Proyecto` | Proyecto |
| `Notas` | Notas |

Columnas opcionales: `Tipo` y `Estado` (también se aceptan variantes como `Estatus` o `Status`).

Si el mismo número aparece más de una vez (los ceros a la izquierda no cuentan: `0001617` y `1617` son el mismo ticket), se conserva la fila con notas o con un estado distinto de **No resuelto**. Si ninguna tiene cambios, se conserva la última. La app avisa cuántos se omitieron.

Desde el dashboard se puede descargar `plantilla_efectividad.xlsx`. En la ficha de un programador, **Importar Excel** permite reemplazar o añadir tickets de esa persona.

## Cómo ejecutarla

No hay paso de compilación. Es HTML, CSS y JavaScript en el navegador.

```bash
python3 -m http.server 8080
```

Abre `http://localhost:8080`. Hace falta un usuario creado en Firebase Authentication del proyecto `efectividad`.

La vista compartida no pide login:

```
http://localhost:8080/?compartir=Nombre%20del%20programador
```

## Estructura

```
index.html          Pantallas: carga, login, dashboard, Pos Web y ficha
css/styles.css      Estilos
js/app.js           Arranque, navegación, importación y Pos Web
js/auth.js          Login y sesión
js/firebase-db.js   Sincronización con Firestore
js/parser.js        Lectura y validación del Excel
js/dashboard.js     KPIs, gráficas y ranking
js/tickets.js       Tabla de tickets de un programador
js/exporter.js      CSV, PDF y Excel
js/storage.js       Copia local (localStorage)
scripts/backup.mjs  Respaldo diario de Firestore
backups/            JSON generados por el respaldo
```

## Datos y sincronización

Firestore usa el esquema v2:

- Colección `programmers`: un documento por programador (`tickets` y `profile`).
- Documento `dashboard/meta`: periodo, fecha de carga, archivos y planificaciones.
- Documento `dashboard/posweb`: casos de Pos Web.

Cada escritura toca solo el documento que cambió, así un equipo no pisa los tickets de otro. Si todavía existe el documento antiguo `dashboard/data`, la app lo migra sola al esquema nuevo.

El navegador también guarda una copia en `localStorage`.

## Respaldo diario

El workflow `.github/workflows/backup.yml` corre todos los días a las 22:00 UTC (y se puede lanzar a mano). Lee Firestore con `scripts/backup.mjs` y commitea `backups/efectividad_AAAA-MM-DD.json`.

Requiere el secret `FIREBASE_SERVICE_ACCOUNT` (JSON de una cuenta de servicio con lectura en Firestore). Cuando hay 7 o más archivos, el script deja solo el más reciente.

Para ejecutarlo en local:

```bash
npm install firebase-admin
FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" node scripts/backup.mjs
```

## Dependencias (CDN)

SheetJS, Chart.js, jsPDF, jsPDF-AutoTable y Firebase JS SDK 12. No hay `package.json` de la app. `firebase-admin` solo se usa en el script de respaldo.
