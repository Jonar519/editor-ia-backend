# Protocolo de tiempo real

El WebSocket de colaboración de Cuaderno no entra en [`openapi.json`](openapi.json): OpenAPI describe pedido y respuesta, no un canal con mensajes en los dos sentidos. Lo describe este documento.

- **Decisiones:** [ADR 0002](adr/0002-comunicacion.md), con los porqués y las alternativas.
- **Persistencia:** [ADR 0003](adr/0003-crdt.md).
- **Código:** `src/tiempo-real/servidor.ts`, `tickets.ts` y `limites.ts` en este repo; `src/tiempo-real/conexion.js` en el frontend.

## Resumen

| Qué | Valor |
|---|---|
| Ruta | `GET /api/tiempo-real` con `Upgrade: websocket`, mismo proceso y puerto que el API |
| Subprotocolo | `cuaderno.v1`; el servidor responde **solo** ese, nunca el del ticket |
| Autenticación | un ticket de un solo uso, en `Sec-WebSocket-Protocol` (no en la URL ni en una cookie) |
| Documento | el del ticket: la URL no lleva el id |
| Marcos | **binarios**; un marco de texto cierra con 4400 |
| Formato | el de `y-protocols`: un entero variable con el tipo y después el contenido |

## 1. Pedir el ticket (REST)

```
POST /api/tiempo-real/tickets
Authorization: Bearer <access token>
Content-Type: application/json

{ "documentoId": "<uuid>" }
```

| Respuesta | Cuándo |
|---|---|
| **201** `{ ticket, expiraEnSegundos: 30 }` | La sesión está viva y la cuenta tiene **algún** rol sobre el documento |
| 404 | El documento no existe o no hay acceso (no se distingue) |
| 401, 400, 429 (con `Retry-After`), 503 | Los comunes del API (ver la descripción general de `openapi.json`). El ticket tiene su propio límite, de 60 por minuto y cuenta, más el general de 600. |

- **Qué es el ticket:** 32 bytes al azar (43 caracteres base64url).
- **Qué guarda Redis:** **solo su SHA-256**, con `{ usuarioId, sesionId, documentoId }`, y vence a los **30 s**.

## 2. Abrir el WebSocket

```js
new WebSocket('/api/tiempo-real', ['cuaderno.v1', `ticket.${ticket}`]);
```

Antes de responder **101**, el servidor comprueba **en este orden**. Si algo falla, responde con un código HTTP **sin abrir** el WebSocket:

| Comprobación | Si falla |
|---|---|
| La ruta es `/api/tiempo-real` | 404 |
| `Origin` es **exactamente** `APP_URL` (contra el secuestro de WebSocket entre sitios) | 403 |
| `Sec-WebSocket-Protocol` trae `cuaderno.v1` y **exactamente un** `ticket.<valor>` | 401 |
| Redis responde (para consumir el ticket) | **503**: falla cerrado |
| El ticket existe y no se usó: se consume con `GETDEL`, **un solo uso** aunque lleguen dos conexiones a la vez | 401 |
| La sesión de login sigue viva y la cuenta activa | 401 |
| La cuenta **todavía** tiene un rol sobre el documento (se calcula en ese momento) | 403 |

Después se registra la sesión de edición (`sesiones_edicion`, que la base ata a la sesión de login) y se responde 101 con el subprotocolo `cuaderno.v1`.

**Por qué el ticket va en el subprotocolo:**
- el `WebSocket` del navegador no admite la cabecera `Authorization`;
- en la URL quedaría en los logs de acceso, el historial y el `Referer`;
- la cookie de refresco solo viaja a `/api/auth` (ADR 0001).

## 3. Mensajes

Cada marco empieza con un entero variable (`lib0/encoding`) que dice el **tipo**:

| Tipo | Nombre | Sentido | Contenido |
|---|---|---|---|
| 0 | sync | los dos | un subtipo (entero variable) y su carga, como en `y-protocols/sync` |
| 1 | presencia | los dos | una actualización de `Awareness` de `y-protocols` (cursor, selección, nombre) |
| 2 | control | los dos | una cadena (`writeVarString`) con un JSON |

Un tipo desconocido, o un mensaje que no se puede decodificar, cierra con **4400**.

### 3.1 Sync (tipo 0)

| Subtipo | Nombre | Quién lo manda | Qué hace el servidor |
|---|---|---|---|
| 0 | paso 1 (vector de estado) | el servidor al abrir; el cliente cuando quiere | Responde con un paso 2 con lo que el otro no tiene. Permitido a **cualquier rol**. |
| 1 | paso 2 (lo que falta) | los dos | Si viene del cliente, cuenta como **actualización**: ver la fila de abajo. |
| 2 | actualización | los dos | **Exige editor o propietario.** La de un lector **se descarta** (no se aplica, no se retransmite, no se guarda), se registra en el log, y a la **tercera en 60 s** se cierra con 4403. Si el documento pasaría de 10 MiB, se cierra con 4413 **antes** de aplicarla. Si no, se aplica al `Y.Doc` del servidor, se retransmite a las **demás** conexiones del documento y se guarda (búfer de 250 ms). |

Una actualización vacía se ignora.

**Al abrir**, el servidor manda, en este orden:
1. el control `rol`;
2. su paso 1;
3. la presencia actual, si hay alguien.

El cliente responde con su paso 2: todo lo que el servidor no tiene, que es lo escrito sin conexión (ADR 0007).

### 3.2 Presencia (tipo 1)

- Permitida a **cualquier rol**: un lector aparece en «quién está».
- El servidor **sobrescribe** la identidad con la de la cuenta autenticada de esa conexión:
  - `usuario: { id, nombre }` para la interfaz;
  - `user.name` para el dibujo de `y-codemirror.next`.

  El cliente elige solo el color.
- La presencia de un `clientID` que no es de esa conexión **se descarta**.
- Al cerrar la conexión, se borra su presencia.

### 3.3 Control (tipo 2)

**Del servidor al cliente:**

| `tipo` | Campos | Cuándo |
|---|---|---|
| `rol` | `rol`: `propietario`, `editor` o `lector` | Al abrir. Un cambio de rol no llega como mensaje: la conexión se cierra con 4403 y el cliente vuelve a entrar con su rol nuevo. |
| `comentarios` | — | Alguien creó, editó, resolvió o borró un comentario de este documento: el cliente vuelve a pedir la lista por REST |
| `ia.sugerencia` | `pedido` y `texto`, **o** `pedido` y `error` | Respuesta a `ia.autocompletar` |

**Del cliente al servidor:**

| `tipo` | Campos | Qué hace el servidor |
|---|---|---|
| `ia.autocompletar` | `pedido`: entero seguro ≥ 0; `antes` y `despues`: cadenas | Pide una sugerencia al servicio de IA. Un pedido nuevo **cancela** el anterior en el servicio, y una respuesta vieja no se manda. Un lector recibe `error: "sin_permiso"` sin que se llame a la IA. Sin IA: `ia_no_disponible`. Los demás errores llegan con el código estable del API (por ejemplo, `tope_diario_ia` o `ia_tiempo_agotado`). |

- Un JSON que no es un objeto, o un `ia.autocompletar` con campos inválidos, cierra con **4400**.
- Un `tipo` desconocido **se ignora**, por compatibilidad con clientes más nuevos.

## 4. Límites

| Límite | Valor | Si se pasa |
|---|---|---|
| Tamaño de un mensaje | 1 MiB (el mismo CHECK de `actualizaciones_documento`) | cierre **1009** (de la librería `ws`) |
| Mensajes por segundo por conexión | 60 | cierre **4429** |
| Tamaño del documento | 10 MiB (el CHECK de `documentos.estado_yjs`) | cierre **4413** |
| Cola de envío sin entregar a un cliente lento | 4 MiB | cierre **1013** |
| Latido | ping cada 30 s; sin pong en 10 s | cierre **4408** |
| Escrituras descartadas (de quien no puede escribir) | 3 en 60 s | cierre **4403** |
| Vigencia del ticket | 30 s, un solo uso | 401 al abrir |
| Revalidación del rol y de la sesión | cada 30 s, y al instante con un aviso de la base o si la base rechaza una escritura (42501) | 4401, 4403 o 4404 |

El límite general de 600 pedidos por minuto y cuenta (R-07) **no** se aplica al WebSocket: el upgrade no pasa por Express. Sí se aplica al pedido del ticket.

## 5. Códigos de cierre

| Código | Significado | Cuándo | Qué hace el cliente (frontend) |
|---|---|---|---|
| **4400** | Mensaje mal formado | Marco de texto, tipo o subtipo desconocido, binario que no se decodifica, control inválido | No reintenta; error visible |
| **4401** | La sesión terminó | Se cerró o revocó la sesión (salir, otra sesión, cambio de contraseña, reutilización del refresh), la cuenta dejó de estar activa, o **venció la sesión con la conexión abierta** | Refresca el access token una vez y pide un ticket nuevo; si no puede, va a Entrar |
| **4403** | Sin permiso, o el permiso cambió | La revalidación encontró **otro rol** (más bajo o más alto), se quitó el acceso, o tres escrituras sin permiso en 60 s | Pide un ticket nuevo una vez. Si el ticket da 404: «Ya no tienes acceso». Si no, vuelve a entrar con el rol nuevo. |
| **4404** | El documento ya no existe | Se borró el documento o su espacio | Aviso y vuelta a la lista; borra su copia local |
| **4408** | Sin latido | No llegó el pong a tiempo | Reconecta con espera exponencial |
| **4413** | Documento demasiado grande | La actualización lo llevaría por encima de 10 MiB | No reintenta; error visible |
| **4429** | Demasiados mensajes | Más de 60 por segundo | Reconecta con espera exponencial |
| **1001** | Apagado ordenado | El servidor se apaga (SIGTERM): antes vacía lo pendiente a la base | Reconecta con espera exponencial y azar |
| **1009** | Mensaje demasiado grande | Más de 1 MiB | El cliente del frontend no llega a mandarlo: antes de enviar comprueba el tamaño y, si pasa de 1 MiB, termina con el estado «demasiado grande», sin reintentar |
| **1013** | Sobrecarga | La cola de envío de esa conexión pasó de 4 MiB: un cliente que no lee | Reconecta con espera exponencial y azar |

**El corte de 4403 y 4404 es inmediato:** cuando la revalidación decide cortar, la conexión deja de aplicarse y de retransmitirse **en el acto**, antes de que el cierre llegue al cliente. Lo que quedaba en su búfer se descarta (riesgo residual R-01 del [modelo de amenazas](modelo-amenazas.md)).

## 6. Revocación

La base avisa (`NOTIFY cuaderno_permisos`, con solo ids) al `COMMIT` de todo lo que quita acceso, también si el cambio se hizo por SQL directo. El backend reenvía cada aviso por Redis a las conexiones afectadas.

| Aviso | Conexiones afectadas | Cierre |
|---|---|---|
| Cambia o se quita el rol de un miembro, o un permiso de documento | las de esa cuenta en ese espacio o documento (se revalidan) | 4403 si el rol cambió |
| Se revoca o se borra una sesión viva | las de esa sesión | 4401 |
| La cuenta deja de estar activa o cambia su rol de cuenta | todas las de esa cuenta (se revalidan) | 4401 o 4403 |
| Se borra un documento (también en cascada, por su espacio) | todas las de ese documento | 4404 |

Si se cae la conexión que escucha la base, o la de Redis, al volver se revalidan **todas** las conexiones. Medido: con aviso, el corte tarda entre 8 y 19 ms.

## 7. Estado de verificación

**Verificado** en `tests/integracion/tiempo-real.test.ts`, con sockets reales y la base y Redis de pruebas, y con las mutaciones back T01–T09:
- el ticket de un solo uso (dos conexiones simultáneas), el ticket vencido, el `Origin` y que en Redis quede solo el hash;
- el guardia (lo de un lector se descarta, y a la tercera 4403);
- la presencia con el nombre de la cuenta;
- la revocación por aviso;
- R-01;
- el 4400 y el 4429.

Que el WebSocket siga funcionando con el límite general agotado lo comprueba `tests/integracion/limite-general.test.ts`.

**Implementado, sin prueba propia** (ADR 0002, «Estado de verificación al cerrar K2»): 4408, 1013, 4401 al vencer la sesión con la conexión abierta, 503 con Redis caído al entrar, la revalidación total al reconectar, 1001 y 1009. Tampoco tiene prueba el 4413 (ADR 0003).
