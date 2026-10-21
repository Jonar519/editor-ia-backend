# ADR 0002 · Comunicación: REST, WebSocket, SSE y gRPC

- **Estado:** aceptada (decisiones escritas al abrir el tramo 3; el bloque K se divide en K1 y K2)
- **Fecha:** 2026-10-17
- **Relacionados:** [ADR 0001](0001-sesion.md) (sesión), [ADR 0003](0003-crdt.md) (CRDT), [ADR 0004](0004-motor-de-edicion.md) (motor de edición), contrato [`ia.proto`](../../proto/cuaderno/ia/v1/ia.proto) (borrador).

## Contexto

Cuaderno tiene cuatro tipos de tráfico distintos:

1. **Pedido y respuesta** del navegador: identidad, cuenta, administración, CRUD de espacios y documentos, versiones, comentarios, búsqueda.
2. **Colaboración en tiempo real**: cambios del documento (binarios, del CRDT) en las dos direcciones, presencia (cursores) y avisos del servidor (permiso revocado, sesión terminada). Muchos mensajes chicos por segundo.
3. **Respuestas largas de la IA** (resumir, mejorar, explicar): el texto se genera de a poco y conviene mostrarlo mientras llega, y poder cancelarlo.
4. **Llamadas entre servicios**: el API habla con un servicio de IA aparte (bloque P1).

Restricciones ya decididas:

- **gRPC solo entre servicios internos** (confirmado con el profesor). El navegador nunca habla gRPC.
- El navegador y el API comparten origen (proxy de Vite en desarrollo). El backend **no usa CORS**.
- Access token de 15 min solo en memoria; cookie de refresco con `Path=/api/auth` (ADR 0001): **la cookie no viaja a ninguna otra ruta**, tampoco a la del WebSocket.
- Sesión viva verificada en cada petición; un cambio de rol rige de inmediato.

## Decisión

### Qué protocolo va en cada tramo

| Tramo | Tráfico | Protocolo | Por qué |
|---|---|---|---|
| 1 y 2 · identidad | login, cuenta, admin | **REST/JSON** sobre HTTP (ya existe) | Pedido-respuesta puro. Códigos HTTP, caché y herramientas estándar, OpenAPI generado desde zod. |
| 3 · K, N | CRUD de espacios, documentos, permisos, versiones, comentarios | **REST/JSON** | Mismo modelo que el resto del API: validación zod, OpenAPI, límites con Redis. |
| 3 · K, L, M | edición colaborativa y presencia | **WebSocket** (marcos binarios, protocolo de Yjs) | Bidireccional, binario, una conexión persistente por documento abierto, latencia baja. |
| 3 · K | entrar al WebSocket | **REST** `POST /api/tiempo-real/tickets` → ticket de un solo uso | El WebSocket del navegador no admite cabecera `Authorization`. |
| 4 · P2, Q | explicar (respuesta corta) | **REST/JSON** | Una respuesta completa, sin necesidad de streaming. |
| 4 · P2, Q | resumir y mejorar (respuesta larga) | **SSE sobre `fetch` POST** (`text/event-stream`) | Solo va del servidor al navegador; se muestra a medida que llega; cancelar es abortar el `fetch`. |
| 4 · P2, Q | autocompletado (texto fantasma) | **El mismo WebSocket del documento**, mensaje de control `ia.autocompletar` | Pedidos muy frecuentes y cancelables a cada tecla; la conexión ya está autenticada y sabe el rol (un lector no autocompleta). |
| 4 · P1–P3 | API ↔ servicio de IA | **gRPC** (HTTP/2, Protocol Buffers, `cuaderno.ia.v1`) | Contrato tipado y versionado, streaming en los dos sentidos, deadlines y cancelación nativos, multiplexación. |
| 5 · R | pruebas de carga | HTTP y WebSocket por separado | Cada protocolo se mide con su herramienta (ver "Cómo se prueba"). |

### WebSocket de colaboración (bloque K)

**Dónde.** En el mismo proceso y puerto que el API: `GET /api/tiempo-real` con `Upgrade: websocket`. Al estar bajo `/api`, pasa por el mismo proxy de Vite (con `ws: true`) y sigue siendo del mismo origen.

**Autenticación con ticket de un solo uso.**

1. Con su access token, el navegador pide `POST /api/tiempo-real/tickets` con `{ documentoId }`.
2. El API verifica la sesión (como en cualquier petición) y que la cuenta tenga **algún** acceso al documento (`rol_efectivo_documento`). Si no, 404 (no se revela si el documento existe).
3. Genera 32 bytes aleatorios. En Redis guarda **solo su SHA-256** con `{ usuarioId, sesionId, documentoId }` y vence en **30 s**.
4. El navegador abre `new WebSocket('/api/tiempo-real', ['cuaderno.v1', 'ticket.<valor>'])`. **El ticket viaja en `Sec-WebSocket-Protocol`, no en la URL**: así no queda en logs de acceso, historial ni `Referer`.
5. En el `upgrade`, antes de responder 101:
   - el `Origin` tiene que ser exactamente `APP_URL` (contra el secuestro de WebSocket entre sitios);
   - el ticket se consume con `GETDEL` (atómico: **un solo uso**, aunque lleguen dos conexiones a la vez);
   - la sesión de login tiene que seguir viva y la cuenta activa;
   - se calcula el rol efectivo **en ese momento**;
   - se registra la sesión de edición (`sesiones_edicion`, que la base ata a la sesión de login).
   
   Si algo falla, se responde 401 o 403 **sin** abrir el WebSocket. El servidor contesta el subprotocolo `cuaderno.v1`, nunca el del ticket.

**Mensajes.** Marcos binarios con el formato de `y-protocols` (un entero variable con el tipo y luego el contenido):

| Tipo | Sentido | Contenido |
|---|---|---|
| 0 · sync | los dos | pasos 1 y 2 del intercambio de vectores de estado, y actualizaciones |
| 1 · awareness | los dos | presencia: cursor, selección, nombre y color (bloque L) |
| 2 · control | los dos | JSON corto: `rol` (al entrar), `ia.autocompletar` (tramo 4), errores |

**Permiso verificado en CADA mensaje.** Cada mensaje que entra pasa por un guardia **antes** de aplicarse o retransmitirse:

- Una **actualización** (sync paso 2 o update) exige rol `editor` o `propietario`. La de un lector **se descarta**: no se aplica, no se retransmite, no se persiste. Se registra (log `warn` con cuenta, documento y sesión, sin contenido) y se cuenta en una métrica. La conexión se cierra a la tercera en 60 s (4403): un cliente honesto en modo lectura nunca la manda.
- El **sync paso 1** (pedir lo que falta) y la **presencia** están permitidos para cualquier rol con acceso.
- Tamaño máximo por mensaje: **1 MiB** (el mismo CHECK de la base); más grande cierra con 1009.
- Límite de mensajes por conexión (ventana deslizante en memoria) y cierre con 4429 si se pasa.
- La base repite la verificación al persistir: el trigger `actualizaciones_exigen_escritura` rechaza la actualización de quien no puede escribir. Es la segunda línea, no la primera.

**De dónde sale el rol que verifica el guardia.** Del estado de la conexión, en memoria. Se carga al abrir, se invalida por pub/sub y se revalida en la base cada 30 s o en cuanto la base rechaza una escritura. Si cambia, la conexión deja de retransmitirse en el acto (ver "Decisiones tomadas", punto 1).

**Revocación que corta la conexión en curso (Redis pub/sub).** Canal `cuaderno:tiempo-real:revocaciones`. El API publica **después del commit** de cada cambio que puede quitar acceso:

| Evento | Publica | Efecto en las conexiones abiertas |
|---|---|---|
| Cambia o se quita el rol de un miembro del espacio, o el permiso de un documento | CRUD de espacios y permisos (K) | Las de esa cuenta en ese espacio o documento se cierran con **4403**. El cliente pide un ticket nuevo: si todavía tiene acceso, vuelve con su rol nuevo. |
| Se cierra o revoca una sesión (salir, otra sesión, cambio de contraseña, reutilización del refresh) | `src/auth`, `src/cuenta` | Las de esa sesión se cierran con **4401**. |
| Cuenta eliminada, anonimizada o cambio de rol de cuenta | `src/cuenta`, administración | Todas las de esa cuenta: 4401 o 4403. |
| Documento o espacio borrado | CRUD (K) | Todas las de ese documento: **4404**. |

Con varias instancias del servidor, todas reciben el mensaje y cada una cierra las suyas. Si Redis se cae, el servidor deja de aceptar conexiones nuevas (falla cerrado, igual que los límites del ADR 0001) y revalida en la base las abiertas.

**Latido.** Ping cada 30 s; sin pong en 10 s, se cierra (4408) y se borra la sesión de edición.

**Contrapresión.** Si `bufferedAmount` de una conexión pasa de 4 MiB (un cliente lento), se cierra con 1013 en vez de acumular memoria.

**Códigos de cierre propios**:

| Código | Significado | Qué hace el cliente |
|---|---|---|
| 4400 | Mensaje mal formado | No reintenta; error visible |
| 4401 | La sesión terminó | Intenta refrescar el access token; si no puede, va a Entrar |
| 4403 | Sin permiso (o cambió) | Pide un ticket nuevo una vez; si da 404, "Ya no tienes acceso" |
| 4404 | El documento ya no existe | Aviso y vuelta a la lista |
| 4408 | Sin latido | Reconecta con espera exponencial |
| 4429 | Demasiados mensajes | Reconecta con espera exponencial |
| 1001 / 1013 | Apagado ordenado / sobrecarga | Reconecta con espera exponencial y algo de azar |

**Persistencia y compactación.** Están en el [ADR 0003](0003-crdt.md), porque dependen del formato del CRDT.

### Streaming de la IA hacia el navegador (tramo 4)

**SSE con el formato `text/event-stream`, pero pedido con `fetch` y POST**, no con `EventSource`: `EventSource` solo hace GET, no admite cuerpo ni cabecera `Authorization`, y obligaría a poner el texto del documento en la URL.

```
POST /api/ia/resumir   (Authorization: Bearer …, cuerpo JSON)
→ 200 text/event-stream
event: fragmento   data: {"texto":"…"}
event: fragmento   data: {"texto":"…"}
event: fin         data: {"tokensEntrada":812,"tokensSalida":140}
```

- **Cancelar** = el navegador aborta el `fetch`. El API lo detecta (`close` de la petición) y cancela la llamada gRPC, que a su vez corta la generación en el servicio de IA.
- **Errores antes del primer byte**: el código HTTP normal (400, 403, 429 con `Retry-After`). **Errores a mitad del stream**: `event: error` con `{ codigo, mensaje }` y fin.
- El tope diario de tokens se cobra con los números del evento `fin`.

### gRPC entre el API y el servicio de IA (P1)

- **Servicio** `cuaderno.ia.v1.Asistente`, proceso aparte en `127.0.0.1:4210`. Solo escucha en el loopback, igual que Postgres y Redis.
- **Los cuatro tipos de llamada** tienen un uso real:

| Tipo | RPC | Uso |
|---|---|---|
| Unaria | `Explicar`, `EmbeberConsulta` | Explicar una selección; vector de una búsqueda |
| Streaming del servidor | `Resumir`, `Mejorar` | El texto llega de a poco y se traduce a SSE |
| Streaming del cliente | `IndexarDocumento` | El API manda los fragmentos de un documento (job de BullMQ); el servicio devuelve sus vectores al final |
| Bidireccional | `Autocompletar` | Una corriente por conexión de edición: entra el contexto a cada pausa de escritura y salen sugerencias; un contexto nuevo cancela la sugerencia anterior |

- **Autenticación entre servicios**: metadato `authorization: Bearer <IA_SERVICE_TOKEN>` (32 bytes, comparado en tiempo constante). En producción, además TLS mutuo o red privada; la configuración se niega a arrancar sin una de las dos.
- **Deadlines** que pone siempre el API: `Explicar` y `EmbeberConsulta` 15 s, `Resumir` y `Mejorar` 60 s, `IndexarDocumento` 120 s, cada sugerencia de `Autocompletar` 2 s.
- **Salud**: `grpc.health.v1.Health` estándar. `/ready` del API la consulta.
- **Versionado**: el paquete lleva la versión (`v1`). Un número de campo nunca se reutiliza (`reserved`); un cambio incompatible es `v2` en paralelo.
- **Contenido como datos**: el texto del documento y la instrucción van en **campos separados**. El servicio lo encierra entre delimitadores y nunca lo interpreta como instrucción (defensa contra la inyección de prompts, bloque P2).

**Mapeo de errores gRPC → HTTP** (en el gateway):

| gRPC | HTTP al navegador |
|---|---|
| `INVALID_ARGUMENT` | 400 |
| `RESOURCE_EXHAUSTED` | 429 (con `Retry-After` si el servicio lo indica) |
| `DEADLINE_EXCEEDED` | 504 `ia_tiempo_agotado` |
| `UNAVAILABLE` | 503 `ia_no_disponible` |
| `CANCELLED` | (el navegador ya se fue: solo log) |
| `UNAUTHENTICATED`, `PERMISSION_DENIED` | 502 `ia_error_interno` (es un error **entre servicios**, no de la persona) |
| cualquier otro | 502 `ia_error_interno` |

### Contrato `ia.proto` (borrador)

Está en [`proto/cuaderno/ia/v1/ia.proto`](../../proto/cuaderno/ia/v1/ia.proto). **No se compila ni se usa hasta P1.** Su sintaxis se comprobó con un parser de Protocol Buffers; su diseño se revisa al empezar P1.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **WebSocket para todo**, incluido el CRUD | Pierde la semántica HTTP (códigos, caché, OpenAPI, límites por ruta) y obliga a reinventar pedido-respuesta, reintentos y errores encima de mensajes. |
| **SSE para la colaboración** (servidor→cliente) + POST para subir cambios | Solo texto: los cambios binarios del CRDT irían en base64 (+33 %). Dos canales que sincronizar, y un POST por cada pulsación. |
| **Long polling** | Latencia alta y una petición por cambio. Solo tiene sentido si no hay WebSocket. |
| **WebRTC entre navegadores** | Necesita señalización y TURN, y el servidor **no vería** los mensajes: imposible verificar el permiso en cada uno. |
| **gRPC-Web desde el navegador** | Descartado por decisión con el profesor. Además necesita un proxy (Envoy) y no tiene streaming del cliente ni bidireccional en el navegador. |
| **Access token en la URL del WebSocket** | Queda en logs de acceso y en el historial; vive 15 min. El ticket vive 30 s, se usa una vez y no va en la URL. |
| **Cookie de sesión para el WebSocket** | La cookie de refresco solo viaja a `/api/auth` por diseño (ADR 0001). Ampliarla a otra ruta abre CSRF y mezcla los dos mecanismos. |
| **Ticket como primer mensaje** (después de abrir) | El socket queda abierto y sin autenticar un momento; hay que cerrarlo a mano si no llega. El subprotocolo autentica **antes** del 101. |
| **`EventSource`** para la IA | Solo GET, sin cabeceras ni cuerpo. |
| **REST/JSON entre el API y el servicio de IA** | Sin contrato tipado ni streaming bidireccional nativo. Es justo lo que P3 mide contra gRPC. |

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Proxies o balanceadores que cortan WebSockets inactivos | Latido cada 30 s; reconexión con espera exponencial y azar. |
| Una conexión abierta sobrevive a un cambio de permiso | Pub/sub al hacer commit + cierre 4403; revalidación periódica como red de seguridad; trigger de la base al persistir. |
| Redis caído: no llegan las revocaciones | Falla cerrado: no se aceptan conexiones nuevas y las abiertas se revalidan en la base. |
| Un cliente manipulado manda actualizaciones siendo lector | Se descartan en el guardia, se registran y la conexión se cierra a la tercera; la base las rechaza igual. |
| Memoria: un documento en memoria por cada uno abierto | Se descarga tras 60 s sin conexiones; tope de tamaño del estado (10 MiB, CHECK de la base). |
| SSE detrás de un proxy que guarda en búfer | `Cache-Control: no-cache` y `X-Accel-Buffering: no`; comentario de latido cada 15 s. |
| Cambiar `ia.proto` rompe al otro lado | Versión en el paquete, campos reservados, `buf breaking` o equivalente en el job `grpc` del CI (P1). |
| El ticket se filtra | Vale 30 s, una sola vez, ligado a una sesión viva y a un documento; en Redis solo su hash. |

## Cómo se prueba

| Qué | Prueba |
|---|---|
| Ticket de un solo uso | Integración: dos `upgrade` con el mismo ticket a la vez → uno abre y el otro recibe 401. Ticket vencido (31 s, reloj falso) → 401. Ticket de otro documento → 403. En Redis no aparece el ticket en claro (barrido como `secretos.test.ts`). |
| Origin | `upgrade` con otro `Origin` → 403 sin abrir. |
| Un lector nunca escribe | Integración con un cliente "manipulado" que manda actualizaciones como lector: el documento no cambia en el servidor ni en los otros clientes, no hay fila nueva en `actualizaciones_documento`, queda el log y la métrica, y a la tercera se cierra con 4403. Mutación que quita el guardia → la prueba falla. |
| Revocación | Con la conexión abierta: quitar el permiso, cerrar la sesión o borrar el documento → cierre con 4403, 4401 o 4404 en menos de 1 s (se mide). Mutación que no publica → falla. |
| **Ventana residual (R-01)** | Se quita el permiso **sin** publicar en pub/sub (como si Redis perdiera el aviso). Se mide: (1) cuánto tarda la revalidación periódica en cortar la retransmisión (≤ 30 s, con reloj falso); (2) que la primera escritura rechazada por la base la corte enseguida; (3) cuántas actualizaciones llegaron a los demás en la ventana. Después del corte: **cero**. |
| Redis caído | Sin Redis, el `upgrade` responde 503. |
| Límites | Mensaje de 1 MiB + 1 → 1009; ráfaga por encima del límite → 4429. |
| SSE y cancelación (P2) | Abortar el `fetch` a mitad → la llamada gRPC queda `CANCELLED` y el proveedor mock deja de generar. |
| Mapeo de errores (P1) | Una prueba por fila de la tabla gRPC → HTTP. |
| Carga (R) | HTTP con autocannon. WebSocket: autocannon no lo soporta, así que se usa un script propio con `ws` (N clientes, M cambios por segundo, latencia p50/p95/p99 de ida y vuelta). |

## Decisiones tomadas (por escrito, 2026-10-17)

1. **Rol del guardia: en memoria por conexión, verificado en cada mensaje.** Se invalida al instante por pub/sub y se revalida en la base cada 30 s. **Condición:** la ventana no puede dejar que alguien sin permiso siga siendo retransmitido a los demás. Por eso:
   - cuando la revalidación (periódica o por pub/sub) encuentra un rol distinto, **la retransmisión de esa conexión se corta en el acto**: no se retransmite ni se aplica nada más de ella, se descarta lo que tenga en el búfer y se cierra con 4403;
   - si la base rechaza al persistir una actualización de esa conexión (el trigger de escritura, `42501`), eso **dispara la revalidación inmediata**, sin esperar a los 30 s;
   - la ventana que queda es un **riesgo residual** escrito en el [modelo de amenazas](../modelo-amenazas.md) (R-01). Una prueba de K2 la mide.
2. **Ticket en `Sec-WebSocket-Protocol`.**
3. **Autocompletado por el WebSocket del documento** (tramo 4).
4. **SSE sobre `fetch` POST** para resumir y mejorar (tramo 4).
