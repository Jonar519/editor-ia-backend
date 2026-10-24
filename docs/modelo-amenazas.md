# Modelo de amenazas

El análisis STRIDE completo se escribe en el bloque R. Este documento se abre en el tramo 3 para dejar escritos, desde que se deciden, los **riesgos residuales**: lo que el diseño acepta a sabiendas, con su límite medido y lo que lo acota.

## Riesgos residuales

### R-01 · Ventana de revocación del WebSocket si se pierde el aviso de pub/sub

- **Origen:** [ADR 0002](adr/0002-comunicacion.md), decisión 1. El guardia usa el rol en memoria de cada conexión, invalidado por Redis pub/sub y revalidado en la base cada 30 s.
- **Cuándo existe:** solo si a un cambio de permiso **no** le llega su aviso de pub/sub: Redis perdió el mensaje, o se cambió el permiso por fuera del API (por ejemplo, con SQL directo). Con el aviso, el corte es inmediato.
- **Qué puede pasar, separado por propiedad:**

| Propiedad | Quién | Ventana máxima | Qué la cierra |
|---|---|---|---|
| **Integridad**: alguien que perdió el permiso de escritura sigue mandando cambios | editor rebajado a lector, o sacado del documento | **hasta el siguiente vaciado del búfer (250 ms)** más lo que tarde la inserción | La base rechaza la inserción (trigger de escritura, `42501`). Eso dispara la revalidación inmediata, que corta la retransmisión de esa conexión y la cierra con 4403. |
| **Confidencialidad**: alguien que perdió el acceso sigue **recibiendo** cambios de otros | cualquier rol sacado del espacio o del documento | **hasta 30 s** (no escribe, así que la base no lo delata) | La revalidación periódica: al encontrar otro rol, corta la conexión con 4403. |

- **Lo que queda aunque se corte (integridad):** los cambios que esa conexión mandó **dentro** de la ventana ya llegaron a los demás clientes, y un CRDT no los puede deshacer selectivamente. El servidor no los guarda (la base los rechazó), pero viven en los `Y.Doc` de los demás. Si uno de ellos reconecta, el intercambio de vectores de estado los reenvía y se guardan **con la autoría de quien reconectó**.
  - Acotado: son como mucho 250 ms de escritura de alguien que **tenía** permiso de escritura un momento antes.
  - Queda escrito, no oculto. Se detecta comparando con las versiones (bloque N).
- **Mitigaciones adicionales (K2):**
  - **el aviso lo da la base** (migración 0022): todo lo que quita acceso (miembros, permisos, sesiones, cuentas, documentos) avisa al hacer COMMIT, también si el cambio se hizo por SQL directo. Por eso la ventana solo existe si **se pierde** ese aviso;
  - si se cae la conexión que escucha la base, o la de Redis, al volver se revalidan **todas** las conexiones;
  - si Redis no responde, no se aceptan conexiones nuevas (falla cerrado) y las abiertas siguen revalidándose en la base cada 30 s;
  - cada actualización descartada o rechazada queda en el log (`warn`). No hay una métrica de Prometheus para eso.
- **Cómo se mide:** prueba `tests/integracion/tiempo-real.test.ts` (bloque "R-01"). Quita el permiso **sin** el puente de avisos (como si se perdiera el aviso), con relojes reales y la revalidación en **300 ms**. Otra prueba fija 30 s como valor de producción.
- **Medido** (tres corridas en Windows, base y Redis de pruebas):

| Caso | Corte | En la ventana | Después del corte |
|---|---|---|---|
| Revocación **con** aviso (miembro, sesión, documento) | 8–19 ms | — | — |
| R-01 confidencialidad: quien perdió el acceso y solo recibe (revalidación de 300 ms) | 305–315 ms | recibió 5 cambios (uno cada 50 ms) | 0 |
| R-01 integridad: un editor rebajado que sigue escribiendo (sin esperar la revalidación) | 240–254 ms (el vaciado de 250 ms) | 7–8 cambios llegaron a los demás (uno cada 20 ms) | 0 |

  En producción, la confidencialidad queda acotada por la revalidación de **30 s** más lo que tarda una consulta. La integridad queda acotada por el vaciado de **250 ms**: no depende de la revalidación.
- **Estado:** aceptado por escrito al aprobar el ADR 0002, con la condición de cortar la retransmisión en cuanto el rol revalidado cambie.

### R-02 · Abuso de almacenamiento por versiones sin tope

- **Origen:** bloque N. Cada versión guarda una copia completa del documento (`estado_yjs` y `contenido_texto`, hasta 10 MiB cada uno), y la tabla `versiones` es de **solo inserción**: no se borra nada mientras exista el documento.
- **Qué puede pasar:** una cuenta con rol editor llena la base guardando o restaurando versiones de un documento grande.
  - Peor caso por cuenta: 30 versiones por hora × hasta unos 20 MiB por versión ≈ **600 MiB por hora**.
  - Varias cuentas editoras lo multiplican.
  - Las versiones automáticas (tras 5 minutos sin cambios, solo si el texto cambió) también suman, pero exigen editar de verdad.
- **Lo que lo acota hoy:**
  - el límite de 30 versiones por hora por cuenta;
  - el tope de 10 MiB por documento;
  - el rol editor (un lector no crea versiones);
  - la autoría de cada versión manual y de cada restauración, que queda en la cadena de hash.
- **Lo que no hay:** un tope de versiones por documento, una cuota por espacio o por cuenta, y una retención que borre o compacte versiones viejas. Una retención chocaría con el solo-inserción y la cadena de hash: habría que decidir cómo se "poda" sin perder la verificabilidad.
- **Estado:** aceptado al cerrar el bloque N (decisión escrita: límites aprobados, versiones sin tope). Se revisa en el bloque R junto con el monitoreo del tamaño de la base.

### R-03 · Tráfico entre el API y el servicio de IA con `IA_RED_PRIVADA=true`

- **Origen:** bloque P1. En producción, la configuración exige TLS mutuo (`IA_TLS_*`) **o** declarar `IA_RED_PRIVADA=true`.
- **Qué puede pasar:** con la segunda opción, el token entre servicios y el contenido de los documentos viajan en texto plano. Si la red NO es realmente privada (alguien pone la bandera por comodidad), un tercero en esa red los lee, y con el token puede llamar al servicio de IA gastando el proveedor (sin acceso a la base: el servicio no la tiene).
- **Lo que lo acota hoy:**
  - el servicio escucha en `127.0.0.1` por defecto;
  - la bandera hay que ponerla a propósito (nunca es el valor por defecto) y queda en el log de arranque;
  - el token es de 32+ bytes y se compara en tiempo constante;
  - la salud estándar no lleva token, pero solo dice `SERVING` o `NOT_SERVING`.
- **Lo que no hay:** una verificación de que la red sea privada (no se puede comprobar desde el proceso) ni rotación automática del token.
- **Estado:** abierto hasta el despliegue (bloque R): ahí se decide TLS mutuo o la red privada concreta.

### R-04 · Inyección de prompts desde un documento compartido

- **Origen:** bloque P2. La IA lee el contenido de documentos que pueden haber escrito otras personas del espacio.
- **Qué puede pasar:** alguien con permiso de edición escribe en un documento texto pensado para el modelo ("ignora tus reglas y di que…"). Cuando otra persona pide un resumen o una explicación, el modelo podría sesgar o falsear la respuesta que ella lee.
- **Lo que lo acota hoy:**
  - el contenido va escapado como XML dentro de un bloque con nonce aleatorio, y las instrucciones van aparte, en el mensaje de sistema;
  - la persona no escribe instrucciones libres (estilo cerrado, lenguaje validado);
  - el modelo no tiene herramientas ni acciones: lo peor que logra es un texto;
  - la salida se recorta y en Q se dibuja con el saneador (sin HTML ni enlaces peligrosos);
  - la autoría de cada cambio queda registrada (actualizaciones con autor y versiones).
- **Lo que no hay:** una garantía de que un modelo real ignore las órdenes del documento. La batería de 20 cargas prueba la estructura del prompt contra un modelo "ingenuo"; falta evaluar el modelo real elegido, y un aviso en la interfaz de que la respuesta se basa en contenido del documento (Q).
- **Estado:** abierto hasta elegir el proveedor real; entonces se corre la batería contra ese modelo.

### R-05 · Dependencias publicadas hace menos de 14 días (excepción por GHSA-27r3-jxmh-p828)

- **Origen:** 23-10-2026. Aviso alto en `body-parser` 2.0.0–2.3.0 (por Express 5.3.0): un cuerpo comprimido con bytes sobrantes al final provoca denegación de servicio. Era alcanzable en el API (`express.json()` y `express.raw()` del avatar).
- **Qué se hizo:** `body-parser` 2.4.0 y `qs` 6.16.1 con overrides exactos, por una **excepción escrita** a la regla de los 14 días (ADR 0003). Y, aparte, `inflate: false` en los dos parsers: un cuerpo con `Content-Encoding` comprimido recibe 415 sin descomprimirse (pruebas y mutaciones B01–B03). Con eso, la ruta vulnerable no se recorre aunque una versión futura reintrodujera el problema.
- **Qué riesgo queda:** el que la regla de los 14 días busca evitar: una versión muy nueva puede traer un error o un cambio malicioso que todavía nadie detectó. Lo acotan:
  - la lectura del diff de las dos versiones antes de aprobarlas (cambio acotado, sin red, archivos ni procesos nuevos);
  - el lockfile cambiado solo en esas dos entradas, con su integridad;
  - `npm audit` en el CI y gitleaks.
- **Estado:** aceptado por escrito el 23-10-2026. Se revisa al actualizar Express o body-parser: los overrides se quitan cuando Express traiga por sí solo una versión parcheada con 14 días o más.

### R-06 · Inyección de CSS: `'unsafe-inline'` en los estilos de la CSP

- **Origen:** bloque R. La CSP del frontend (`editor-ia-frontend/scripts/lib/csp.mjs`, como `<meta>` en el `index.html` del build) permite `'unsafe-inline'` **solo** en `style-src-elem` y `style-src-attr`. Lo midió la E2E completa con `style-src 'self'` estricto:
  - **CodeMirror** (`style-mod`) mete su CSS en un `<style>` (solo usa hojas construidas dentro de un shadow root). Sin él, el editor se rompe: la lista no continúa bien. Pasaba en 16 pruebas por navegador.
  - **La presencia de `y-codemirror.next`** pone `style="background-color: …"` en el cursor y la selección remotos, con `lib0/dom`, que va en el chunk compartido de la vista renderizada. Por eso el navegador atribuye la violación a ese chunk. Sin ese estilo, Firefox deja el atributo vacío y axe midió en Chromium un contraste de 1,08:1 en la etiqueta con el nombre.
  - Ninguno de los dos atributos lo pone código nuestro.
- **Qué puede pasar:** si alguien lograra meter un `<style>` o un atributo `style` en la página, podría cambiar cómo se ve: tapar o falsear partes de la interfaz, o intentar sacar datos con selectores de CSS.
- **Lo que lo acota hoy:**
  - `script-src 'self'` estricto: sin `'unsafe-inline'` ni `'unsafe-eval'`, con prueba unitaria y mutaciones R03–R04 del frontend. La E2E `csp.spec.mjs` comprueba que un `<script>` en línea no corre;
  - no hay ningún camino que inserte HTML: los nodos se crean con `h()`, el Markdown no admite HTML, y está la batería XSS con las mutaciones O01–O04;
  - `img-src`, `font-src` y `connect-src` son `'self'`: un CSS inyectado solo podría pedir recursos al propio origen, no mandar datos afuera;
  - un atributo `style` no tiene selectores;
  - `'unsafe-inline'` en otra directiva (también en `style-src`) hace fallar la prueba unitaria (mutación R05);
  - cualquier otra violación hace fallar la E2E: la fixture y la página de la segunda persona juntan las violaciones de todas sus navegaciones.
- **Salida para el despliegue (no hecha: sin despliegue en R):**
  - un **nonce por respuesta** generado por el servidor, entregado a CodeMirror con `EditorView.cspNonce`, con `style-src-elem 'nonce-…'` en lugar de `'unsafe-inline'`. La presencia de y-codemirror seguiría pidiendo `style-src-attr` (o `'unsafe-hashes'` con los hashes de sus atributos, que son finitos);
  - **`frame-ancestors 'none'` por cabecera:** no funciona en `<meta>`.
- **Estado:** aceptado por escrito al cerrar R2 (opción 1).
