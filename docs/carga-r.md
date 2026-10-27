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

### linux

| Dato | Valor |
|---|---|
| Fecha | 2026-10-27T04:57:19.018Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 15,1 GiB |
| Sistema | Linux 6.6.87.2-microsoft-standard-WSL2 |
| Node | v24.20.0 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 0,4 % (umbral 10 %) |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |
### windows

| Dato | Valor |
|---|---|
| Fecha | 2026-10-27T04:16:38.742Z |
| CPU | AMD Ryzen 9 7900 12-Core Processor (24 hilos) |
| RAM | 31,1 GiB |
| Sistema | Windows_NT 10.0.26300 |
| Node | v24.13.1 |
| autocannon | 8.0.0 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 3,2 % (umbral 10 %) |
| Parámetros | HTTP: 10, 50, 100 conexiones; WS: 10, 50, 100 clientes (W1), 20 × 5 (W2), 2 y 5 cambios/s; 30 s por corrida, 5 s de calentamiento, 3 repeticiones |

## linux: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H1 | 10 | 10992 [10985–11023] | 0,0 | 1,0 | 1,0 | 4 | 0 de 989905 | 100,0 | 51,8 | 310,3 |
| H1 | 50 | 10985 [10948–10986] | 4,0 | 4,0 | 8,0 | 22 | 0 de 987527 | 99,0 | 51,5 | 309,9 |
| H1 | 100 | 10879 [10866–10995] | 9,0 | 9,0 | 14,0 | 159 | 0 de 982167 | 99,3 | 51,7 | 310,1 |
| H2 | 10 | 2580 [2560–2581] | 3,0 | 4,0 | 5,0 | 14 | 0 de 231581 | 102,4 | 16,2 | 442,8 |
| H2 | 50 | 2629 [2611–2644] | 18,0 | 20,0 | 23,0 | 27 | 0 de 236461 | 103,1 | 17,5 | 441,2 |
| H2 | 100 | 2581 [2567–2586] | 38,0 | 40,0 | 45,0 | 57 | 0 de 231969 | 103,4 | 17,3 | 441,5 |
| H3 | 10 | 1733 [1707–1744] | 5,0 | 6,0 | 8,0 | 15 | 0 de 155530 | 106,3 | 13,9 | 466,8 |
| H3 | 50 | 1737 [1727–1738] | 28,0 | 30,0 | 34,0 | 46 | 0 de 156090 | 102,8 | 15,0 | 467,7 |
| H3 | 100 | 1695 [1695–1696] | 58,0 | 61,0 | 67,0 | 74 | 0 de 152590 | 102,4 | 14,9 | 467,0 |

## linux: inicio de sesión bajo carga (H4)

| Conexiones de login | Respuestas del login (todas las repeticiones) | Login pedidos/s | Login p50 ms | Login p99 ms | Sonda H2 sola p50 / p99 ms | Sonda H2 con login p50 / p99 ms | Sonda: fallos o no 2xx | CPU API % |
|---|---|---|---|---|---|---|---|---|
| 10 | 201: 60, 429: 500558 | 5582 [5518–5589] | 1,0 | 2,0 | 0,0 / 1,0 | 3,0 / 5,0 | 0 | 106,8 |
| 50 | 201: 60, 429: 623482 | 6904 [6901–6981] | 6,0 | 11,0 | 0,0 / 1,0 | 14,0 / 21,0 | 0 | 106,2 |
| 100 | 201: 60, 429: 629647 | 7026 [6864–7102] | 13,0 | 20,0 | 0,0 / 1,0 | 27,0 / 42,0 | 0 | 106,8 |

## linux: WebSocket (W1–W2)

| Escenario | Documentos × clientes | Cambios/s por cliente | Cambios/s pedidos | Cambios/s enviados | Entregas/s | p50 ms | p95 ms | p99 ms | Máx ms | Entregas perdidas | Convergió | Cierres | Filas insertadas/s | CPU API % | CPU generadores % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| W1 | 1 × 10 | 2 | 20 | 20 | 180 | 0,7 | 1,0 | 1,2 | 1,9 | 0 de 16200 | 3 de 3 | ninguno | 20 | 2,1 | 1,6 | 474,6 |
| W1 | 1 × 10 | 5 | 50 | 50 | 449 | 0,6 | 0,9 | 1,2 | 14,9 | 0 de 40464 | 3 de 3 | ninguno | 40 | 3,6 | 3,3 | 484,4 |
| W1 | 1 × 50 | 2 | 100 | 100 | 4898 | 1,5 | 2,8 | 10,2 | 33,9 | 0 de 440853 | 3 de 3 | ninguno | 100 | 12,0 | 31,7 | 509,6 |
| W1 | 1 × 50 | 5 | 250 | 249 | 12181 | 4,6 | 80,7 | 110,9 | 230,6 | 0 de 1086183 | 3 de 3 | ninguno | 200 | 33,5 | 133,3 | 628,8 |
| W1 | 1 × 100 | 2 | 200 | 193 | 19100 | 24,9 | 182,5 | 232,1 | 671,0 | 0 de 1698444 | 3 de 3 | ninguno | 193 | 53,0 | 356,7 | 727,8 |
| W1 | 1 × 100 | 5 | 500 | 175 | 17355 | 339,3 | 747,4 | 994,4 | 2829,7 | 0 de 1603800 | 3 de 3 | ninguno | 153 | 67,9 | 386,5 | 943,9 |
| W2 | 20 × 5 | 2 | 200 | 200 | 800 | 0,4 | 0,7 | 1,3 | 6,1 | 0 de 71984 | 3 de 3 | ninguno | 200 | 10,9 | 11,6 | 919,4 |
| W2 | 20 × 5 | 5 | 500 | 500 | 1999 | 0,5 | 1,5 | 4,5 | 28,7 | 0 de 179940 | 3 de 3 | ninguno | 400 | 23,2 | 27,1 | 881,1 |

Carga de CPU previa de cada corrida: máxima 3,5 % (umbral 10 %); 0 de 60 corridas tuvieron que esperar a que bajara.

## windows: HTTP (H1–H3)

| Escenario | Conexiones | Pedidos/s, mediana [mín–máx] | p50 ms | p90 ms | p99 ms | Máx ms | Fallos o no 2xx | CPU API % | CPU cliente % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| H1 | 10 | 2577 [2555–2583] | 3,0 | 4,0 | 4,0 | 101 | 0 de 231384 | 44,7 | 19,3 | 191,8 |
| H1 | 50 | 3352 [3343–3406] | 14,0 | 15,0 | 19,0 | 137 | 0 de 302966 | 79,0 | 28,6 | 240,5 |
| H1 | 100 | 3352 [3307–3366] | 29,0 | 31,0 | 37,0 | 175 | 0 de 300706 | 79,6 | 27,1 | 243,2 |
| H2 | 10 | 1503 [1495–1546] | 6,0 | 7,0 | 8,0 | 68 | 0 de 136313 | 84,1 | 13,4 | 308,6 |
| H2 | 50 | 1638 [1632–1687] | 30,0 | 32,0 | 37,0 | 90 | 0 de 148710 | 100,6 | 14,9 | 309,5 |
| H2 | 100 | 1636 [1631–1654] | 60,0 | 64,0 | 74,0 | 135 | 0 de 147633 | 100,4 | 14,7 | 309,4 |
| H3 | 10 | 1142 [1140–1146] | 8,0 | 9,0 | 12,0 | 137 | 0 de 102841 | 108,6 | 12,2 | 333,4 |
| H3 | 50 | 1199 [1198–1200] | 41,0 | 44,0 | 49,0 | 166 | 0 de 107917 | 103,9 | 13,9 | 334,5 |
| H3 | 100 | 1199 [1193–1205] | 82,0 | 87,0 | 97,0 | 154 | 0 de 107921 | 100,8 | 14,2 | 336,1 |

## windows: inicio de sesión bajo carga (H4)

| Conexiones de login | Respuestas del login (todas las repeticiones) | Login pedidos/s | Login p50 ms | Login p99 ms | Sonda H2 sola p50 / p99 ms | Sonda H2 con login p50 / p99 ms | Sonda: fallos o no 2xx | CPU API % |
|---|---|---|---|---|---|---|---|---|
| 10 | 201: 60, 429: 119988 | 1338 [1318–1346] | 7,0 | 8,0 | 4,0 / 5,0 | 6,0 / 8,0 | 0 | 61,3 |
| 50 | 201: 60, 429: 162399 | 1808 [1785–1822] | 27,0 | 36,0 | 4,0 / 5,0 | 52,0 / 65,0 | 0 | 70,5 |
| 100 | 201: 60, 429: 166396 | 1839 [1838–1872] | 53,0 | 66,0 | 4,0 / 5,0 | 105,0 / 180,0 | 0 | 65,5 |

## windows: WebSocket (W1–W2)

| Escenario | Documentos × clientes | Cambios/s por cliente | Cambios/s pedidos | Cambios/s enviados | Entregas/s | p50 ms | p95 ms | p99 ms | Máx ms | Entregas perdidas | Convergió | Cierres | Filas insertadas/s | CPU API % | CPU generadores % | RSS API máx MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| W1 | 1 × 10 | 2 | 20 | 20 | 176 | 0,9 | 1,3 | 1,6 | 4,6 | 0 de 15858 | 3 de 3 | ninguno | 20 | 2,1 | 1,1 | 329,3 |
| W1 | 1 × 10 | 5 | 50 | 49 | 444 | 1,0 | 1,5 | 1,8 | 14,1 | 0 de 39924 | 3 de 3 | ninguno | 39 | 4,5 | 3,0 | 342,5 |
| W1 | 1 × 50 | 2 | 100 | 98 | 4804 | 4,5 | 9,0 | 19,1 | 38,7 | 0 de 432474 | 3 de 3 | ninguno | 98 | 20,5 | 30,8 | 360,1 |
| W1 | 1 × 50 | 5 | 250 | 243 | 11886 | 9,5 | 78,5 | 111,1 | 175,2 | 0 de 1068249 | 3 de 3 | ninguno | 171 | 58,5 | 125,3 | 688,2 |
| W1 | 1 × 100 | 2 | 200 | 197 | 19513 | 31,8 | 208,6 | 241,8 | 312,2 | 0 de 1752498 | 3 de 3 | ninguno | 124 | 97,5 | 334,9 | 820,9 |
| W1 | 1 × 100 | 5 | 500 | 207 | 20460 | 280,9 | 887,3 | 1059,3 | 1611,6 | 0 de 1843578 | 3 de 3 | ninguno | 74 | 98,4 | 364,1 | 955,2 |
| W2 | 20 × 5 | 2 | 200 | 196 | 783 | 1,9 | 4,3 | 5,4 | 10,1 | 0 de 70420 | 3 de 3 | ninguno | 197 | 11,4 | 11,7 | 886,3 |
| W2 | 20 × 5 | 5 | 500 | 493 | 1971 | 4,1 | 10,2 | 13,2 | 20,1 | 0 de 177240 | 3 de 3 | ninguno | 387 | 21,6 | 23,6 | 864,8 |

Carga de CPU previa de cada corrida: máxima 9,1 % (umbral 10 %); 2 de 60 corridas tuvieron que esperar a que bajara.
