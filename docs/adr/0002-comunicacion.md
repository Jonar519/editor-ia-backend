# ADR 0002 · Comunicación: REST, WebSocket, SSE y gRPC

- **Estado:** aceptada (decisiones escritas al abrir el tramo 3; el bloque K se divide en K1 y K2)
- **Fecha:** 2026-10-17
- **Relacionados:** [ADR 0001](0001-sesion.md) (sesión), [ADR 0003](0003-crdt.md) (CRDT), [ADR 0004](0004-motor-de-edicion.md) (motor de edición), contrato [`ia.proto`](../../proto/cuaderno/ia/v1/ia.proto) (v1, desde P1).

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

**Una sola instancia en K2 (decisión escrita).** El documento abierto vive en la memoria del proceso: con dos instancias, dos personas en el mismo documento conectadas a instancias distintas no se verían. Se despliega con una instancia; si hiciera falta más de una, se reenvían los cambios de cada documento por Redis (no implementado). Los avisos sí funcionarían con varias: cada instancia escucha la base y publica, y cerrar dos veces la misma conexión no hace nada. Si Redis se cae, el servidor deja de aceptar conexiones nuevas (falla cerrado, igual que los límites del ADR 0001) y revalida en la base las abiertas.

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

### Contrato `ia.proto`

Está en [`proto/cuaderno/ia/v1/ia.proto`](../../proto/cuaderno/ia/v1/ia.proto) (módulo `proto/`, con [`buf.yaml`](../../proto/buf.yaml)). Se carga en tiempo de ejecución con `@grpc/proto-loader`; los tipos TypeScript salen de `npm run proto:generate` (`src/generated/ia`, no se versionan, como los de Prisma). El CI corre `npm run proto:check`: `buf lint` (STANDARD, con las excepciones de nombres en español) y `buf breaking` contra `main`. Se probó en Windows y en el contenedor Linux antes de depender de él (ver "Estado de verificación al cerrar P1"). Cambios de P1 respecto del borrador: `Origen.espacio_id` (campo 4) y `DocumentoIndexado.modelo` (campo 3), los dos compatibles.

La salud es la estándar `grpc.health.v1.Health`, copiada sin cambios del proto oficial en `proto/grpc/health/v1/health.proto` (en vez de depender de `grpc-health-check`, que arrastra `@grpc/proto-loader` 0.7).

### Servicio de IA (bloque P1)

Decisiones escritas al aprobar el diseño de P1:

- **Proceso aparte dentro del repo del backend** (`src/ia/`, `npm run ia:dev` / `ia:start`, `scripts\ia.bat`). No tiene base ni Redis: el API verifica sesión, permiso y tope ANTES de llamar, y guarda él mismo los resultados.
- **La IA caída no pone `/ready` en 503**: se muestra (`"ia": "falla"`) y las rutas de IA responden 503 `ia_no_disponible` por su cuenta. El editor sigue sirviendo sin IA.
- **Dependencias** exactas: `@grpc/grpc-js` 1.14.6, `@grpc/proto-loader` 0.8.1 y `@bufbuild/buf` 1.73.0 (desarrollo). Las 37 versiones nuevas, con transitivas, tienen 14 días o más.
- **Proveedor intercambiable** (`ProveedorIa`): el simulado (determinista, sin red) funciona de punta a punta; `ProveedorAnthropic` es un esqueleto que falla con `no_implementado` (502) hasta que se decida el proveedor real. `AI_PROVIDER=anthropic` exige `ANTHROPIC_API_KEY`; en producción el simulado no arranca.
- **Autenticación**: interceptor del servidor; la salud estándar queda sin token (la consultan los orquestadores y solo dice `SERVING`/`NOT_SERVING`).
- **Topes del lado del servicio**: además del deadline del API, cada método corta solo al doble de ese deadline, por si un cliente no lo pusiera.
- **Aislamiento**: el `Origen` va solo en el primer mensaje de una corriente; otro después cierra con `INVALID_ARGUMENT`. Cada llamada se registra con cuenta, espacio y documento, nunca con el contenido.
- **Tope diario** por cuenta en `uso_ia_diario` (300 pedidos y 300 000 tokens por día UTC), reservado de forma atómica antes de llamar; 429 `tope_diario_ia` con `Retry-After` hasta la medianoche UTC. El autocompletado cuenta solo tokens. Si la persona cancela a mitad, se cobra lo estimado hasta el corte.
- **Indexado**: se pide a mano (`POST /api/documentos/:id/indice`, editor o propietario, contra su tope) y, desde P2, **automático al dejar de editar** (ver "Búsqueda e indexado automático").

### Búsqueda e indexado automático (bloque P2)

Decisiones escritas de P2:

- **Indexado automático**: el mismo trabajo de "5 minutos sin cambios" que hace la versión automática encola el indexado. Va en nombre de la **última persona que editó** (el autor del último cambio guardado viaja en el trabajo); si ya no tiene acceso, en nombre del propietario del documento. Si el texto, los fragmentos y el modelo no cambiaron, no se llama a la IA.
- **Presupuesto por espacio**: el automático no gasta la cuota de nadie: va contra un presupuesto diario de **200 000 tokens por espacio** (`uso_ia_indexado_diario`, migración 0023; `IA_TOPE_INDEXADO_ESPACIO_DIA`). Se reserva lo estimado de forma atómica antes de llamar y se ajusta con lo que informa el servicio. Agotado, **el indexado se pospone al día siguiente** (un trabajo demorado hasta la medianoche UTC) **y queda en el log**; no falla en silencio.
- **`Describir`** (RPC nuevo, compatible): proveedor, modelo de embeddings y dimensiones. El API lo consulta en cada comprobación de salud y antes de buscar o indexar (con caché de 60 s). **Si no son 1024, la IA queda en "falla" en `/ready`, la búsqueda responde 502 y no se escribe ningún vector.**
- **Búsqueda**: solo con vectores del **modelo vigente**, con una **similitud coseno mínima de 0,2** (`IA_SIMILITUD_MINIMA`, validada con zod; hay que recalibrarla con el modelo real) y **como máximo 3 fragmentos por documento**. Lo hace la base (`buscar_fragmentos` de 7 parámetros, migración 0023), con el mismo aislamiento por espacio y acceso de hoy.
- **Cambio de modelo**: los fragmentos de otro modelo se reindexan aunque el texto no haya cambiado. `scripts\reindexar.bat` encola todos los documentos (contra el presupuesto de cada espacio).
- **Topes configurables**: `IA_TOPE_PETICIONES_DIA` y `IA_TOPE_TOKENS_DIA` (300 y 300 000 por defecto). `GET /api/ia/uso` devuelve el uso de hoy, los topes y cuándo se renuevan. El uso de IA (por cuenta y por espacio) se guarda **400 días** (`purgar_retencion()`, migración 0023).

### Inyección de prompts (bloque P2)

El prompt lo arma el servicio de IA (`src/ia/prompt.ts`), que es quien habla con el modelo:

- La **tarea** va en el mensaje de sistema, fija por tipo de pedido. La persona nunca escribe instrucciones libres: el estilo es un conjunto cerrado y el lenguaje se valida (`^[A-Za-z0-9+#._-]{1,40}$`; si no cumple, no entra a las instrucciones).
- El **contenido** va solo en el mensaje de usuario, dentro de `<documento-NONCE>…</documento-NONCE>` (en el autocompletado, `<antes-…>` y `<despues-…>`), **escapado como XML**: ningún texto del documento puede abrir ni cerrar una etiqueta.
- El **nonce** son 16 bytes aleatorios por llamada: un cierre falso escrito en el documento no coincide.
- El sistema le dice al modelo que lo del bloque son datos y que nunca siga órdenes de ahí.
- La **salida** también es dato no confiable: el servicio la recorta (explicar 4 000 caracteres, resumir y mejorar 60 000, una sugerencia 300) y, al llegar al tope, deja de pedirle al proveedor. No hay herramientas ni acciones: lo peor que logra una inyección es un texto. En Q se dibuja con el saneador de la vista renderizada.

**Cómo se prueba**: una batería de 20 cargas en las 4 tareas (cierres falsos, con el nonce de la llamada, anidados, en mayúsculas, con espacios o caracteres invisibles, homoglifos, roles de sistema, JSON, bloques de código, bidi, 5 000 cierres seguidos…) contra un **modelo "ingenuo"** de pruebas que obedece todo lo que esté fuera del bloque y toma como fin el primer cierre parecido. Se exige que nunca obedezca, que cada bloque abra y cierre una vez con el nonce y contenga la carga escapada entera, y que las instrucciones sean idénticas sea cual sea el contenido. Además, de punta a punta por el API y gRPC con ese modelo. **Límite**: esto prueba la estructura; que un modelo real además resista es una evaluación aparte, cuando se elija el proveedor (riesgo residual R-04).

### Embeddings: 1024 dimensiones

Los embeddings son de **1024 dimensiones** (`vector(1024)` de la migración 0011, el índice HNSW y `buscar_fragmentos`). **El modelo real tiene que producir exactamente ese tamaño; si produce otro, hará falta una migración** (columna, índice y función) y reindexar todo. El servicio lo hace cumplir: un vector de otro tamaño se rechaza con `INTERNAL` y nunca llega a la base. Además, vectores de modelos distintos no se comparan entre sí: `embeddings.modelo` guarda qué modelo produjo cada fila (lo informa el servicio en `DocumentoIndexado.modelo`), y al cambiar de modelo hay que reindexar.

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
| Cambiar `ia.proto` rompe al otro lado | Versión en el paquete, campos reservados, `buf breaking` contra `main` en el job `verificar` del CI (`npm run proto:check`, desde P1). |
| El modelo real de embeddings no es de 1024 dimensiones | El servicio rechaza el vector (`INTERNAL`); cambiar de tamaño exige migración y reindexado (ver "Embeddings: 1024 dimensiones"). |
| Gasto de IA sin control | Tope diario por cuenta atómico, 30 pedidos por minuto, deadlines en cada llamada y cancelación que corta la generación. |
| El ticket se filtra | Vale 30 s, una sola vez, ligado a una sesión viva y a un documento; en Redis solo su hash. |

## Cómo se prueba

| Qué | Prueba |
|---|---|
| Ticket de un solo uso | Integración: dos `upgrade` con el mismo ticket a la vez → uno abre y el otro recibe 401. Ticket vencido (emitido con una vigencia corta) → 401. Sin acceso al documento → el ticket mismo se niega (404). En Redis aparece solo el hash del ticket, nunca el ticket. |
| Origin | `upgrade` con otro `Origin` → 403 sin abrir. |
| Un lector nunca escribe | Integración con un cliente "manipulado" que manda actualizaciones como lector: el documento no cambia en el servidor ni en los otros clientes, no hay fila nueva en `actualizaciones_documento`, queda el log y la métrica, y a la tercera se cierra con 4403. Mutación que quita el guardia → la prueba falla. |
| Revocación | Con la conexión abierta: quitar el permiso, cerrar la sesión o borrar el documento → cierre con 4403, 4401 o 4404 en menos de 1 s (se mide). Mutación que no publica → falla. |
| **Ventana residual (R-01)** | Se quita el permiso **sin** publicar en pub/sub (como si Redis perdiera el aviso). Se mide **con relojes reales** (con sockets reales, un reloj falso no es fiable) y la revalidación en 300 ms en la prueba; otra prueba fija 30 s como valor de producción: (1) cuánto tarda la revalidación periódica en cortar la retransmisión; (2) que la primera escritura rechazada por la base la corte enseguida; (3) cuántas actualizaciones llegaron a los demás en la ventana. Después del corte: **cero**. |
| Redis caído | Sin Redis, el `upgrade` responde 503. |
| Límites | Mensaje de 1 MiB + 1 → 1009; ráfaga por encima del límite → 4429. |
| SSE y cancelación (P2) | Abortar el `fetch` a mitad → la llamada gRPC queda `CANCELLED` y el proveedor mock deja de generar. |
| Mapeo de errores (P1) | Una prueba por fila de la tabla gRPC → HTTP. |
| Carga (R) | HTTP con autocannon. WebSocket: autocannon no lo soporta, así que se usa un script propio con `ws` (N clientes, M cambios por segundo, latencia p50/p95/p99 de ida y vuelta). |

## Estado de verificación al cerrar K2

**Verificado** con pruebas de integración y sockets reales (`tests/integracion/tiempo-real.test.ts`) y mutaciones T01–T08:

- el ticket de un solo uso, aun con dos conexiones simultáneas;
- el ticket vencido, el `Origin`, y que en Redis quede solo el hash;
- el guardia: lo de un lector se descarta, y a la tercera vez se cierra con 4403;
- la presencia con el nombre de la cuenta;
- la revocación por aviso (8–19 ms);
- la ventana de R-01 medida;
- los mensajes mal formados (4400) y las ráfagas (4429).

**Implementado, sin prueba propia:**

| Regla | Código |
|---|---|
| Latido (4408) | `servidor.ts`, `abrir()` |
| Cola de envío de 4 MiB (1013) | `servidor.ts`, `enviar()` |
| Cierre cuando la sesión vence con la conexión abierta (4401) | `servidor.ts`, `abrir()` |
| Redis caído al entrar (503) | `servidor.ts`, `upgrade()` |
| Revalidar todo al reconectar el puente o Redis | `avisos.ts` |
| Apagado ordenado (1001, guardar lo pendiente) | `servidor.ts`, `cerrar()` |
| Mensaje de más de 1 MiB (1009, de la librería `ws`) | `maxPayload` |

## Estado de verificación al cerrar P1

**Verificado** con gRPC real (servicio en un puerto libre con el proveedor simulado), la base de pruebas y sockets reales (`tests/integracion/ia-grpc.test.ts`, `ia-api.test.ts`, `ia-autocompletado.test.ts`, `tests/unitarias/ia-*.test.ts`, `config-ia.test.ts`) y mutaciones P01–P27:

- los cuatro tipos de llamada, con su uso;
- el interceptor (sin token o con uno equivocado: `UNAUTHENTICATED`, sin llegar al proveedor) y la salud sin token;
- deadline (`DEADLINE_EXCEEDED` → 504) y cancelación (abortar la señal, dejar de leer la corriente o abortar el `fetch` del navegador): el simulado **deja de generar**, medido con su contador;
- un pedido nuevo de autocompletado cancela el anterior en el servicio;
- cada fila de la tabla gRPC → HTTP (unitaria, y de punta a punta las que el simulado produce, más el servicio caído y el token equivocado);
- vectores de otra dimensión que 1024 rechazados;
- aislamiento: una corriente no admite un segundo origen; dos corrientes simultáneas de espacios distintos no se mezclan; la búsqueda de un espacio nunca devuelve fragmentos de otro; buscar en un espacio ajeno da 404; quien sale del espacio deja de ver sus fragmentos; indexar un documento ajeno da 404 y el trabajo no llama a la IA ni escribe; la base rechaza un `indexado_por` sin acceso;
- el tope diario (atómico con 8 pedidos simultáneos, de pedidos y de tokens) y su `Retry-After`;
- `/ready` con la IA caída: 200 con `"ia": "falla"`; y **en vivo** con los dos procesos compilados (`dist/ia/principal.js` y `dist/servidor.js`, base de pruebas y Redis db 2): caída y recuperación de la IA sin reiniciar el API;
- `buf lint` y `buf breaking` en Windows y en el contenedor Linux (detecta un campo renumerado).

**Implementado, sin prueba propia:**

| Regla | Código |
|---|---|
| TLS mutuo (credenciales del servidor y del cliente) | `src/ia/principal.ts` `credencialesDe()`, `src/ia/cliente.ts` `credencialesIa()` |
| Apagado ordenado del servicio con SIGTERM (`NOT_SERVING`, espera y corte) | `src/ia/principal.ts`, `servicio.ts` `cerrar()` (en Windows no se puede mandar SIGTERM a un proceso hijo) |
| Tope propio por método (el doble del deadline del API) | `servicio.ts` `controlador()` |
| `Health.Watch` | `servicio.ts` `crearSalud()` |
| Latido SSE cada 15 s y cabeceras contra el búfer de proxies (se prueba `X-Accel-Buffering`, no el latido) | `src/ia/rutas.ts` |
| Contrapresión en las corrientes del servicio (`drain`) | `servicio.ts` `escribir()` |
| Autocompletado: un pedido viejo que llega tarde no se responde; la corriente se cierra con la conexión y se reabre si se corta | `tiempo-real/servidor.ts` `controlDelCliente()`, `cliente.ts` `autocompletado()` |
| 30 pedidos de IA por minuto y cuenta (usa `limitarTasa`, probado en otros bloques) | `src/ia/rutas.ts` |
| Reintentos del trabajo de indexado y `UnrecoverableError` con el tope diario | `src/ia/indexado.ts` |

## Estado de verificación al cerrar P2

**Verificado** (`tests/unitarias/ia-prompt.test.ts`, `tests/integracion/ia-p2.test.ts`, `config-ia.test.ts`, pruebas SQL de la 0023) y con mutaciones (backend P28–P44 y P21–P22 al día; base P01–P10):

- la batería de inyección (84 casos) y de punta a punta por el API con el modelo ingenuo;
- `Describir`; con un modelo de 512 dimensiones, `/ready` muestra la IA en "falla" sin 503, la búsqueda da 502 y el indexado no escribe ni cobra;
- la búsqueda: umbral (con 0, 0,2 y 0,99), máximo 3 por documento, solo el modelo vigente, y en la base el umbral, el tope, el modelo, el límite 1–50 y el aislamiento;
- el reindexado al cambiar de modelo;
- el indexado automático: en nombre de la última persona que editó, del propietario si ella se fue, contra el presupuesto del espacio y no su cuota; agotado, se pospone (sin llamar a la IA) y por la cola queda en el log y como trabajo demorado hasta mañana;
- la reserva del presupuesto, atómica (8 a la vez con tope 100 → 3);
- el aviso del trabajo de "sin cambios" al indexado, con el último autor;
- `GET /api/ia/uso`; los topes de salida (y que el servicio deja de pedirle al proveedor);
- la retención de 400 días (por cuenta y por espacio) y la configuración nueva.

**Implementado, sin prueba propia (P2):**

| Regla | Código |
|---|---|
| Devolver lo reservado al presupuesto si la IA falla, y ajustar a la baja con el uso real | `src/ia/indexado.ts` (`ajustarIndexadoEspacio`) |
| `UnrecoverableError` del trabajo con un modelo incompatible (no se reintenta) | `src/ia/indexado.ts` |
| Que el trabajo pospuesto efectivamente corra al día siguiente (se prueba que queda demorado, no que corra) | `src/ia/indexado.ts` |
| Caché de 60 s de `Describir` | `src/ia/cliente.ts` `modeloVigente()` |
| `scripts\reindexar.bat` (se probó en vivo contra la base de pruebas, sin prueba automática) | `scripts/reindexar.ts` |
| Prompts del esqueleto Anthropic (se arman, pero no se mandan a ningún modelo) | `src/ia/proveedor-anthropic.ts` |

## Decisiones tomadas (por escrito, 2026-10-17)

1. **Rol del guardia: en memoria por conexión, verificado en cada mensaje.** Se invalida al instante por pub/sub y se revalida en la base cada 30 s. **Condición:** la ventana no puede dejar que alguien sin permiso siga siendo retransmitido a los demás. Por eso:
   - cuando la revalidación (periódica o por pub/sub) encuentra un rol distinto, **la retransmisión de esa conexión se corta en el acto**: no se retransmite ni se aplica nada más de ella, se descarta lo que tenga en el búfer y se cierra con 4403;
   - si la base rechaza al persistir una actualización de esa conexión (el trigger de escritura, `42501`), eso **dispara la revalidación inmediata**, sin esperar a los 30 s;
   - la ventana que queda es un **riesgo residual** escrito en el [modelo de amenazas](../modelo-amenazas.md) (R-01). Una prueba de K2 la mide.
2. **Ticket en `Sec-WebSocket-Protocol`.**
3. **Autocompletado por el WebSocket del documento** (tramo 4).
4. **SSE sobre `fetch` POST** para resumir y mejorar (tramo 4).
