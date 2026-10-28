# Pruebas de carga (bloque R): HTTP y WebSocket

> Generado por `npm run carga` (`scripts/carga/`). Datos crudos: `docs/carga-r.json`. No se edita a mano.

## Lo que esta medición NO permite concluir

- **La capacidad en producción.** Todo corre en UNA máquina: los clientes de carga, el API, PostgreSQL y Redis comparten la CPU. Es loopback: sin red real, sin TLS, sin proxy inverso ni balanceador. Un número de esta tabla no es "cuántas personas aguanta Cuaderno".
- **Escalar horizontalmente.** Se mide una sola instancia del API, que es lo único que admite hoy el tiempo real (ADR 0002).
- **El costo del log y de producción.** El API corre con `NODE_ENV=development` (producción exige proveedores reales) y `LOG_LEVEL=warn`: sin la línea de log por pedido que tendría con `info`.
- **Nada de la IA.** La IA está apagada (sin `IA_SERVICE_TOKEN`) y el correo es simulado: no se carga ninguna ruta de IA ni el autocompletado.
- **Una base grande o vieja.** La base es nueva en cada medición y chica: 102 cuentas, 2 espacios y 23 documentos. Caché caliente y sin hinchazón.
- **Efectos de largo plazo.** Cada corrida dura 30 s: no muestra fugas de memoria, la compactación por inactividad (5 min), la retención diaria ni el vencimiento de sesiones.
- **Latencias altas exactas en HTTP.** autocannon mide en lazo cerrado: cada conexión espera su respuesta antes de mandar otra, así que con el servidor lento baja el ritmo (omisión coordinada) y las latencias altas pueden quedar subestimadas. Su resolución es de 1 ms: lo que tarda menos se ve como 0 o 1 ms.
- **El costo de muchos inicios de sesión.** Con una sola IP de cliente, el límite por IP del login (20 cada 15 minutos) se alcanza enseguida: H4 mide sobre todo las respuestas 429 del limitador, no miles de verificaciones de contraseña.
- **Solo la latencia del servidor en WebSocket.** La latencia de ida y vuelta incluye el bucle de eventos de los generadores (en la misma máquina) y aplicar el cambio de Yjs en el cliente que lo recibe.
- **Que se mandó lo que se pidió.** Si los generadores no llegan a su ritmo (sus procesos saturados o el servidor sin responder a tiempo), se mandan menos cambios de los pedidos. La tabla muestra los dos («pedidos» y «enviados»). Una fila donde no coinciden no mide ese ritmo, sino lo que la máquina logró.
- **Windows frente a Linux como comparación de sistemas.** Las dos corridas usan el mismo equipo y los MISMOS contenedores de PostgreSQL y Redis (Docker sobre WSL2). En Windows, el API y los clientes corren en Windows y llegan a ellos por el puerto publicado; en Linux, el API y los clientes corren en un contenedor y llegan por la red de Docker. La virtualización suma su costo en los dos casos, distinto en cada uno. La referencia es Linux.
- **Carga ajena del lado Windows durante la corrida de Linux.** Dentro del contenedor, la comprobación de carga previa ve la CPU de la máquina virtual de WSL2, no los procesos de Windows. Por eso la corrida de Linux se hizo con el equipo sin otros programas abiertos, igual que la de Windows.
- **Comparaciones con otros sistemas** ni un "máximo" de clientes: no se buscó el punto de quiebre.

## Cómo se midió

- **Servidor:** el API REAL (`dist/servidor.js`, el mismo arranque que producción: tiempo real, avisos de la base, compactación y retención) en su propio proceso, contra una base de pruebas propia (`cuaderno_carga_test`, recreada y migrada en cada medición) y Redis db 2. La CPU y la memoria del API se miden en su proceso.
- **Datos:** solo ficticios (`@example.com`). La cuenta del login usa el costo de contraseña de producción (scrypt, 2^15).
- **HTTP (autocannon):** H1 `GET /health`; H2 `GET /api/espacios` con sesión (la sesión se valida en la base en cada pedido); H3 `GET /api/documentos/:id/texto` de un documento de 10 000 caracteres. Antes de cada corrida, 5 s de calentamiento.
- **H4:** `POST /api/auth/sesion` con la contraseña correcta, con el límite de inicio de sesión vaciado antes de cada corrida, y a la vez una sonda de H2 con 1 conexión, comparada con la misma sonda sola justo antes.
- **WebSocket:** clientes Yjs con el protocolo del navegador, repartidos en hasta 4 procesos generadores. Cada cambio escribe una letra en el texto y, en un mapa, su número y el instante en que se mandó; quien lo recibe calcula la latencia de ida y vuelta por el servidor. **Pérdida:** entregas esperadas (cada cambio enviado en la ventana, a cada uno de los otros clientes de su documento) menos las recibidas. **Convergencia:** al final, todos los clientes de cada documento tienen el mismo estado, del mismo largo que el texto del servidor. **Filas:** inserciones en `actualizaciones_documento` dentro de la ventana medida, según la secuencia de su `id` (exacta: la compactación no la baja). El servidor inserta una fila por autor en cada vaciado (cada 250 ms).
- **Carga ajena:** antes de empezar y de cada corrida se mide la CPU de la máquina; con más del umbral se espera, y si no baja se aborta todo sin escribir nada.
- **Estadística:** cada fila junta las repeticiones de esa configuración. Pedidos/s: mediana [mínimo–máximo]. Latencias: mediana de las repeticiones. Máx: el mayor de todas. CPU en % de UN núcleo.

### windows-sin-limite

| Dato | Valor |
|---|---|
| Fecha | 2026-10-28T00:23:59.432Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 31,1 GiB |
| Sistema | Windows_NT 10.0.26300 |
| Node | v24.13.1 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 9,2 % (umbral 10 %) |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |
### windows-con-limite

| Dato | Valor |
|---|---|
| Fecha | 2026-10-28T00:29:36.459Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 31,1 GiB |
| Sistema | Windows_NT 10.0.26300 |
| Node | v24.13.1 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 5,5 % (umbral 10 %) |
| Límite general del API (LIMITE_PEDIDOS_MINUTO) | 1000000000 |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |
### windows-limite-600

| Dato | Valor |
|---|---|
| Fecha | 2026-10-28T00:35:17.900Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 31,1 GiB |
| Sistema | Windows_NT 10.0.26300 |
| Node | v24.13.1 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 5,6 % (umbral 10 %) |
| Límite general del API (LIMITE_PEDIDOS_MINUTO) | 600 |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |
### linux-sin-limite

| Dato | Valor |
|---|---|
| Fecha | 2026-10-28T00:41:15.094Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 15,1 GiB |
| Sistema | Linux 6.6.87.2-microsoft-standard-WSL2 |
| Node | v24.20.0 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 0,7 % (umbral 10 %) |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |
### linux-con-limite

| Dato | Valor |
|---|---|
| Fecha | 2026-10-28T00:47:12.706Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 15,1 GiB |
| Sistema | Linux 6.6.87.2-microsoft-standard-WSL2 |
| Node | v24.20.0 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 0,6 % (umbral 10 %) |
| Límite general del API (LIMITE_PEDIDOS_MINUTO) | 1000000000 |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |
### linux-limite-600

| Dato | Valor |
|---|---|
| Fecha | 2026-10-28T00:53:10.549Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 15,1 GiB |
| Sistema | Linux 6.6.87.2-microsoft-standard-WSL2 |
| Node | v24.20.0 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 0,3 % (umbral 10 %) |
| Límite general del API (LIMITE_PEDIDOS_MINUTO) | 600 |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |

## windows-sin-limite: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H2 | 10 | 1489 [1488–1493] | 6,0 | 7,0 | 8,0 | 82 | 0 de 134109 | 84,4 | 13,4 | 416,8 |
| H2 | 50 | 1640 [1637–1643] | 30,0 | 32,0 | 36,0 | 73 | 0 de 147608 | 100,8 | 15,5 | 418,1 |
| H2 | 100 | 1630 [1624–1636] | 60,0 | 64,0 | 72,0 | 162 | 0 de 146706 | 101,4 | 16,1 | 419,4 |

## windows-sin-limite: inicio de sesión bajo carga (H4)

_Sin corridas._

## windows-sin-limite: WebSocket (W1–W2)

_Sin corridas._

Carga de CPU previa de cada corrida: máxima 6,7 % (umbral 10 %); 0 de 9 corridas tuvieron que esperar a que bajara.

## windows-con-limite: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H2 | 10 | 1318 [1314–1324] | 7,0 | 8,0 | 9,0 | 186 | 0 de 118697 | 89,8 | 11,3 | 273,1 |
| H2 | 50 | 1472 [1468–1476] | 33,0 | 36,0 | 40,0 | 126 | 0 de 132486 | 100,4 | 13,7 | 274,6 |
| H2 | 100 | 1460 [1449–1468] | 67,0 | 72,0 | 80,0 | 131 | 0 de 131313 | 101,3 | 14,7 | 275,5 |

## windows-con-limite: inicio de sesión bajo carga (H4)

_Sin corridas._

## windows-con-limite: WebSocket (W1–W2)

_Sin corridas._

Carga de CPU previa de cada corrida: máxima 7,5 % (umbral 10 %); 0 de 9 corridas tuvieron que esperar a que bajara.

## windows-limite-600: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H2 | 10 | 1977 [1971–1986] | 4,0 | 5,0 | 6,0 | 61 | 177443 de 178043 | 63,9 | 16,3 | 256,0 |
| H2 | 50 | 2519 [2514–2526] | 19,0 | 22,0 | 27,0 | 71 | 225533 de 226733 | 82,3 | 21,5 | 262,6 |
| H2 | 100 | 2480 [2473–2485] | 39,0 | 43,0 | 51,0 | 167 | 221897 de 223097 | 77,8 | 21,9 | 270,1 |

## windows-limite-600: inicio de sesión bajo carga (H4)

_Sin corridas._

## windows-limite-600: WebSocket (W1–W2)

_Sin corridas._

Carga de CPU previa de cada corrida: máxima 9,5 % (umbral 10 %); 1 de 9 corridas tuvieron que esperar a que bajara.

## linux-sin-limite: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H2 | 10 | 2494 [2328–2631] | 3,0 | 4,0 | 6,0 | 11 | 0 de 223532 | 102,6 | 16,2 | 408,3 |
| H2 | 50 | 2504 [2429–2642] | 19,0 | 24,0 | 27,0 | 40 | 0 de 227211 | 102,7 | 16,7 | 407,6 |
| H2 | 100 | 2608 [2414–2651] | 37,0 | 41,0 | 46,0 | 69 | 0 de 230132 | 102,9 | 16,9 | 407,9 |

## linux-sin-limite: inicio de sesión bajo carga (H4)

_Sin corridas._

## linux-sin-limite: WebSocket (W1–W2)

_Sin corridas._

Carga de CPU previa de cada corrida: máxima 1,4 % (umbral 10 %); 0 de 9 corridas tuvieron que esperar a que bajara.

## linux-con-limite: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H2 | 10 | 2219 [2210–2223] | 4,0 | 5,0 | 6,0 | 9 | 0 de 199505 | 102,2 | 12,6 | 371,6 |
| H2 | 50 | 2260 [2251–2263] | 21,0 | 23,0 | 26,0 | 34 | 0 de 203183 | 103,0 | 14,8 | 371,6 |
| H2 | 100 | 2190 [2160–2208] | 45,0 | 47,0 | 52,0 | 84 | 0 de 196703 | 103,3 | 14,5 | 372,0 |

## linux-con-limite: inicio de sesión bajo carga (H4)

_Sin corridas._

## linux-con-limite: WebSocket (W1–W2)

_Sin corridas._

Carga de CPU previa de cada corrida: máxima 0,9 % (umbral 10 %); 0 de 9 corridas tuvieron que esperar a que bajara.

## linux-limite-600: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H2 | 10 | 5761 [5688–5801] | 1,0 | 2,0 | 2,0 | 19 | 516883 de 517483 | 100,8 | 19,2 | 302,4 |
| H2 | 50 | 6337 [6292–6373] | 7,0 | 8,0 | 11,0 | 43 | 568796 de 569996 | 100,0 | 16,4 | 321,0 |
| H2 | 100 | 6335 [6252–6375] | 15,0 | 16,0 | 22,0 | 84 | 567616 de 568816 | 100,9 | 16,6 | 336,0 |

## linux-limite-600: inicio de sesión bajo carga (H4)

_Sin corridas._

## linux-limite-600: WebSocket (W1–W2)

_Sin corridas._

Carga de CPU previa de cada corrida: máxima 1,0 % (umbral 10 %); 0 de 9 corridas tuvieron que esperar a que bajara.
