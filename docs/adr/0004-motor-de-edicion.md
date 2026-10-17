# ADR 0004 · Motor de edición: CodeMirror 6 + Yjs, Markdown como fuente y sin HTML embebido

- **Estado:** aceptada (decisiones escritas al abrir el tramo 3). El motor y el "Markdown sin HTML embebido" ya estaban decididos por escrito (decisión A del bloque H1). Este ADR los formaliza y agrega cómo se aplican y cómo se prueban.
- **Fecha:** 2026-10-17
- **Relacionados:** [ADR 0003](0003-crdt.md) (Yjs), [ADR 0002](0002-comunicacion.md) (WebSocket), `presupuestos.json` del frontend.

## Contexto

Cuaderno es para **documentación técnica**: títulos, listas, bloques de código, tablas, fórmulas (KaTeX, bloque O, a decidir), y un historial con **diff por líneas** (bloque N). Además:

- presupuesto del rol **editor: 210 KiB gzip**; hoy el rol pesa 27,4 KiB;
- presupuesto del rol **lector: 140 KiB**: un lector no debería descargar el editor;
- tope por chunk: 160 KiB;
- accesibilidad WCAG 2.1 AA, incluido el uso solo con teclado;
- contenido que escriben otras personas: **riesgo de XSS** al mostrarlo.

## Medición (KiB con gzip nivel 9, build aislado con Vite 8.3.1)

| Opción | Al abrir | Qué incluye |
|---|---|---|
| **CodeMirror 6 + Markdown sin HTML + Yjs** | **153,3** | `basicSetup`, `markdownLanguage`, Yjs, `y-codemirror.next` y presencia (medido en H1) |
| CodeMirror 6 + Markdown **con** HTML (solo el editor, sin Yjs) | 157,0 | el soporte de HTML embebido trae los analizadores de HTML, CSS y JavaScript |
| CodeMirror 6 + Markdown sin HTML (solo el editor, sin Yjs) | 85,4 | |
| ProseMirror + Yjs (esquema básico, sin Markdown) | 89,9 | `prosemirror-*`, `y-prosemirror` 1.3.7, presencia y deshacer propio |
| ProseMirror + Markdown + Yjs | 138,4 | más `prosemirror-markdown` 1.13.8 (markdown-it) para importar y exportar |
| Monaco 0.57.0, solo el núcleo | 668,9 + 13,8 de CSS | **cota inferior**: sin workers de lenguajes ni enlace con Yjs |

**Corrijo lo que dije al planear el proyecto** ("ProseMirror es más pesado"): con lo mínimo, ProseMirror pesa **menos**, y con Markdown pesa 15 KiB menos que CodeMirror. **El peso no decide** entre los dos. Los dos caben en el tope del editor; Monaco no.

## Decisión

**CodeMirror 6 + `y-codemirror.next`, con el Markdown como única fuente del documento (`Y.Text` `contenido`) y sin HTML embebido.**

### Por qué CodeMirror y no ProseMirror, si pesa parecido

1. **El Markdown es la fuente, literalmente.** En CodeMirror lo que se edita y lo que se sincroniza es el texto Markdown tal cual. En ProseMirror se edita un **árbol** (`Y.XmlFragment`) y el Markdown se **genera** al exportar. Eso tiene dos problemas:
   - no conserva el texto escrito: normaliza marcas (`*` → `_`), numeración de listas y espacios;
   - pierde lo que el esquema no conoce: con el esquema por defecto, **las tablas** (GFM), las notas al pie y las definiciones de enlaces. Las tablas son del bloque O.
2. **El diff por líneas (N) sale natural**: las versiones guardan el mismo texto que la persona escribió (`versiones.contenido_texto`). Con ProseMirror, una normalización del serializador aparecería como cambios que nadie hizo.
3. **Código**: CodeMirror es un editor de código. Resaltado, indentación y lenguajes por bloque (diferidos y ya medidos) son nativos.
4. **La IA (tramo 4)** trabaja sobre texto plano con posiciones de texto: el autocompletado y "mejorar la selección" encajan con un `Y.Text`.

### Sin HTML embebido, en tres capas

1. **Editor:** `markdownLanguage`, sin el soporte de HTML: no se descargan sus analizadores (unos 72 KiB menos, medidos).
2. **Vista renderizada** (bloque O): el HTML escrito dentro del Markdown se muestra **como texto literal** (escapado), nunca como etiquetas. No se borra en silencio: quien lo escribió ve que no se interpreta.
3. **Saneamiento** del HTML generado por lista blanca de etiquetas y atributos (O). Va además de la CSP sin scripts en línea. Es una segunda línea, por si el renderizador tiene un error.

### Quién descarga qué

- **Editor** (`#/documentos/:id/editar`, grupo editor): CodeMirror + Yjs + `y-codemirror.next`, más la vista renderizada.
- **Lector** (grupo lector): **sin CodeMirror**. Solo Yjs (18,7 KiB) para recibir los cambios en vivo y el renderizador. Así queda dentro de su tope de 140 KiB.
  - Un lector no tiene cursor en el texto, pero aparece en la presencia ("quién está").
  - Aunque el cliente se manipule, el servidor descarta lo que mande (ADR 0002).
- El lenguaje de cada bloque de código y el resaltado se cargan **bajo demanda** (diferidas `lenguaje` 35 y `highlight` 60, ya activadas).

### Detalles que este ADR fija

- **Deshacer solo lo propio**: el historial lo lleva el `Y.UndoManager` de `yCollab`. **No** se usa el `history()` de CodeMirror (con los dos, Ctrl+Z desharía cambios ajenos o se desincronizaría). Como `basicSetup` lo incluye, la configuración se arma con sus piezas, sin `history()` ni `historyKeymap`. La medición de 153,3 KiB usó `basicSetup` completo, así que es una cota superior.
- **Teclado sin trampa (WCAG 2.1.2)**: **Tab** no se captura para indentar. Se sale del editor con Tab, como de cualquier campo. Indentar es con `Ctrl+]` y `Ctrl+[`, y eso se documenta en la ayuda del editor.
- **Nombre accesible** del área de edición (`aria-label` con el título del documento). Los cursores remotos llevan el nombre de la persona como texto, no solo el color.
- **Colores de los cursores remotos (bloque L)**: son un **significado de color nuevo**. Antes de L se proponen con su significado, sus usos y sus contrastes medidos en los dos temas, **y se espera tu respuesta**, como pide la regla de color. Ninguno será violeta (reservado para la IA).

## Alternativas

| Alternativa | A favor | En contra |
|---|---|---|
| **ProseMirror / TipTap + `y-prosemirror`** (texto enriquecido) | Más parecido a Google Docs; muy buena accesibilidad semántica (títulos y listas reales); pesa parecido (89,9 o 138,4 KiB) | La fuente sería un árbol, no el Markdown: normaliza y pierde lo que el esquema no conoce (tablas por defecto). El diff por líneas mostraría cambios que nadie hizo. El código es un nodo más, sin las herramientas de un editor de código. |
| **Monaco** | El editor de VS Code; excelente para código | **668,9 KiB** solo el núcleo, sin colaboración ni lenguajes: pasa el tope del editor (210) y el del chunk (160). Pensado para escritorio. |
| **`<textarea>` propio** | Cero dependencias | Sin resaltado, sin cursores remotos dentro del texto y sin enlace con el CRDT: habría que escribirlo todo. |
| **Markdown con HTML embebido** | Más expresivo | Decidido que no (H1): +72 KiB y la superficie de XSS más grande del proyecto. |

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Para quien usa lector de pantalla, editar Markdown significa oír los símbolos (`#`, `**`) | La vista renderizada es accesible; los lectores reciben solo la vista renderizada; la ayuda del editor explica la sintaxis mínima. Se prueba con axe y con teclado. Con un lector de pantalla real: **no medido** hasta L. |
| IME y teclados de móvil (composición) con Yjs | CodeMirror maneja la composición. En móvil: **no medido** hasta L (se declara). |
| El editor (153,3 KiB) queda cerca del tope por chunk (160) | Vite lo separa en chunks por módulo; el presupuesto por chunk se mide en cada bloque y, si se acerca, se divide CodeMirror y Yjs en chunks propios. |
| Una versión nueva de CodeMirror rompe el enlace con Yjs | Versiones exactas, con al menos 14 días de publicadas; el enlace se prueba con dos personas escribiendo a la vez (L). |
| El renderizador interpreta algo como HTML | Escape del HTML en el renderizador, lista blanca y CSP, con una batería de cargas XSS (O). |
| Tablas y fórmulas en el editor de texto | En el texto son Markdown; se ven en la vista renderizada (O). KaTeX se decide en O con su medición, como quedó escrito. |

## Cómo se prueba

| Qué | Prueba |
|---|---|
| Dos personas escribiendo a la vez | E2E con dos contextos de Playwright en el mismo documento: los dos terminan con el mismo texto, y cada cursor remoto con su nombre (L). |
| Deshacer solo lo propio | E2E: A y B escriben; A presiona Ctrl+Z y solo se deshace lo de A. |
| Sin trampa de teclado | E2E: Tab entra y sale del editor; `Ctrl+]` indenta. |
| Accesibilidad | axe en los dos temas con el editor abierto y con cursores remotos visibles. |
| Peso | `npm run presupuestos` en cada bloque; una prueba sobre el manifiesto comprueba que el rol lector **no** incluye CodeMirror. |
| Sin HTML embebido | Batería de cargas XSS escritas en el Markdown (`<script>`, `<img onerror>`, `javascript:`, SVG, `<iframe>`…): se muestran como texto y el DOM no tiene ninguna de esas etiquetas (O). Mutación que activa el HTML → falla. |
| El Markdown se conserva | Lo que se escribe es lo que se guarda: misma cadena exacta en `versiones.contenido_texto` (N). |

## Decisiones tomadas (por escrito, 2026-10-17)

1. **Los lectores no descargan CodeMirror**: solo Yjs y el renderizador.
2. **Tab sale del editor; `Ctrl+]` y `Ctrl+[` indentan.** Se anuncia en la **ayuda del editor**, visible y alcanzable con el teclado.
3. **Colores de los cursores, en el bloque L:**
   - sin violeta;
   - una paleta de **al menos 6 colores** con contraste medido en los dos temas;
   - **el nombre siempre visible** junto al cursor: el color nunca es el único medio.
   
   Se proponen con su significado, sus usos y sus contrastes antes de aplicarlos, y se espera la respuesta.
