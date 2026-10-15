# Retención de datos

Qué datos guarda Cuaderno, cuánto tiempo y quién los borra.

**Quién decide los plazos.** Los plazos viven **en la base** (repo `editor-ia-database`, migraciones 0015, 0019 y 0020) y se miden con su reloj (`now()`).

**Quién ejecuta la purga.** El backend solo decide **cuándo** se ejecuta: un job de BullMQ, todos los días a las **03:15 UTC** (`src/trabajos/retencion.ts`), llama a `purgar_retencion()`.

## Plazos

| Dato | Se borra | Por qué ese plazo | Dónde |
|---|---|---|---|
| Sesiones terminadas (revocadas o vencidas) | 30 días después de terminar | La lista de sesiones solo muestra las vivas. 30 días dan margen para revisar un incidente reciente. | `purgar_retencion()` |
| Refresh tokens | Junto con su sesión (en cascada) | Mientras la sesión vive, los refresh **usados** se conservan: son los que permiten detectar la reutilización de uno robado. | cascada de `sesiones` |
| Sesiones de edición (presencia) | Junto con su sesión (en cascada) | Solo tienen sentido mientras la sesión de login existe. | cascada de `sesiones` |
| Tokens de recuperación | 1 día después de vencer (vencen a los 15 min) | Ya no sirven. Un día de margen evita borrar uno en la misma ventana en que se usa. | `purgar_retencion()` |
| Cambios de correo | 1 día después de vencer (vencen a los 60 min) | Igual que los de recuperación. | `purgar_retencion()` |
| Correos simulados (buzón de la demo) | Al vencer (7 días como máximo, lo exige un CHECK) | Solo existen con el proveedor `mock`, que producción no admite. | `purgar_retencion()` |
| Eventos de seguridad | 180 días | Auditoría: suficiente para investigar incidentes sin guardar historial indefinido. | `purgar_retencion()`; el trigger de solo inserción no deja borrar nada más reciente |
| Cuentas pendientes con la invitación vencida, con su invitación e inscripción MFA en cascada | 7 días después de vencer la invitación (vence a las 72 h) | Son nombre y correo de alguien que nunca completó el alta. Los 7 días dan margen para que un admin reenvíe la invitación. Sus eventos de seguridad se anonimizan. | `purgar_retencion()` (0020) |
| Desafíos MFA | 5 minutos (TTL de Redis) | Un solo uso; en Redis solo se guarda su hash. | Redis |
| Contadores de límites de tasa | El tamaño de su ventana (TTL de Redis) | Solo sirven dentro de la ventana. | Redis |

## Eliminación de cuenta

`DELETE /api/cuenta` exige la contraseña y, si la cuenta tiene MFA, un código. La eliminación la hace la base en **una transacción**, con `eliminar_cuenta()` (migración 0018).

### Cuándo se rechaza (409 `propiedad_compartida`)

La cuenta es propietaria de documentos con otros colaboradores, o de espacios con otros miembros. El 409 lista qué hay que transferir.

"Colaborador" es cualquier otro miembro del espacio del documento. Como un documento no tiene privacidad dentro de su espacio, todos los miembros tienen acceso a él.

### Qué se borra

- Los espacios donde la cuenta es el **único miembro**, con todo su contenido: documentos, versiones, comentarios y embeddings. Son exactamente los documentos sin colaboradores.
- Sus membresías en espacios de otros, y con ellas sus permisos de documento.
- Sesiones, refresh tokens, sesiones de edición, tokens de recuperación, cambios de correo, MFA, códigos de respaldo, avatar y uso de IA.

### Qué se anonimiza

- La cuenta queda como **lápida**: conserva su id (para la autoría) y pierde correo, nombre, teléfono y contraseña. Un CHECK de la base lo exige.
- Sus eventos de seguridad pierden la cuenta y la IP. No se borran: siguen contando para la auditoría y salen solos a los 180 días.

### Qué se conserva

| Dato | Por qué |
|---|---|
| Versiones, actualizaciones y comentarios en documentos **de otros** | Son parte de un documento compartido. Siguen apuntando al id de la lápida, que ya no tiene nombre ni correo. |

**Historial intacto.** El id de la lápida no cambia, así que la cadena de hash de las versiones sigue verificándose (`verificar_cadena_versiones`).

**Sin documentos huérfanos, por construcción.** Todo documento tiene exactamente un propietario, ese propietario tiene que ser miembro del espacio y solo una cuenta activa puede ser miembro.

## Avatar

Se guarda **solo la versión limpia**. La imagen se reconstruye copiando los segmentos JPEG o chunks PNG de una lista blanca. Quedan fuera EXIF (con GPS), XMP, ICC, IPTC, comentarios, textos PNG, fechas y cualquier dato pegado al final.

Un archivo que no se puede analizar se rechaza con 422 y no se guarda nada. El original nunca se escribe en disco ni en la base.

Efecto conocido: al quitar EXIF también se pierde la orientación, así que una foto del teléfono puede verse girada. El frontend (tramo 2) la normalizará al recortarla, antes de subirla.

## Exportación

`POST /api/cuenta/exportacion` exige la contraseña y devuelve un JSON (`cuaderno-exportacion/v1`) con:

- perfil, estado del MFA y cambio de correo pendiente;
- avatar (en base64);
- sesiones (incluidas las terminadas que aún no se purgan);
- espacios y documentos propios, con el texto de su última versión;
- comentarios, eventos de seguridad y uso de IA.

**Nunca** incluye el hash de la contraseña, hashes de tokens, el secreto MFA cifrado (ni su IV o etiqueta) ni los HMAC de los códigos de respaldo. La prueba `datos.test.ts` busca esos valores, en hex, base64 y base64url, dentro del JSON (mutación U26).

## Fuera de la purga diaria (por ahora)

| Dato | Situación actual |
|---|---|
| `rangos_ip_geo` | No son datos personales: es una tabla de rangos de red. |
