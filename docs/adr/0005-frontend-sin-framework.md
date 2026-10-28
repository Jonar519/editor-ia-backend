# ADR 0005 · Frontend en JavaScript sin framework, con Vite

- **Estado:** aceptada. Decidida al armar el proyecto, antes del tramo 2: el README general la nombra desde el principio. Este ADR la formaliza al cierre (R6) con lo que costó y lo que se midió.
- **Fecha:** 2026-10-27
- **Dónde está el código:** [editor-ia-frontend](https://github.com/Jonar519/editor-ia-frontend). El ADR vive aquí, con los demás, para que la numeración sea una sola.
- **Relacionados:** [ADR 0001](0001-sesion.md) (sesión en memoria), [ADR 0004](0004-motor-de-edicion.md) (CodeMirror y quién descarga qué), [ADR 0007](0007-sin-conexion.md) (trabajo sin conexión), riesgo R-06 del [modelo de amenazas](../modelo-amenazas.md).

## Contexto

**El motivo original no quedó escrito:** solo la decisión, en el README general. Los motivos de este apartado y de las alternativas se **reconstruyeron al cierre**, a partir de lo que el proyecto exigió después, y quedan para que la dueña o el dueño del proyecto los confirme o los corrija.

- La materia es *Programación orientada a la web*. Sin framework, el frontend muestra los mecanismos de la plataforma en lugar de esconderlos detrás de una librería:
  - el DOM y sus eventos;
  - el historial y el router;
  - Web Workers y Service Worker;
  - IndexedDB;
  - CSS con variables y temas;
  - accesibilidad.
- Hay **presupuestos de peso por rol** (KiB gzip, confirmados por escrito en H1 y después): primera carga 12, rol público 20, lector 140, editor 210, admin 225, 160 por chunk y 30 de CSS.
- La pieza más pesada, el editor colaborativo (CodeMirror + Yjs, ADR 0004), ya ocupa la mayor parte del tope del editor.
- El contenido lo escriben otras personas: el XSS es el riesgo principal de la interfaz.

## Decisión

**JavaScript moderno sin framework, empaquetado con Vite**, con estas piezas propias, cada una con sus pruebas y mutaciones:

| Pieza | Qué es | Dónde | Evidencia |
|---|---|---|---|
| **Router por hash** | Las rutas son `#/…`, cada una con su grupo de rol y su vista cargada con `import()`. Lo puro (resolver y decidir) está separado del DOM, para probarlo sin navegador. Al cambiar de vista, el foco va al `h1`. | `src/router.js`, `src/rutas.js` | front H18–H20, H43, H44, H62, H63 |
| **`h()` en lugar de `innerHTML`** | Los nodos se crean con `document.createElement`. El texto entra siempre como texto, y los atributos `on*` se rechazan. | `src/dom.js` | front H21; `tests/unitarias/dom.test.mjs` |
| **CSS con tokens y significados del color** | Primitivos `--paleta-*` y semánticos `--color-*`. Cada significado está registrado en `significados.json`, y una auditoría impone las reglas R1–R7 (contraste AA medido en los dos temas, el violeta reservado para la IA, una sola animación, respeto de `prefers-reduced-motion`). | `src/estilos/`, `scripts/colores.mjs`, `scripts/contraste.mjs` | front H01–H13, H22, H23, H40, H41, H61 |
| **Presupuestos medidos en el CI** | Del manifiesto de Vite: el JS por rol, por chunk, por diferida y por pantalla. | `presupuestos.json`, `scripts/presupuestos.mjs` | front H14–H17, H24, H25, H64 |
| **Cliente del API** | Access token solo en memoria, un solo refresco a la vez (promesa compartida y Web Locks entre pestañas), `Retry-After` y errores con códigos estables. | `src/api/cliente.js` | front H26–H34 |
| **Service Worker propio** | Caché del armazón y de `/assets`. `/api` nunca pasa por la caché; solo mismo origen y solo GET. | `src/sw/sw.js` | front H35–H39; E2E `sw.spec.mjs` |
| **Web Worker** | La comparación de versiones corre fuera del hilo principal. | `src/diff/trabajador.js` | E2E de versiones bajo la CSP con `worker-src 'self'` (front R06) |
| **Tipos sin TypeScript compilado** | JSDoc revisado por `tsc` con `checkJs` y `strict`. El navegador ejecuta el mismo archivo que se escribió. | `tsconfig.json` | paso `typecheck` del CI |
| **Vistas diferidas** | El editor, KaTeX, el resaltado y la IA se cargan bajo demanda. Quien lee no descarga CodeMirror. | `src/diferidas/` | front Q15–Q17; presupuestos |

**Dependencias de ejecución:** solo las del editor y el Markdown (CodeMirror, Yjs, `y-codemirror.next`, micromark/mdast con GFM y matemática, highlight.js y KaTeX) y dos fuentes. Ninguna de interfaz.

## Alternativas

| Alternativa | A favor | En contra |
|---|---|---|
| **React, Vue o Svelte** | Componentes, ecosistema, estado reactivo | Esconden justo lo que la materia quiere mostrar (el DOM, el router, los eventos). Suman su runtime a la primera carga y a cada rol. `dangerouslySetInnerHTML` o `v-html` siguen siendo una puerta al XSS que hay que vigilar igual. **No se midieron en este proyecto**: el peso no fue el motivo. |
| **Preact o Lit** (más livianos) | Poco peso; Lit usa Web Components estándar | El mismo argumento de la materia. Lit agrega su propia plantilla de HTML: otro lugar donde un texto podría terminar como marcado. |
| **TypeScript compilado** | Tipos más cómodos | Un paso de compilación más. Con JSDoc y `checkJs` se revisan igual, y el navegador ejecuta lo que se escribió. |
| **Router con History API** (`/ruta` sin `#`) | URL más limpia | El servidor tendría que devolver `index.html` en cada ruta. Con hash, el Service Worker y el despliegue estático son más simples. |

## Consecuencias

- **Más código propio que mantener:** router, `h()`, formularios, anuncios para lectores de pantalla y el cliente del API. Cada uno con sus pruebas, para compensar.
- **Sin reactividad:** cada vista redibuja lo suyo. El router evita redibujar cuando cambia la sesión pero no la vista (front H43, H44): eso salvó los códigos de respaldo, que se muestran una sola vez.
- **El peso queda casi todo para lo que aporta valor.** La primera carga es de 7,09 KiB contra un tope de 12. El rol editor, de 203,54 contra 210: casi todo es el editor colaborativo.
- **La CSP puede ser estricta en scripts** (`script-src 'self'`, sin `'unsafe-inline'` ni `'unsafe-eval'`), porque no hay plantillas que evaluar. En estilos no: CodeMirror y `y-codemirror.next` insertan CSS en línea (riesgo R-06).

## Estado de verificación al cierre (R6)

**Medido** el 27-10-2026, con `npm run build` y `npm run presupuestos` sobre main del frontend (c054a3e), en KiB gzip:

| Medida | Valor | Tope |
|---|---|---|
| JS de primera carga | 7,09 | 12 |
| JS del rol público | 16,98 | 20 |
| JS del rol lector | 88,92 | 140 |
| JS del rol editor | 203,54 | 210 |
| JS del rol admin | 205,73 | 225 |
| Chunk más grande (KaTeX) | 74,94 | 160 |
| CSS total | 9,09 | 30 |

**Verificado:**
- las piezas de la tabla de «Decisión», con las mutaciones citadas;
- la accesibilidad (axe en cada pantalla, en Chromium y Firefox, en los dos temas, también con el editor y los cursores remotos).

Todo corre en el CI del frontend.

**No verificado** (lista de revisión del bloque R, `docs/revision-bloque-R.md` del frontend):
- Safari;
- un lector de pantalla real;
- los teclados de móvil.

**Indirecto:** que el rol lector no traiga CodeMirror lo asegura el tope de 140 KiB (CodeMirror solo ya pesa 85,4). La prueba directa existe solo para el panel de IA (front Q17).
