# ADR 0007 · Trabajo sin conexión: el CRDT en el navegador, copia local en IndexedDB y un Service Worker que nunca cachea el API

- **Estado:** aceptada. Implementada en el bloque M (y el Service Worker en H2); este ADR la formaliza al cierre (R6).
- **Fecha:** 2026-10-27
- **Dónde está el código:** [editor-ia-frontend](https://github.com/Jonar519/editor-ia-frontend): `src/tiempo-real/`, `src/sw/sw.js`. Del lado del servidor: [ADR 0003](0003-crdt.md).
- **Relacionados:** [ADR 0002](0002-comunicacion.md) (WebSocket, códigos de cierre), [ADR 0003](0003-crdt.md) (Yjs y persistencia), [ADR 0005](0005-frontend-sin-framework.md) (frontend), [ADR 0001](0001-sesion.md) (nada de la sesión en el almacenamiento del navegador).

## Contexto

- **Quien edita puede perder la red un rato** (wifi, tren, suspensión del equipo) y tiene que poder seguir escribiendo. Al volver, nadie pierde lo suyo y nada llega dos veces.
- **El access token vive solo en memoria** (ADR 0001): nada de la sesión en `localStorage`, `sessionStorage` ni en cookies legibles por JS.
- **Un equipo puede ser compartido.** Lo que queda guardado en el navegador tiene que ser lo mínimo y borrarse cuando ya no corresponde.

## Decisión

### Qué funciona sin conexión

| Funciona | No funciona (necesita el API) |
|---|---|
| Abrir la aplicación ya visitada: armazón y `/assets` desde el Service Worker | Iniciar sesión, refrescar el token o crear la cuenta |
| Seguir escribiendo en un documento **ya abierto en el editor** | Abrir un documento que no se tenía abierto |
| Cerrar la página y volver a abrirla: lo escrito sigue en la copia local y se envía al volver | Versiones, comentarios, permisos, IA y búsqueda |

Un pedido al API sin red falla con el código estable `red` (front H34), y la vista lo dice. No se encola en el navegador.

### Cómo

1. **El CRDT ya es la cola.** El `Y.Doc` del navegador guarda todo lo escrito. Al reconectar:
   - el servidor manda su vector de estado (paso 1);
   - el cliente responde con **todo lo que el servidor no tiene** (paso 2).

   Yjs identifica cada cambio por (cliente, reloj): reenviar algo que el servidor ya tiene no lo duplica, y lo que llega desordenado espera a sus dependencias.
2. **Copia local en IndexedDB** (`cuaderno-local`, `src/tiempo-real/almacen-local.js`):
   - cada actualización se guarda;
   - cada 100 filas se juntan en una;
   - al abrir, el documento arranca con la copia **antes** de conectar.
3. **Privacidad de la copia local:**
   - solo el **editor** guarda: quien solo lee no tiene nada propio que conservar;
   - una sola base, **de una cuenta**: si entra otra cuenta en ese navegador, se vacía antes de guardar nada suyo;
   - se borra entera al **cerrar la sesión**, al **eliminar la cuenta** y al **restablecer la contraseña**;
   - la copia de un documento se borra cuando se pierde el acceso, cuando el documento se elimina o cuando el servidor rechaza los cambios;
   - nunca guarda tokens ni datos de la cuenta: solo el id de la cuenta dueña y las actualizaciones.

   **IndexedDB solo en dos archivos,** que no importan la sesión ni el cliente del API.
4. **Avisar antes de perder algo:**
   - al salir con cambios sin enviar, la interfaz dice cuántos y deja cancelar;
   - si IndexedDB no está disponible (modo privado, cuota llena), el editor sigue en memoria y lo dice: lo escrito sin conexión se perdería al cerrar.
5. **Reconexión según el código de cierre** (ADR 0002):
   - **4401:** refresca el token una vez;
   - **4403:** pide un ticket nuevo; si ya no hay acceso, el ticket da 404;
   - **4404, 4400 y 4413:** no reintenta;
   - **el resto:** reintenta con espera exponencial y algo de azar, y en cuanto vuelve la red.
6. **Service Worker** (`src/sw/sw.js`):
   - `/api` **nunca** pasa por la caché;
   - solo mismo origen y solo GET;
   - la caché de `/assets` ignora `Vary`, porque si no, la app no abre sin red;
   - precarga solo el armazón y las vistas públicas.

## Alternativas

Se escriben al cierre: no se discutieron por escrito en M, y quedan para confirmar.

| Alternativa | Por qué no |
|---|---|
| **Cola propia de pedidos REST** (Background Sync) | Habría que resolver conflictos de versiones, comentarios y permisos a mano, y reintentar pedidos con un token vencido. Para el texto, el CRDT ya resuelve los conflictos. |
| **Cachear respuestas del API** en el Service Worker | Dejaría datos personales o de otra cuenta en la caché del navegador y mostraría permisos viejos. Es justo lo que prohíben H35–H37. |
| **`y-indexeddb`** (la librería de Yjs) | Otra dependencia, sin control sobre las reglas de privacidad (una cuenta, borrar al salir, solo el editor). La copia propia son 203 líneas (`almacen-local.js` y `borrar-local.js`), con sus pruebas. |
| **Copia local también para quien lee** | Guardaría en el equipo documentos que esa persona no escribió, sin beneficio: no tiene cambios propios que enviar. |

## Consecuencias

- **Un documento que no se abrió con red no está disponible sin red.** Es a propósito: no se descargan documentos «por si acaso».
- **Lo escrito sin conexión llega cuando vuelve la red,** con la autoría de esa cuenta. Si mientras tanto perdió el permiso de escritura, el servidor lo descarta y se borra la copia (R-01 cubre el caso inverso).
- **En un equipo compartido,** la copia queda hasta cerrar la sesión. El modelo de amenazas no cubre un equipo comprometido (fila «P1» del STRIDE).
- **Del lado del servidor**, el bloque M encontró y corrigió un fallo de K2 que perdía en la base lo que llegaba durante un `INSERT` (ADR 0003, mutación back M01).

## Estado de verificación al cierre (R6)

**Verificado:**

| Qué | Prueba | Mutación |
|---|---|---|
| Al reconectar, el paso 2 lleva todo lo que el servidor no tiene; cada actualización se guarda en la copia; al abrir se arranca con la copia; un cambio no enviado queda pendiente | `tests/unitarias/convergencia.test.mjs` del frontend (con semilla: réplicas, órdenes al azar, duplicados, cortes y recargas) | front M01–M04 |
| Sin red: se sigue escribiendo, se cierra la página, se vuelve con red y **todo llega una sola vez**; salir borra la copia | E2E `editor.spec.mjs` («sin red: Ana sigue escribiendo…») | — |
| Salir con cambios sin enviar avisa cuántos; cancelar los conserva y confirmar los borra | E2E `editor.spec.mjs` | — |
| IndexedDB solo en los dos archivos de la copia, que no ven la sesión; nada de `localStorage`, `sessionStorage` ni `document.cookie` en todo el código | `tests/unitarias/cliente.test.mjs` | — |
| El Service Worker: `/api` nunca por la caché, solo mismo origen y GET, `Vary` ignorado en `/assets`, precarga mínima; la app abre sin red | `tests/unitarias/sw.test.mjs` y E2E `sw.spec.mjs` | front H35–H39 |
| Sin red, el error del API tiene el código `red` | `tests/unitarias/cliente.test.mjs` | front H34 |
| Del lado del servidor: réplicas con cortes, ediciones sin conexión, duplicados y compactación convergen, también reconstruyendo el documento desde la base | `tests/integracion/convergencia.test.ts` del backend | back M01 |

**Implementado, sin prueba propia:**

| Regla | Código |
|---|---|
| Vaciar la copia si entra otra cuenta en el mismo navegador | `src/tiempo-real/almacen-local.js` |
| Borrar la copia al eliminar la cuenta y al restablecer la contraseña (cerrar la sesión sí tiene E2E) | `src/vistas/lector/datos.js`, `src/vistas/publico/recuperar.js` (`borrarDatosLocales`) |
| Borrar la copia de un documento al perder el acceso, si se elimina o si el servidor rechaza los cambios | `src/tiempo-real/documento.js` (`olvidarCopia`) |
| Juntar la copia cada 100 filas | `src/tiempo-real/almacen-local.js` (`FILAS_PARA_COMPACTAR`) |
| Seguir en memoria, avisando, si IndexedDB falla (modo privado, cuota) | `src/tiempo-real/documento.js` (`sin-copia`) |
| La reconexión según cada código de cierre | `src/tiempo-real/conexion.js` |

**No verificado:**
- Safari (lista de revisión del bloque R);
- una suspensión real del equipo: la E2E corta la red con `setOffline`, no suspende.
