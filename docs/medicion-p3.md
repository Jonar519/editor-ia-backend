# Medición P3 · gRPC frente a REST/JSON (enlace API ↔ servicio de IA)

> Generado por `scripts/medicion/medir.ts` (`npm run medir`) a partir de `docs/medicion-p3.json`. No se edita a mano.

## Lo que esta medición NO permite concluir

- **Nada sobre la latencia que vería la persona.** El proveedor es el simulado, que responde sin esperas (0 ms): un modelo real tarda cientos de milisegundos o segundos, órdenes de magnitud más que cualquier diferencia de transporte de aquí. *No medido: la latencia de un proveedor real.*
- **Nada sobre una red real.** Todo va por loopback (127.0.0.1): sin latencia de red, sin pérdida de paquetes, sin ancho de banda limitado. *No medido: red real, varias máquinas, balanceadores o proxies.*
- **Nada sobre TLS.** Los dos caminos van en texto plano (gRPC inseguro, HTTP/1.1 y h2c). *No medido: el costo de TLS (mutuo o no).*
- **Nada sobre máquinas separadas.** Cliente y servidor corren en la misma máquina y compiten por la misma CPU.
- Tampoco: la compresión (ni la de gRPC ni gzip en JSON), la memoria a largo plazo, el costo del stack Express del API (se comparan transportes, no frameworks) ni el enlace navegador ↔ API. Todos *no medidos*.
- Los números son de **esta** máquina y de este momento; otra máquina da otros números. Las conclusiones de abajo son solo las que los datos de esta tabla muestran.
- **La corrida de Windows no sirve para comparar transportes** (ver el diagnóstico que sigue): se presenta solo como comportamiento observado en este entorno. **La referencia para comparar transportes es la corrida de Linux.**

## Diagnóstico del entorno: piso de latencia en Windows

Antes de medir, un diagnóstico aparte (2 000 llamadas en serie, tres pasadas, servidor en otro proceso) encontró en **Windows** un piso de unos 2–3 ms por llamada en gRPC con mensajes chicos y en REST sobre HTTP/1.1 (en ese diagnóstico, REST h2c no lo tuvo), que **no apareció en Linux** en la misma máquina (contenedor). No era calentamiento (las tres pasadas daban lo mismo) ni se debía a `noDelay` en los sockets del cliente. **Su causa no se investigó** (decisión escrita): corregirlo exigiría cambiar la configuración TCP del sistema. Cuáles caminos lo tienen puede variar entre corridas; la línea calculada debajo de la tabla dice cuáles lo tuvieron en **esta** medición.

Los p50 en serie de **esta** medición, por tamaño de pedido (mediana de las repeticiones, ms):

| Entorno | Camino | Explicar 100 B | Explicar 8 KB | Explicar 64 KB |
|---|---|---|---|---|
| windows | A · gRPC, 1 canal | 2,943 | 0,335 | 0,751 |
| windows | B · REST 1.1, c conexiones | 3,490 | 2,396 | 2,882 |
| windows | C · REST h2c, 1 sesión | 3,639 | 2,547 | 3,233 |
| linux | A · gRPC, 1 canal | 0,296 | 0,332 | 0,670 |
| linux | B · REST 1.1, c conexiones | 0,190 | 0,236 | 0,517 |
| linux | C · REST h2c, 1 sesión | 0,215 | 0,259 | 0,622 |

- Calculado, windows: p50 en serie de 1 ms o más en A · gRPC, 1 canal con 100B; B · REST 1.1, c conexiones con 100B; B · REST 1.1, c conexiones con 8KB; B · REST 1.1, c conexiones con 64KB; C · REST h2c, 1 sesión con 100B; C · REST h2c, 1 sesión con 8KB; C · REST h2c, 1 sesión con 64KB.
- Calculado, linux: p50 en serie de 1 ms o más en ningún caso.

## Cómo se midió

- **La misma operación por los dos caminos, en el mismo proceso servidor.** El gRPC es el servicio real (`crearServicioIa`, con su interceptor de token). El REST/JSON es **un adaptador que vive en `scripts/medicion/` (no en el servicio de producción) y corre en el mismo proceso que el gRPC real, sobre `node:http` (HTTP/1.1) y `node:http2` (h2c), sin Express**. Llama a las mismas funciones: `validarOrigen`, `texto`, el mismo proveedor y `verificarVectores`.
- **Mismo trabajo por pedido**: token Bearer comparado en tiempo constante, validación del origen y del contenido, log en `silent`, y un tiempo máximo por pedido en los tres clientes (como el deadline de gRPC).
- **Proveedor**: el simulado sin esperas, con **vectores densos** en U1 (las 1024 dimensiones distintas de cero, como los de un modelo real; los del simulado son dispersos y favorecerían a JSON, que escribe cada cero como `0`). Los vectores viajan como float de 32 bits en los dos caminos (protobuf `float`; en JSON, `Math.fround`).
- **Solo para medir**: el tope de caracteres de Explicar se sube a 70 000 para el pedido de 64 KB (en producción es 20 000).
- **Caminos**: A gRPC (HTTP/2 + protobuf, 1 canal); B REST sobre HTTP/1.1 keep-alive con *c* conexiones; C REST sobre HTTP/2 sin TLS con 1 sesión. A frente a C aísla protobuf frente a JSON; B frente a C, HTTP/2 multiplexado frente a HTTP/1.1. Con *c* > 1, además: A* gRPC con *c* canales (conexiones separadas) y B1 REST 1.1 con 1 conexión (pedidos en cola).
- **Métricas**: latencia con `process.hrtime`, percentiles **exactos** (rango más cercano sobre todas las muestras); en concurrencia, lazo cerrado con *c* pedidos en vuelo y pedidos por segundo; CPU del cliente (`process.cpuUsage` del medidor) y del servidor (`process.cpuUsage` del proceso servidor, pedido por IPC), en ms de CPU por cada 1 000 llamadas.
- **Tamaños**: cuerpo serializado (protobuf y JSON) y **bytes en el cable** por llamada, contados por un proxy TCP (cabeceras, marcos de HTTP/2 y compresión HPACK incluidos) sobre 200 llamadas. El proxy solo se usa para los tamaños, no para los tiempos.
- **Repeticiones**: cada escenario se corre varias veces alternando el orden de los caminos; las tablas dan la **mediana** de las repeticiones y, para el p50, su rango (mínimo–máximo).
- **Carga ajena**: antes de empezar se mide la carga de CPU de la máquina (5 s) y no se mide si pasa del umbral; antes de cada corrida se vuelve a registrar (300 ms).

## Entorno: windows

> **Solo comportamiento observado en este entorno**: con el piso de latencia del diagnóstico, no sirve para comparar transportes.

| | |
|---|---|
| etiqueta | windows |
| fecha | 2026-10-23T18:52:26.524Z |
| cpu | AMD Ryzen 9 7900 12-Core Processor |
| hilos | 24 |
| ramGiB | 31.1 |
| sistema | Windows_NT 10.0.26300 |
| node | v24.13.1 |
| grpcJs | 1.14.6 |
| cargaInicial | 7.5 |
| umbral | 10 |
| forzado | false |
| rapido | false |
| parámetros | calentamiento 500, en serie 5000, en concurrencia 20000 con c = 1, 8, 32, 128, 5 repeticiones |
| carga previa por corrida | máxima 17,0 %, mediana 3,5 %; 28 de 525 corridas sobre el umbral de 10 % (**esta corrida solo REGISTRABA la carga previa; no esperaba a que bajara**: las que figuran sobre el umbral se midieron así) |

### Tamaños (windows)

| Operación | Cuerpo protobuf pedido / respuesta (B) | Cuerpo JSON pedido / respuesta (B) | Cable gRPC (B) | Cable REST 1.1 (B) | Cable REST h2c (B) |
|---|---|---|---|---|---|
| U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) | 143 / 4105 | 224 / 21590 | 251 / 4144 | 417 / 21747 | 309 / 21634 |
| U2 · Explicar, pedido de 100 B | 233 / 145 | 327 / 195 | 334 / 184 | 521 / 352 | 407 / 231 |
| U2 · Explicar, pedido de 8 KB | 8326 / 145 | 8419 / 195 | 8427 / 190 | 8614 / 356 | 8499 / 238 |
| U2 · Explicar, pedido de 64 KB | 65671 / 145 | 65763 / 195 | 65808 / 240 | 65959 / 357 | 65881 / 287 |
| S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) | 8326 / 372 | 8436 / 1364 | 8426 / 876 | 8599 / 1819 | 8485 / 1496 |

Cable = bytes por llamada en el socket, pedido / respuesta, con todo lo del transporte. En S1, la respuesta suma los 31 fragmentos y el final.

### En serie, 1 pedido en vuelo (windows)

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats)

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 3,334 (0,491–3,418) | 4,255 | 5,083 | 7,004 | 284,4 | 606,2 |
| B · REST 1.1, c conexiones | 4,531 (4,525–4,585) | 5,867 | 6,854 | 9,472 | 309,4 | 528,0 |
| C · REST h2c, 1 sesión | 4,654 (0,515–4,688) | 5,973 | 6,959 | 8,935 | 309,4 | 618,8 |

#### U2 · Explicar, pedido de 100 B

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 2,943 (0,282–2,962) | 3,599 | 4,447 | 7,662 | 253,0 | 275,0 |
| B · REST 1.1, c conexiones | 3,490 (3,447–3,524) | 4,336 | 5,237 | 37,976 | 118,8 | 153,2 |
| C · REST h2c, 1 sesión | 3,639 (3,601–3,668) | 4,487 | 5,539 | 12,581 | 162,6 | 247,0 |

#### U2 · Explicar, pedido de 8 KB

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 0,335 (0,326–2,968) | 0,508 | 0,651 | 1,804 | 243,6 | 259,4 |
| B · REST 1.1, c conexiones | 2,396 (2,365–2,405) | 3,079 | 3,672 | 8,910 | 162,4 | 172,0 |
| C · REST h2c, 1 sesión | 2,547 (2,544–2,570) | 3,240 | 3,909 | 8,764 | 175,0 | 240,6 |

#### U2 · Explicar, pedido de 64 KB

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 0,751 (0,731–3,721) | 1,247 | 2,469 | 22,357 | 550,0 | 834,4 |
| B · REST 1.1, c conexiones | 2,882 (2,881–2,947) | 3,599 | 4,197 | 11,086 | 271,8 | 462,4 |
| C · REST h2c, 1 sesión | 3,233 (0,610–3,254) | 4,015 | 4,639 | 23,019 | 331,2 | 668,8 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos)

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 3,618 (0,861–3,636) | 4,510 | 5,242 | 7,757 | 1,765 | 487,6 | 1150,0 |
| B · REST 1.1, c conexiones | 2,514 (2,498–2,534) | 3,173 | 3,822 | 6,396 | 2,491 | 196,8 | 221,8 |
| C · REST h2c, 1 sesión | 2,890 (0,270–2,933) | 3,636 | 4,319 | 6,692 | 1,535 | 168,8 | 259,4 |

### En concurrencia, lazo cerrado (windows)

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1804 | 0,485 (0,480–3,315) | 0,704 | 0,953 | 17,709 | 240,7 | 456,3 |
| B · REST 1.1, c conexiones | 214 | 4,524 (4,513–4,548) | 5,934 | 7,252 | 26,224 | 241,4 | 500,0 |
| C · REST h2c, 1 sesión | 208 | 4,640 (0,517–4,648) | 6,018 | 7,319 | 21,986 | 262,5 | 600,1 |

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 2624 | 2,683 (2,585–2,714) | 3,732 | 9,921 | 15,176 | 128,9 | 342,2 |
| A* · gRPC, c canales | 2758 | 2,537 (2,498–2,582) | 4,279 | 9,889 | 19,742 | 196,9 | 389,8 |
| B · REST 1.1, c conexiones | 1058 | 7,296 (7,070–7,356) | 8,924 | 14,035 | 35,061 | 243,8 | 539,1 |
| B1 · REST 1.1, 1 conexión | 227 | 34,394 (32,543–35,699) | 42,548 | 48,776 | 66,927 | 216,4 | 471,9 |
| C · REST h2c, 1 sesión | 1910 | 3,879 (3,542–33,301) | 4,761 | 12,627 | 25,631 | 188,3 | 442,2 |

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 417 | 76,043 (9,298–76,566) | 86,216 | 94,669 | 110,932 | 158,6 | 391,4 |
| A* · gRPC, c canales | 2813 | 10,473 (10,433–10,632) | 18,004 | 19,739 | 29,963 | 196,9 | 392,2 |
| B · REST 1.1, c conexiones | 1451 | 21,036 (20,941–21,119) | 28,589 | 30,972 | 40,730 | 295,3 | 704,8 |
| B1 · REST 1.1, 1 conexión | 240 | 132,397 (131,967–133,531) | 146,362 | 158,159 | 171,950 | 199,2 | 468,0 |
| C · REST h2c, 1 sesión | 2017 | 14,727 (14,588–14,846) | 23,044 | 24,552 | 30,637 | 181,3 | 418,8 |

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 412 | 309,458 (42,113–310,626) | 332,347 | 353,203 | 429,146 | 174,3 | 403,2 |
| A* · gRPC, c canales | 2673 | 48,824 (48,219–49,431) | 58,840 | 67,581 | 78,074 | 198,4 | 415,7 |
| B · REST 1.1, c conexiones | 1431 | 88,800 (86,912–90,061) | 98,857 | 165,978 | 237,722 | 297,7 | 702,4 |
| B1 · REST 1.1, 1 conexión | 239 | 534,139 (533,084–537,137) | 569,164 | 586,632 | 599,780 | 196,9 | 482,8 |
| C · REST h2c, 1 sesión | 2001 | 64,132 (62,696–65,156) | 71,072 | 75,975 | 105,938 | 199,3 | 439,9 |

#### U2 · Explicar, pedido de 100 B · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 357 | 2,730 (0,267–2,748) | 3,291 | 4,137 | 13,452 | 254,7 | 246,9 |
| B · REST 1.1, c conexiones | 301 | 3,244 (3,227–3,261) | 3,862 | 4,873 | 52,706 | 115,6 | 142,2 |
| C · REST h2c, 1 sesión | 289 | 3,385 (3,382–3,407) | 4,010 | 5,065 | 28,465 | 171,9 | 214,9 |

#### U2 · Explicar, pedido de 100 B · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 433 | 18,259 (0,881–18,517) | 20,952 | 25,215 | 53,813 | 126,6 | 114,1 |
| A* · gRPC, c canales | 7039 | 1,055 (1,051–1,063) | 1,408 | 3,395 | 10,651 | 141,4 | 140,6 |
| B · REST 1.1, c conexiones | 1445 | 5,423 (5,398–5,553) | 5,993 | 6,754 | 122,738 | 118,0 | 157,8 |
| B1 · REST 1.1, 1 conexión | 304 | 26,013 (25,548–26,402) | 29,580 | 34,584 | 50,447 | 111,7 | 140,6 |
| C · REST h2c, 1 sesión | 332 | 23,825 (0,465–25,415) | 27,262 | 31,721 | 43,445 | 62,5 | 78,1 |

#### U2 · Explicar, pedido de 100 B · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 445 | 71,754 (70,528–72,330) | 78,673 | 89,425 | 95,262 | 110,2 | 86,0 |
| A* · gRPC, c canales | 7401 | 4,100 (4,090–4,105) | 6,243 | 9,475 | 15,755 | 138,3 | 132,1 |
| B · REST 1.1, c conexiones | 2259 | 14,028 (13,967–14,087) | 16,035 | 18,183 | 47,869 | 145,3 | 282,1 |
| B1 · REST 1.1, 1 conexión | 305 | 103,894 (103,174–104,505) | 113,236 | 125,076 | 136,452 | 111,7 | 147,7 |
| C · REST h2c, 1 sesión | 20883 | 1,393 (1,377–1,411) | 1,856 | 4,516 | 11,864 | 28,9 | 39,8 |

#### U2 · Explicar, pedido de 100 B · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 10325 | 11,911 (11,790–289,015) | 16,744 | 17,705 | 21,294 | 72,7 | 60,9 |
| A* · gRPC, c canales | 7407 | 16,775 (16,670–16,888) | 23,151 | 27,927 | 32,599 | 144,5 | 139,1 |
| B · REST 1.1, c conexiones | 2254 | 56,104 (55,813–56,952) | 61,887 | 68,877 | 91,056 | 154,7 | 294,5 |
| B1 · REST 1.1, 1 conexión | 305 | 417,824 (415,131–421,014) | 446,750 | 468,391 | 472,170 | 112,4 | 136,0 |
| C · REST h2c, 1 sesión | 23108 | 5,370 (5,323–5,414) | 6,862 | 8,494 | 10,906 | 25,8 | 38,3 |

#### U2 · Explicar, pedido de 8 KB · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 353 | 2,756 (0,317–2,780) | 3,307 | 4,191 | 10,698 | 258,6 | 289,0 |
| B · REST 1.1, c conexiones | 435 | 2,242 (2,217–2,253) | 2,668 | 3,398 | 4,877 | 134,4 | 169,5 |
| C · REST h2c, 1 sesión | 414 | 2,356 (0,227–2,372) | 2,801 | 3,517 | 5,416 | 175,0 | 239,9 |

#### U2 · Explicar, pedido de 8 KB · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 6243 | 1,197 (1,171–18,845) | 1,852 | 3,066 | 19,405 | 132,8 | 157,0 |
| A* · gRPC, c canales | 5742 | 1,322 (1,313–1,334) | 1,868 | 2,565 | 7,068 | 175,8 | 182,9 |
| B · REST 1.1, c conexiones | 2121 | 3,710 (3,702–3,718) | 4,109 | 4,596 | 20,551 | 136,7 | 196,1 |
| B1 · REST 1.1, 1 conexión | 443 | 17,822 (17,655–17,962) | 20,176 | 23,418 | 33,793 | 124,2 | 168,8 |
| C · REST h2c, 1 sesión | 8944 | 0,763 (0,749–16,117) | 1,395 | 2,359 | 5,295 | 68,8 | 110,9 |

#### U2 · Explicar, pedido de 8 KB · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 6657 | 4,515 (4,448–76,182) | 7,751 | 9,702 | 14,655 | 123,4 | 153,1 |
| A* · gRPC, c canales | 5958 | 5,167 (5,146–5,237) | 6,695 | 9,602 | 13,358 | 160,1 | 173,4 |
| B · REST 1.1, c conexiones | 3061 | 10,301 (10,213–10,355) | 11,462 | 13,271 | 18,440 | 185,9 | 296,2 |
| B1 · REST 1.1, 1 conexión | 446 | 71,026 (70,367–71,465) | 78,039 | 90,319 | 108,586 | 126,6 | 162,5 |
| C · REST h2c, 1 sesión | 10814 | 2,742 (2,683–2,767) | 3,978 | 5,410 | 9,183 | 60,2 | 94,6 |

#### U2 · Explicar, pedido de 8 KB · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 6589 | 18,684 (18,231–308,519) | 24,883 | 28,319 | 31,371 | 140,6 | 156,2 |
| A* · gRPC, c canales | 5692 | 21,786 (21,562–22,258) | 29,558 | 32,708 | 39,381 | 168,0 | 193,0 |
| B · REST 1.1, c conexiones | 3057 | 41,348 (41,283–41,391) | 45,556 | 50,216 | 56,676 | 189,9 | 290,7 |
| B1 · REST 1.1, 1 conexión | 443 | 287,454 (285,599–290,057) | 307,989 | 331,018 | 345,899 | 135,9 | 164,9 |
| C · REST h2c, 1 sesión | 10426 | 11,839 (11,715–12,044) | 15,184 | 17,542 | 20,479 | 67,2 | 99,2 |

#### U2 · Explicar, pedido de 64 KB · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 288 | 3,364 (3,341–3,383) | 4,227 | 5,043 | 11,166 | 482,8 | 859,3 |
| B · REST 1.1, c conexiones | 363 | 2,692 (2,685–2,708) | 3,220 | 3,937 | 10,288 | 246,1 | 420,3 |
| C · REST h2c, 1 sesión | 1488 | 0,590 (0,589–3,021) | 0,843 | 1,277 | 23,035 | 302,4 | 520,3 |

#### U2 · Explicar, pedido de 64 KB · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 320 | 24,578 (4,019–25,026) | 28,186 | 33,300 | 44,704 | 465,6 | 598,4 |
| A* · gRPC, c canales | 1877 | 4,175 (4,151–4,215) | 4,900 | 5,584 | 12,014 | 389,1 | 441,4 |
| B · REST 1.1, c conexiones | 1812 | 4,314 (4,303–4,333) | 4,919 | 5,522 | 29,232 | 258,6 | 483,5 |
| B1 · REST 1.1, 1 conexión | 376 | 20,970 (20,823–21,076) | 23,513 | 27,823 | 58,316 | 213,3 | 411,8 |
| C · REST h2c, 1 sesión | 2081 | 3,787 (3,749–3,833) | 4,548 | 5,066 | 8,974 | 249,2 | 423,4 |

#### U2 · Explicar, pedido de 64 KB · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1924 | 16,364 (16,308–102,289) | 18,923 | 20,523 | 25,149 | 382,9 | 450,0 |
| A* · gRPC, c canales | 2343 | 13,610 (13,282–13,963) | 16,684 | 18,508 | 25,070 | 322,6 | 421,9 |
| B · REST 1.1, c conexiones | 1956 | 16,251 (16,184–16,332) | 18,497 | 20,897 | 159,997 | 282,8 | 512,5 |
| B1 · REST 1.1, 1 conexión | 378 | 84,014 (83,667–84,280) | 91,272 | 102,760 | 122,189 | 235,2 | 421,9 |
| C · REST h2c, 1 sesión | 2024 | 15,673 (15,410–16,357) | 17,913 | 19,993 | 26,659 | 261,7 | 441,4 |

#### U2 · Explicar, pedido de 64 KB · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1742 | 71,328 (70,774–409,395) | 85,899 | 90,917 | 102,276 | 389,1 | 550,8 |
| A* · gRPC, c canales | 2172 | 58,705 (57,843–63,773) | 76,859 | 88,537 | 103,819 | 323,5 | 496,9 |
| B · REST 1.1, c conexiones | 1949 | 65,307 (64,890–67,278) | 71,721 | 79,349 | 461,251 | 297,6 | 517,2 |
| B1 · REST 1.1, 1 conexión | 375 | 339,862 (336,900–346,517) | 362,835 | 377,208 | 386,254 | 273,5 | 422,7 |
| C · REST h2c, 1 sesión | 1902 | 66,726 (65,979–68,135) | 73,159 | 77,353 | 83,285 | 275,8 | 513,3 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 283 | 3,427 (0,862–3,766) | 4,231 | 5,103 | 9,544 | 1,672 | 446,1 | 1105,5 |
| B · REST 1.1, c conexiones | 403 | 2,409 (2,389–2,698) | 2,949 | 3,605 | 4,950 | 2,388 | 171,9 | 229,7 |
| C · REST h2c, 1 sesión | 353 | 2,746 (2,739–3,118) | 3,368 | 4,234 | 14,302 | 1,466 | 203,9 | 314,1 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 378 | 20,813 (2,140–21,416) | 23,875 | 27,104 | 36,180 | 12,972 | 282,1 | 439,1 |
| A* · gRPC, c canales | 1526 | 5,175 (5,133–5,189) | 5,832 | 6,635 | 12,299 | 0,539 | 535,2 | 659,4 |
| B · REST 1.1, c conexiones | 2068 | 3,824 (3,813–3,857) | 4,235 | 4,672 | 5,643 | 3,802 | 191,4 | 250,7 |
| B1 · REST 1.1, 1 conexión | 425 | 18,601 (18,458–19,008) | 21,042 | 24,836 | 34,865 | 18,549 | 157,0 | 205,5 |
| C · REST h2c, 1 sesión | 7189 | 1,051 (1,023–17,439) | 1,498 | 1,994 | 11,432 | 0,651 | 92,1 | 119,6 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 373 | 84,989 (7,962–86,258) | 92,708 | 104,874 | 120,886 | 77,027 | 302,4 | 466,4 |
| A* · gRPC, c canales | 1488 | 21,275 (21,047–21,472) | 22,989 | 26,024 | 30,480 | 0,615 | 550,8 | 674,2 |
| B · REST 1.1, c conexiones | 2818 | 11,159 (11,057–11,580) | 12,720 | 14,944 | 19,292 | 11,131 | 232,8 | 346,1 |
| B1 · REST 1.1, 1 conexión | 418 | 75,650 (75,169–78,029) | 83,518 | 94,241 | 111,929 | 75,596 | 175,0 | 211,7 |
| C · REST h2c, 1 sesión | 7562 | 4,100 (4,061–4,161) | 5,762 | 7,592 | 12,473 | 3,469 | 77,4 | 124,2 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 362 | 351,858 (30,907–354,823) | 379,420 | 391,168 | 408,336 | 343,602 | 346,1 | 522,7 |
| A* · gRPC, c canales | 1446 | 87,229 (86,782–87,600) | 96,381 | 102,368 | 114,776 | 2,264 | 560,2 | 697,7 |
| B · REST 1.1, c conexiones | 2774 | 45,599 (45,533–45,707) | 50,379 | 55,751 | 62,007 | 45,570 | 244,5 | 350,0 |
| B1 · REST 1.1, 1 conexión | 412 | 308,771 (306,100–310,166) | 331,418 | 353,501 | 363,419 | 308,719 | 174,2 | 223,5 |
| C · REST h2c, 1 sesión | 7453 | 16,748 (16,569–16,899) | 20,549 | 23,701 | 27,465 | 16,084 | 78,1 | 128,1 |

## Entorno: linux

> **Referencia para comparar transportes.**

| | |
|---|---|
| etiqueta | linux |
| fecha | 2026-10-23T19:48:12.759Z |
| cpu | AMD Ryzen 9 7900 12-Core Processor |
| hilos | 24 |
| ramGiB | 15.1 |
| sistema | Linux 6.6.87.2-microsoft-standard-WSL2 |
| node | v24.20.0 |
| grpcJs | 1.14.6 |
| cargaInicial | 0.4 |
| umbral | 10 |
| forzado | false |
| rapido | false |
| parámetros | calentamiento 500, en serie 5000, en concurrencia 20000 con c = 1, 8, 32, 128, 5 repeticiones |
| carga previa por corrida | máxima 4,7 %, mediana 0,1 %; 0 de 525 corridas sobre el umbral de 10 % (se esperó a que bajara antes de 0 corridas; ninguna se midió por encima) |

### Tamaños (linux)

| Operación | Cuerpo protobuf pedido / respuesta (B) | Cuerpo JSON pedido / respuesta (B) | Cable gRPC (B) | Cable REST 1.1 (B) | Cable REST h2c (B) |
|---|---|---|---|---|---|
| U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) | 143 / 4105 | 224 / 21590 | 250 / 4145 | 417 / 21747 | 308 / 21635 |
| U2 · Explicar, pedido de 100 B | 233 / 145 | 327 / 195 | 333 / 185 | 521 / 352 | 406 / 232 |
| U2 · Explicar, pedido de 8 KB | 8326 / 145 | 8419 / 195 | 8426 / 191 | 8614 / 356 | 8498 / 239 |
| U2 · Explicar, pedido de 64 KB | 65671 / 145 | 65763 / 195 | 65807 / 241 | 65959 / 357 | 65879 / 288 |
| S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) | 8326 / 372 | 8436 / 1364 | 8425 / 877 | 8599 / 1819 | 8484 / 1497 |

Cable = bytes por llamada en el socket, pedido / respuesta, con todo lo del transporte. En S1, la respuesta suma los 31 fragmentos y el final.

### En serie, 1 pedido en vuelo (linux)

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats)

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 0,485 (0,471–0,519) | 0,720 | 1,348 | 13,501 | 263,0 | 456,0 |
| B · REST 1.1, c conexiones | 0,448 (0,434–0,465) | 0,612 | 0,778 | 15,913 | 189,1 | 393,8 |
| C · REST h2c, 1 sesión | 0,493 (0,483–0,497) | 0,673 | 1,574 | 18,638 | 279,6 | 463,6 |

#### U2 · Explicar, pedido de 100 B

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 0,296 (0,288–0,311) | 0,412 | 0,539 | 7,225 | 202,7 | 214,7 |
| B · REST 1.1, c conexiones | 0,190 (0,187–0,191) | 0,255 | 0,328 | 5,475 | 118,5 | 113,0 |
| C · REST h2c, 1 sesión | 0,215 (0,214–0,216) | 0,288 | 0,380 | 4,509 | 136,9 | 148,7 |

#### U2 · Explicar, pedido de 8 KB

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 0,332 (0,321–0,334) | 0,474 | 0,634 | 9,018 | 236,2 | 251,8 |
| B · REST 1.1, c conexiones | 0,236 (0,235–0,237) | 0,316 | 0,410 | 1,976 | 136,4 | 146,0 |
| C · REST h2c, 1 sesión | 0,259 (0,258–0,259) | 0,353 | 0,458 | 2,323 | 153,5 | 183,2 |

#### U2 · Explicar, pedido de 64 KB

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 0,670 (0,665–0,678) | 0,990 | 1,994 | 3,707 | 450,6 | 612,3 |
| B · REST 1.1, c conexiones | 0,517 (0,515–0,524) | 0,700 | 0,886 | 1,206 | 206,1 | 380,9 |
| C · REST h2c, 1 sesión | 0,622 (0,614–0,650) | 0,829 | 1,158 | 2,261 | 270,4 | 479,3 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos)

| Camino | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 0,574 (0,569–0,583) | 0,781 | 1,243 | 7,521 | 0,277 | 438,0 | 501,2 |
| B · REST 1.1, c conexiones | 0,292 (0,290–0,293) | 0,376 | 0,532 | 1,409 | 0,272 | 154,6 | 179,1 |
| C · REST h2c, 1 sesión | 0,268 (0,267–0,269) | 0,367 | 0,501 | 4,205 | 0,241 | 161,9 | 215,9 |

### En concurrencia, lazo cerrado (linux)

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1828 | 0,464 (0,455–0,487) | 0,639 | 1,583 | 12,802 | 241,2 | 439,7 |
| B · REST 1.1, c conexiones | 1985 | 0,427 (0,415–0,461) | 0,562 | 0,737 | 23,784 | 179,1 | 396,8 |
| C · REST h2c, 1 sesión | 1792 | 0,479 (0,470–0,507) | 0,643 | 1,467 | 24,900 | 265,5 | 453,2 |

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 2757 | 2,392 (2,364–2,406) | 5,245 | 11,934 | 17,434 | 131,5 | 326,3 |
| A* · gRPC, c canales | 2877 | 2,243 (2,206–2,251) | 5,290 | 13,044 | 22,359 | 194,2 | 380,3 |
| B · REST 1.1, c conexiones | 2813 | 2,004 (1,942–2,054) | 4,438 | 18,824 | 29,961 | 163,6 | 381,3 |
| B1 · REST 1.1, 1 conexión | 2199 | 3,173 (3,048–3,221) | 4,227 | 16,822 | 30,600 | 182,4 | 403,6 |
| C · REST h2c, 1 sesión | 2049 | 3,354 (3,288–3,496) | 4,754 | 19,137 | 38,405 | 217,2 | 400,9 |

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 3121 | 8,396 (8,295–8,465) | 19,405 | 23,505 | 46,385 | 130,8 | 324,6 |
| A* · gRPC, c canales | 2898 | 9,226 (8,949–9,406) | 22,346 | 26,543 | 45,382 | 190,4 | 384,5 |
| B · REST 1.1, c conexiones | 2723 | 9,039 (8,492–9,979) | 28,938 | 36,659 | 53,774 | 166,8 | 394,1 |
| B1 · REST 1.1, 1 conexión | 2050 | 13,138 (12,665–14,072) | 30,521 | 35,303 | 46,451 | 185,7 | 439,6 |
| C · REST h2c, 1 sesión | 1819 | 14,466 (13,839–14,726) | 38,472 | 46,351 | 56,468 | 195,2 | 463,7 |

#### U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats) · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 2956 | 44,417 (43,615–44,561) | 54,422 | 66,167 | 79,067 | 135,8 | 343,5 |
| A* · gRPC, c canales | 2801 | 46,101 (44,173–48,250) | 64,125 | 74,817 | 89,630 | 197,1 | 399,3 |
| B · REST 1.1, c conexiones | 2729 | 44,002 (42,740–51,877) | 60,677 | 70,793 | 110,544 | 174,2 | 392,5 |
| B1 · REST 1.1, 1 conexión | 2084 | 64,263 (59,656–78,675) | 74,046 | 80,053 | 90,465 | 186,7 | 429,9 |
| C · REST h2c, 1 sesión | 1873 | 70,569 (65,408–79,352) | 84,732 | 93,316 | 101,813 | 204,7 | 446,9 |

#### U2 · Explicar, pedido de 100 B · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 2961 | 0,307 (0,302–0,312) | 0,445 | 0,592 | 41,992 | 206,1 | 218,6 |
| B · REST 1.1, c conexiones | 4814 | 0,193 (0,191–0,195) | 0,276 | 0,390 | 6,244 | 120,0 | 116,4 |
| C · REST h2c, 1 sesión | 4237 | 0,219 (0,219–0,221) | 0,317 | 0,433 | 4,739 | 140,9 | 154,7 |

#### U2 · Explicar, pedido de 100 B · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 8266 | 0,847 (0,825–0,854) | 1,191 | 5,586 | 13,325 | 86,7 | 80,0 |
| A* · gRPC, c canales | 8013 | 0,861 (0,834–0,868) | 1,443 | 6,037 | 19,752 | 126,9 | 128,4 |
| B · REST 1.1, c conexiones | 19100 | 0,356 (0,347–0,370) | 0,743 | 1,119 | 6,690 | 51,7 | 49,0 |
| B1 · REST 1.1, 1 conexión | 5978 | 1,292 (1,269–1,299) | 1,638 | 1,838 | 8,889 | 113,8 | 108,9 |
| C · REST h2c, 1 sesión | 15634 | 0,457 (0,454–0,466) | 0,672 | 0,943 | 6,262 | 40,7 | 43,5 |

#### U2 · Explicar, pedido de 100 B · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 10467 | 2,690 (2,589–2,748) | 6,567 | 9,678 | 15,341 | 74,2 | 63,7 |
| A* · gRPC, c canales | 8707 | 3,126 (3,111–3,172) | 7,603 | 12,325 | 22,626 | 117,9 | 121,3 |
| B · REST 1.1, c conexiones | 20312 | 1,408 (1,401–1,502) | 2,708 | 4,915 | 7,770 | 49,0 | 47,6 |
| B1 · REST 1.1, 1 conexión | 5925 | 5,261 (5,202–5,346) | 6,257 | 7,523 | 12,808 | 114,3 | 109,9 |
| C · REST h2c, 1 sesión | 21931 | 1,315 (1,281–1,368) | 1,842 | 5,109 | 7,776 | 30,7 | 31,0 |

#### U2 · Explicar, pedido de 100 B · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 11589 | 10,083 (9,947–10,252) | 16,970 | 21,052 | 25,139 | 73,6 | 60,6 |
| A* · gRPC, c canales | 8616 | 13,480 (12,717–14,356) | 26,291 | 35,873 | 43,118 | 124,4 | 123,0 |
| B · REST 1.1, c conexiones | 19191 | 6,255 (6,131–6,539) | 9,539 | 12,465 | 18,493 | 52,5 | 49,4 |
| B1 · REST 1.1, 1 conexión | 5914 | 21,139 (21,054–21,945) | 24,117 | 27,299 | 29,988 | 114,8 | 108,9 |
| C · REST h2c, 1 sesión | 26099 | 4,618 (4,530–4,849) | 7,491 | 10,702 | 13,995 | 31,1 | 29,9 |

#### U2 · Explicar, pedido de 8 KB · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 2623 | 0,346 (0,344–0,349) | 0,511 | 0,689 | 26,548 | 230,3 | 263,6 |
| B · REST 1.1, c conexiones | 3875 | 0,240 (0,238–0,243) | 0,336 | 0,442 | 2,216 | 136,5 | 150,8 |
| C · REST h2c, 1 sesión | 3509 | 0,264 (0,262–0,266) | 0,378 | 0,530 | 4,611 | 156,1 | 190,3 |

#### U2 · Explicar, pedido de 8 KB · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 7082 | 0,954 (0,918–0,964) | 1,633 | 4,918 | 10,938 | 119,2 | 143,9 |
| A* · gRPC, c canales | 6109 | 1,161 (1,157–1,179) | 1,869 | 5,196 | 11,048 | 155,4 | 179,0 |
| B · REST 1.1, c conexiones | 11490 | 0,611 (0,601–0,616) | 1,288 | 2,073 | 3,576 | 76,9 | 88,0 |
| B1 · REST 1.1, 1 conexión | 4882 | 1,586 (1,581–1,595) | 1,990 | 2,781 | 3,579 | 125,6 | 143,9 |
| C · REST h2c, 1 sesión | 9841 | 0,727 (0,720–0,756) | 1,136 | 2,177 | 6,365 | 69,0 | 96,9 |

#### U2 · Explicar, pedido de 8 KB · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 7292 | 3,913 (3,800–3,988) | 7,936 | 11,377 | 16,973 | 122,2 | 144,0 |
| A* · gRPC, c canales | 6499 | 4,478 (4,420–4,557) | 8,040 | 11,743 | 15,862 | 147,1 | 170,8 |
| B · REST 1.1, c conexiones | 11965 | 2,513 (2,390–2,611) | 4,438 | 5,623 | 8,525 | 76,5 | 84,7 |
| B1 · REST 1.1, 1 conexión | 4800 | 6,512 (6,495–6,550) | 7,832 | 8,598 | 9,750 | 127,7 | 145,0 |
| C · REST h2c, 1 sesión | 9754 | 3,073 (3,036–3,127) | 4,512 | 5,720 | 10,216 | 71,1 | 97,7 |

#### U2 · Explicar, pedido de 8 KB · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 7272 | 16,220 (15,334–16,585) | 24,527 | 28,890 | 32,289 | 121,2 | 144,7 |
| A* · gRPC, c canales | 6232 | 19,555 (18,850–19,690) | 31,671 | 36,904 | 45,171 | 159,9 | 180,5 |
| B · REST 1.1, c conexiones | 11633 | 10,593 (10,521–10,941) | 14,106 | 20,875 | 28,182 | 80,0 | 87,6 |
| B1 · REST 1.1, 1 conexión | 4745 | 26,665 (24,964–27,358) | 29,554 | 31,856 | 34,233 | 130,4 | 145,7 |
| C · REST h2c, 1 sesión | 9539 | 13,053 (12,406–13,305) | 15,711 | 17,053 | 22,359 | 72,4 | 101,0 |

#### U2 · Explicar, pedido de 64 KB · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1350 | 0,671 (0,666–0,674) | 0,971 | 2,015 | 4,956 | 448,8 | 606,3 |
| B · REST 1.1, c conexiones | 1834 | 0,517 (0,514–0,521) | 0,685 | 0,902 | 1,404 | 207,9 | 381,6 |
| C · REST h2c, 1 sesión | 1522 | 0,625 (0,624–0,628) | 0,821 | 1,195 | 3,167 | 274,0 | 480,7 |

#### U2 · Explicar, pedido de 64 KB · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1642 | 4,561 (4,538–4,586) | 6,603 | 8,204 | 12,132 | 410,3 | 566,3 |
| A* · gRPC, c canales | 2130 | 3,442 (3,422–3,459) | 5,596 | 7,495 | 14,012 | 331,6 | 533,5 |
| B · REST 1.1, c conexiones | 2844 | 2,399 (2,390–2,814) | 4,773 | 5,688 | 7,266 | 185,6 | 355,6 |
| B1 · REST 1.1, 1 conexión | 2211 | 3,540 (3,529–3,988) | 4,185 | 4,500 | 5,361 | 203,4 | 378,8 |
| C · REST h2c, 1 sesión | 1851 | 4,221 (4,219–4,275) | 5,032 | 5,473 | 8,662 | 247,4 | 447,1 |

#### U2 · Explicar, pedido de 64 KB · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1586 | 19,825 (19,089–19,842) | 23,713 | 25,557 | 30,039 | 367,8 | 591,0 |
| A* · gRPC, c canales | 2179 | 14,376 (14,059–14,421) | 19,729 | 25,370 | 34,177 | 305,6 | 529,2 |
| B · REST 1.1, c conexiones | 2796 | 11,041 (10,863–11,165) | 12,756 | 22,368 | 28,898 | 196,9 | 362,5 |
| B1 · REST 1.1, 1 conexión | 2113 | 15,048 (14,437–15,204) | 16,369 | 17,092 | 19,323 | 211,0 | 393,5 |
| C · REST h2c, 1 sesión | 1756 | 18,171 (17,257–18,186) | 19,646 | 20,906 | 25,473 | 253,8 | 469,8 |

#### U2 · Explicar, pedido de 64 KB · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1570 | 80,730 (79,961–81,781) | 88,893 | 92,936 | 98,635 | 331,0 | 597,0 |
| A* · gRPC, c canales | 2105 | 59,534 (58,988–59,712) | 83,216 | 96,368 | 107,843 | 304,4 | 546,2 |
| B · REST 1.1, c conexiones | 2799 | 45,122 (45,054–45,506) | 47,403 | 53,317 | 100,668 | 217,2 | 361,9 |
| B1 · REST 1.1, 1 conexión | 2052 | 62,078 (61,830–62,303) | 65,419 | 69,323 | 72,737 | 248,1 | 396,4 |
| C · REST h2c, 1 sesión | 1679 | 75,779 (75,292–76,196) | 81,600 | 85,688 | 91,674 | 265,8 | 563,9 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 1

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 1541 | 0,594 (0,591–0,601) | 0,870 | 1,259 | 12,342 | 0,297 | 452,8 | 522,8 |
| B · REST 1.1, c conexiones | 3175 | 0,297 (0,294–0,298) | 0,416 | 0,570 | 2,041 | 0,277 | 159,2 | 188,7 |
| C · REST h2c, 1 sesión | 3299 | 0,276 (0,274–0,280) | 0,410 | 0,546 | 4,842 | 0,246 | 163,7 | 225,6 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 8

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 3694 | 2,011 (1,982–2,022) | 3,536 | 4,496 | 8,876 | 0,883 | 228,8 | 229,4 |
| A* · gRPC, c canales | 2492 | 3,033 (3,023–3,075) | 4,585 | 5,773 | 12,908 | 0,620 | 344,5 | 416,4 |
| B · REST 1.1, c conexiones | 7126 | 1,026 (1,021–1,036) | 2,068 | 2,621 | 4,951 | 1,009 | 120,1 | 140,2 |
| B1 · REST 1.1, 1 conexión | 3650 | 2,126 (2,111–2,143) | 2,690 | 3,368 | 5,128 | 2,072 | 151,4 | 186,0 |
| C · REST h2c, 1 sesión | 7866 | 0,926 (0,920–0,934) | 1,416 | 2,432 | 6,614 | 0,694 | 76,0 | 116,5 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 32

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 4259 | 7,192 (7,159–7,306) | 10,324 | 13,857 | 18,944 | 5,603 | 227,7 | 225,2 |
| A* · gRPC, c canales | 2548 | 12,201 (12,188–12,269) | 15,244 | 20,043 | 27,682 | 2,133 | 346,0 | 414,7 |
| B · REST 1.1, c conexiones | 7353 | 4,183 (4,154–4,249) | 6,754 | 8,903 | 12,857 | 4,164 | 119,2 | 137,4 |
| B1 · REST 1.1, 1 conexión | 3630 | 8,667 (8,582–8,702) | 10,201 | 11,180 | 12,854 | 8,613 | 152,9 | 185,6 |
| C · REST h2c, 1 sesión | 7744 | 3,929 (3,920–3,961) | 5,347 | 7,748 | 12,699 | 3,615 | 78,8 | 119,0 |

#### S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos) · c = 128

| Camino | ped/s | p50 ms (rango) | p95 ms | p99 ms | máx ms | 1.er fragmento p50 ms | CPU cliente ms/1000 | CPU servidor ms/1000 |
|---|---|---|---|---|---|---|---|---|
| A · gRPC, 1 canal | 4379 | 28,773 (28,501–30,379) | 34,901 | 39,860 | 45,173 | 27,206 | 225,0 | 221,6 |
| A* · gRPC, c canales | 2424 | 52,170 (51,147–53,544) | 60,786 | 66,870 | 73,568 | 8,418 | 356,6 | 435,2 |
| B · REST 1.1, c conexiones | 7015 | 18,266 (17,669–18,442) | 21,705 | 31,937 | 43,880 | 18,249 | 122,5 | 144,1 |
| B1 · REST 1.1, 1 conexión | 3761 | 33,580 (33,162–35,248) | 37,050 | 40,770 | 46,313 | 33,527 | 150,6 | 178,9 |
| C · REST h2c, 1 sesión | 7787 | 16,080 (15,825–16,538) | 19,538 | 22,533 | 27,003 | 15,782 | 78,4 | 120,3 |

## Lo que muestran los datos (calculado, sin interpretar)

Por escenario: el camino con el menor p50 (mediana de las repeticiones), cuántas veces más tardan los demás (×) y, en concurrencia, el mayor throughput. Se marca cuando los rangos del p50 de los dos primeros se solapan. Las líneas de **linux** son la referencia para comparar transportes; las de **windows**, solo comportamiento observado en ese entorno.

- **windows · U1 · en serie**: menor p50 → A · gRPC, 1 canal (3,334 ms); los demás: B · REST 1.1, c conexiones ×1,36, C · REST h2c, 1 sesión ×1,40.
- **windows · U2-100B · en serie**: menor p50 → A · gRPC, 1 canal (2,943 ms); los demás: B · REST 1.1, c conexiones ×1,19, C · REST h2c, 1 sesión ×1,24.
- **windows · U2-8KB · en serie**: menor p50 → A · gRPC, 1 canal (0,335 ms); los demás: B · REST 1.1, c conexiones ×7,16, C · REST h2c, 1 sesión ×7,61. (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
- **windows · U2-64KB · en serie**: menor p50 → A · gRPC, 1 canal (0,751 ms); los demás: B · REST 1.1, c conexiones ×3,84, C · REST h2c, 1 sesión ×4,30. (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
- **windows · S1 · en serie**: menor p50 → B · REST 1.1, c conexiones (2,514 ms); los demás: C · REST h2c, 1 sesión ×1,15, A · gRPC, 1 canal ×1,44. (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
- **windows · U1 · c = 1**: menor p50 → A · gRPC, 1 canal (0,485 ms); los demás: B · REST 1.1, c conexiones ×9,32, C · REST h2c, 1 sesión ×9,56. Mayor throughput → A · gRPC, 1 canal (1804 ped/s).
- **windows · U1 · c = 8**: menor p50 → A* · gRPC, c canales (2,537 ms); los demás: A · gRPC, 1 canal ×1,06, C · REST h2c, 1 sesión ×1,53, B · REST 1.1, c conexiones ×2,88, B1 · REST 1.1, 1 conexión ×13,56. Mayor throughput → A* · gRPC, c canales (2758 ped/s).
  - Multiplexación, windows · U1 · c = 8: gRPC 1 canal frente a 8 canales → 2624 frente a 2758 ped/s (×0,95); REST 1.1 con 1 conexión frente a 8 → 227 frente a 1058 ped/s (×0,21).
- **windows · U1 · c = 32**: menor p50 → A* · gRPC, c canales (10,473 ms); los demás: C · REST h2c, 1 sesión ×1,41, B · REST 1.1, c conexiones ×2,01, A · gRPC, 1 canal ×7,26, B1 · REST 1.1, 1 conexión ×12,64. Mayor throughput → A* · gRPC, c canales (2813 ped/s).
  - Multiplexación, windows · U1 · c = 32: gRPC 1 canal frente a 32 canales → 417 frente a 2813 ped/s (×0,15); REST 1.1 con 1 conexión frente a 32 → 240 frente a 1451 ped/s (×0,17).
- **windows · U1 · c = 128**: menor p50 → A* · gRPC, c canales (48,824 ms); los demás: C · REST h2c, 1 sesión ×1,31, B · REST 1.1, c conexiones ×1,82, A · gRPC, 1 canal ×6,34, B1 · REST 1.1, 1 conexión ×10,94. Mayor throughput → A* · gRPC, c canales (2673 ped/s).
  - Multiplexación, windows · U1 · c = 128: gRPC 1 canal frente a 128 canales → 412 frente a 2673 ped/s (×0,15); REST 1.1 con 1 conexión frente a 128 → 239 frente a 1431 ped/s (×0,17).
- **windows · U2-100B · c = 1**: menor p50 → A · gRPC, 1 canal (2,730 ms); los demás: B · REST 1.1, c conexiones ×1,19, C · REST h2c, 1 sesión ×1,24. Mayor throughput → A · gRPC, 1 canal (357 ped/s).
- **windows · U2-100B · c = 8**: menor p50 → A* · gRPC, c canales (1,055 ms); los demás: B · REST 1.1, c conexiones ×5,14, A · gRPC, 1 canal ×17,30, C · REST h2c, 1 sesión ×22,58, B1 · REST 1.1, 1 conexión ×24,65. Mayor throughput → A* · gRPC, c canales (7039 ped/s).
  - Multiplexación, windows · U2-100B · c = 8: gRPC 1 canal frente a 8 canales → 433 frente a 7039 ped/s (×0,06); REST 1.1 con 1 conexión frente a 8 → 304 frente a 1445 ped/s (×0,21).
- **windows · U2-100B · c = 32**: menor p50 → C · REST h2c, 1 sesión (1,393 ms); los demás: A* · gRPC, c canales ×2,94, B · REST 1.1, c conexiones ×10,07, A · gRPC, 1 canal ×51,50, B1 · REST 1.1, 1 conexión ×74,57. Mayor throughput → C · REST h2c, 1 sesión (20883 ped/s).
  - Multiplexación, windows · U2-100B · c = 32: gRPC 1 canal frente a 32 canales → 445 frente a 7401 ped/s (×0,06); REST 1.1 con 1 conexión frente a 32 → 305 frente a 2259 ped/s (×0,14).
- **windows · U2-100B · c = 128**: menor p50 → C · REST h2c, 1 sesión (5,370 ms); los demás: A · gRPC, 1 canal ×2,22, A* · gRPC, c canales ×3,12, B · REST 1.1, c conexiones ×10,45, B1 · REST 1.1, 1 conexión ×77,80. Mayor throughput → C · REST h2c, 1 sesión (23108 ped/s).
  - Multiplexación, windows · U2-100B · c = 128: gRPC 1 canal frente a 128 canales → 10325 frente a 7407 ped/s (×1,39); REST 1.1 con 1 conexión frente a 128 → 305 frente a 2254 ped/s (×0,14).
- **windows · U2-8KB · c = 1**: menor p50 → B · REST 1.1, c conexiones (2,242 ms); los demás: C · REST h2c, 1 sesión ×1,05, A · gRPC, 1 canal ×1,23. Mayor throughput → B · REST 1.1, c conexiones (435 ped/s). (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
- **windows · U2-8KB · c = 8**: menor p50 → C · REST h2c, 1 sesión (0,763 ms); los demás: A · gRPC, 1 canal ×1,57, A* · gRPC, c canales ×1,73, B · REST 1.1, c conexiones ×4,86, B1 · REST 1.1, 1 conexión ×23,37. Mayor throughput → C · REST h2c, 1 sesión (8944 ped/s). (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
  - Multiplexación, windows · U2-8KB · c = 8: gRPC 1 canal frente a 8 canales → 6243 frente a 5742 ped/s (×1,09); REST 1.1 con 1 conexión frente a 8 → 443 frente a 2121 ped/s (×0,21).
- **windows · U2-8KB · c = 32**: menor p50 → C · REST h2c, 1 sesión (2,742 ms); los demás: A · gRPC, 1 canal ×1,65, A* · gRPC, c canales ×1,88, B · REST 1.1, c conexiones ×3,76, B1 · REST 1.1, 1 conexión ×25,90. Mayor throughput → C · REST h2c, 1 sesión (10814 ped/s).
  - Multiplexación, windows · U2-8KB · c = 32: gRPC 1 canal frente a 32 canales → 6657 frente a 5958 ped/s (×1,12); REST 1.1 con 1 conexión frente a 32 → 446 frente a 3061 ped/s (×0,15).
- **windows · U2-8KB · c = 128**: menor p50 → C · REST h2c, 1 sesión (11,839 ms); los demás: A · gRPC, 1 canal ×1,58, A* · gRPC, c canales ×1,84, B · REST 1.1, c conexiones ×3,49, B1 · REST 1.1, 1 conexión ×24,28. Mayor throughput → C · REST h2c, 1 sesión (10426 ped/s).
  - Multiplexación, windows · U2-8KB · c = 128: gRPC 1 canal frente a 128 canales → 6589 frente a 5692 ped/s (×1,16); REST 1.1 con 1 conexión frente a 128 → 443 frente a 3057 ped/s (×0,14).
- **windows · U2-64KB · c = 1**: menor p50 → C · REST h2c, 1 sesión (0,590 ms); los demás: B · REST 1.1, c conexiones ×4,56, A · gRPC, 1 canal ×5,70. Mayor throughput → C · REST h2c, 1 sesión (1488 ped/s). (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
- **windows · U2-64KB · c = 8**: menor p50 → C · REST h2c, 1 sesión (3,787 ms); los demás: A* · gRPC, c canales ×1,10, B · REST 1.1, c conexiones ×1,14, B1 · REST 1.1, 1 conexión ×5,54, A · gRPC, 1 canal ×6,49. Mayor throughput → C · REST h2c, 1 sesión (2081 ped/s).
  - Multiplexación, windows · U2-64KB · c = 8: gRPC 1 canal frente a 8 canales → 320 frente a 1877 ped/s (×0,17); REST 1.1 con 1 conexión frente a 8 → 376 frente a 1812 ped/s (×0,21).
- **windows · U2-64KB · c = 32**: menor p50 → A* · gRPC, c canales (13,610 ms); los demás: C · REST h2c, 1 sesión ×1,15, B · REST 1.1, c conexiones ×1,19, A · gRPC, 1 canal ×1,20, B1 · REST 1.1, 1 conexión ×6,17. Mayor throughput → A* · gRPC, c canales (2343 ped/s).
  - Multiplexación, windows · U2-64KB · c = 32: gRPC 1 canal frente a 32 canales → 1924 frente a 2343 ped/s (×0,82); REST 1.1 con 1 conexión frente a 32 → 378 frente a 1956 ped/s (×0,19).
- **windows · U2-64KB · c = 128**: menor p50 → A* · gRPC, c canales (58,705 ms); los demás: B · REST 1.1, c conexiones ×1,11, C · REST h2c, 1 sesión ×1,14, A · gRPC, 1 canal ×1,22, B1 · REST 1.1, 1 conexión ×5,79. Mayor throughput → A* · gRPC, c canales (2172 ped/s).
  - Multiplexación, windows · U2-64KB · c = 128: gRPC 1 canal frente a 128 canales → 1742 frente a 2172 ped/s (×0,80); REST 1.1 con 1 conexión frente a 128 → 375 frente a 1949 ped/s (×0,19).
- **windows · S1 · c = 1**: menor p50 → B · REST 1.1, c conexiones (2,409 ms); los demás: C · REST h2c, 1 sesión ×1,14, A · gRPC, 1 canal ×1,42. Mayor throughput → B · REST 1.1, c conexiones (403 ped/s).
- **windows · S1 · c = 8**: menor p50 → C · REST h2c, 1 sesión (1,051 ms); los demás: B · REST 1.1, c conexiones ×3,64, A* · gRPC, c canales ×4,92, B1 · REST 1.1, 1 conexión ×17,70, A · gRPC, 1 canal ×19,80. Mayor throughput → C · REST h2c, 1 sesión (7189 ped/s). (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
  - Multiplexación, windows · S1 · c = 8: gRPC 1 canal frente a 8 canales → 378 frente a 1526 ped/s (×0,25); REST 1.1 con 1 conexión frente a 8 → 425 frente a 2068 ped/s (×0,21).
- **windows · S1 · c = 32**: menor p50 → C · REST h2c, 1 sesión (4,100 ms); los demás: B · REST 1.1, c conexiones ×2,72, A* · gRPC, c canales ×5,19, B1 · REST 1.1, 1 conexión ×18,45, A · gRPC, 1 canal ×20,73. Mayor throughput → C · REST h2c, 1 sesión (7562 ped/s).
  - Multiplexación, windows · S1 · c = 32: gRPC 1 canal frente a 32 canales → 373 frente a 1488 ped/s (×0,25); REST 1.1 con 1 conexión frente a 32 → 418 frente a 2818 ped/s (×0,15).
- **windows · S1 · c = 128**: menor p50 → C · REST h2c, 1 sesión (16,748 ms); los demás: B · REST 1.1, c conexiones ×2,72, A* · gRPC, c canales ×5,21, B1 · REST 1.1, 1 conexión ×18,44, A · gRPC, 1 canal ×21,01. Mayor throughput → C · REST h2c, 1 sesión (7453 ped/s).
  - Multiplexación, windows · S1 · c = 128: gRPC 1 canal frente a 128 canales → 362 frente a 1446 ped/s (×0,25); REST 1.1 con 1 conexión frente a 128 → 412 frente a 2774 ped/s (×0,15).
- **linux · U1 · en serie**: menor p50 → B · REST 1.1, c conexiones (0,448 ms); los demás: A · gRPC, 1 canal ×1,08, C · REST h2c, 1 sesión ×1,10.
- **linux · U2-100B · en serie**: menor p50 → B · REST 1.1, c conexiones (0,190 ms); los demás: C · REST h2c, 1 sesión ×1,13, A · gRPC, 1 canal ×1,56.
- **linux · U2-8KB · en serie**: menor p50 → B · REST 1.1, c conexiones (0,236 ms); los demás: C · REST h2c, 1 sesión ×1,10, A · gRPC, 1 canal ×1,41.
- **linux · U2-64KB · en serie**: menor p50 → B · REST 1.1, c conexiones (0,517 ms); los demás: C · REST h2c, 1 sesión ×1,20, A · gRPC, 1 canal ×1,30.
- **linux · S1 · en serie**: menor p50 → C · REST h2c, 1 sesión (0,268 ms); los demás: B · REST 1.1, c conexiones ×1,09, A · gRPC, 1 canal ×2,14.
- **linux · U1 · c = 1**: menor p50 → B · REST 1.1, c conexiones (0,427 ms); los demás: A · gRPC, 1 canal ×1,09, C · REST h2c, 1 sesión ×1,12. Mayor throughput → B · REST 1.1, c conexiones (1985 ped/s). (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
- **linux · U1 · c = 8**: menor p50 → B · REST 1.1, c conexiones (2,004 ms); los demás: A* · gRPC, c canales ×1,12, A · gRPC, 1 canal ×1,19, B1 · REST 1.1, 1 conexión ×1,58, C · REST h2c, 1 sesión ×1,67. Mayor throughput → A* · gRPC, c canales (2877 ped/s).
  - Multiplexación, linux · U1 · c = 8: gRPC 1 canal frente a 8 canales → 2757 frente a 2877 ped/s (×0,96); REST 1.1 con 1 conexión frente a 8 → 2199 frente a 2813 ped/s (×0,78).
- **linux · U1 · c = 32**: menor p50 → A · gRPC, 1 canal (8,396 ms); los demás: B · REST 1.1, c conexiones ×1,08, A* · gRPC, c canales ×1,10, B1 · REST 1.1, 1 conexión ×1,56, C · REST h2c, 1 sesión ×1,72. Mayor throughput → A · gRPC, 1 canal (3121 ped/s).
  - Multiplexación, linux · U1 · c = 32: gRPC 1 canal frente a 32 canales → 3121 frente a 2898 ped/s (×1,08); REST 1.1 con 1 conexión frente a 32 → 2050 frente a 2723 ped/s (×0,75).
- **linux · U1 · c = 128**: menor p50 → B · REST 1.1, c conexiones (44,002 ms); los demás: A · gRPC, 1 canal ×1,01, A* · gRPC, c canales ×1,05, B1 · REST 1.1, 1 conexión ×1,46, C · REST h2c, 1 sesión ×1,60. Mayor throughput → A · gRPC, 1 canal (2956 ped/s). (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)
  - Multiplexación, linux · U1 · c = 128: gRPC 1 canal frente a 128 canales → 2956 frente a 2801 ped/s (×1,06); REST 1.1 con 1 conexión frente a 128 → 2084 frente a 2729 ped/s (×0,76).
- **linux · U2-100B · c = 1**: menor p50 → B · REST 1.1, c conexiones (0,193 ms); los demás: C · REST h2c, 1 sesión ×1,14, A · gRPC, 1 canal ×1,59. Mayor throughput → B · REST 1.1, c conexiones (4814 ped/s).
- **linux · U2-100B · c = 8**: menor p50 → B · REST 1.1, c conexiones (0,356 ms); los demás: C · REST h2c, 1 sesión ×1,28, A · gRPC, 1 canal ×2,38, A* · gRPC, c canales ×2,42, B1 · REST 1.1, 1 conexión ×3,63. Mayor throughput → B · REST 1.1, c conexiones (19100 ped/s).
  - Multiplexación, linux · U2-100B · c = 8: gRPC 1 canal frente a 8 canales → 8266 frente a 8013 ped/s (×1,03); REST 1.1 con 1 conexión frente a 8 → 5978 frente a 19100 ped/s (×0,31).
- **linux · U2-100B · c = 32**: menor p50 → C · REST h2c, 1 sesión (1,315 ms); los demás: B · REST 1.1, c conexiones ×1,07, A · gRPC, 1 canal ×2,05, A* · gRPC, c canales ×2,38, B1 · REST 1.1, 1 conexión ×4,00. Mayor throughput → C · REST h2c, 1 sesión (21931 ped/s).
  - Multiplexación, linux · U2-100B · c = 32: gRPC 1 canal frente a 32 canales → 10467 frente a 8707 ped/s (×1,20); REST 1.1 con 1 conexión frente a 32 → 5925 frente a 20312 ped/s (×0,29).
- **linux · U2-100B · c = 128**: menor p50 → C · REST h2c, 1 sesión (4,618 ms); los demás: B · REST 1.1, c conexiones ×1,35, A · gRPC, 1 canal ×2,18, A* · gRPC, c canales ×2,92, B1 · REST 1.1, 1 conexión ×4,58. Mayor throughput → C · REST h2c, 1 sesión (26099 ped/s).
  - Multiplexación, linux · U2-100B · c = 128: gRPC 1 canal frente a 128 canales → 11589 frente a 8616 ped/s (×1,35); REST 1.1 con 1 conexión frente a 128 → 5914 frente a 19191 ped/s (×0,31).
- **linux · U2-8KB · c = 1**: menor p50 → B · REST 1.1, c conexiones (0,240 ms); los demás: C · REST h2c, 1 sesión ×1,10, A · gRPC, 1 canal ×1,44. Mayor throughput → B · REST 1.1, c conexiones (3875 ped/s).
- **linux · U2-8KB · c = 8**: menor p50 → B · REST 1.1, c conexiones (0,611 ms); los demás: C · REST h2c, 1 sesión ×1,19, A · gRPC, 1 canal ×1,56, A* · gRPC, c canales ×1,90, B1 · REST 1.1, 1 conexión ×2,60. Mayor throughput → B · REST 1.1, c conexiones (11490 ped/s).
  - Multiplexación, linux · U2-8KB · c = 8: gRPC 1 canal frente a 8 canales → 7082 frente a 6109 ped/s (×1,16); REST 1.1 con 1 conexión frente a 8 → 4882 frente a 11490 ped/s (×0,42).
- **linux · U2-8KB · c = 32**: menor p50 → B · REST 1.1, c conexiones (2,513 ms); los demás: C · REST h2c, 1 sesión ×1,22, A · gRPC, 1 canal ×1,56, A* · gRPC, c canales ×1,78, B1 · REST 1.1, 1 conexión ×2,59. Mayor throughput → B · REST 1.1, c conexiones (11965 ped/s).
  - Multiplexación, linux · U2-8KB · c = 32: gRPC 1 canal frente a 32 canales → 7292 frente a 6499 ped/s (×1,12); REST 1.1 con 1 conexión frente a 32 → 4800 frente a 11965 ped/s (×0,40).
- **linux · U2-8KB · c = 128**: menor p50 → B · REST 1.1, c conexiones (10,593 ms); los demás: C · REST h2c, 1 sesión ×1,23, A · gRPC, 1 canal ×1,53, A* · gRPC, c canales ×1,85, B1 · REST 1.1, 1 conexión ×2,52. Mayor throughput → B · REST 1.1, c conexiones (11633 ped/s).
  - Multiplexación, linux · U2-8KB · c = 128: gRPC 1 canal frente a 128 canales → 7272 frente a 6232 ped/s (×1,17); REST 1.1 con 1 conexión frente a 128 → 4745 frente a 11633 ped/s (×0,41).
- **linux · U2-64KB · c = 1**: menor p50 → B · REST 1.1, c conexiones (0,517 ms); los demás: C · REST h2c, 1 sesión ×1,21, A · gRPC, 1 canal ×1,30. Mayor throughput → B · REST 1.1, c conexiones (1834 ped/s).
- **linux · U2-64KB · c = 8**: menor p50 → B · REST 1.1, c conexiones (2,399 ms); los demás: A* · gRPC, c canales ×1,43, B1 · REST 1.1, 1 conexión ×1,48, C · REST h2c, 1 sesión ×1,76, A · gRPC, 1 canal ×1,90. Mayor throughput → B · REST 1.1, c conexiones (2844 ped/s).
  - Multiplexación, linux · U2-64KB · c = 8: gRPC 1 canal frente a 8 canales → 1642 frente a 2130 ped/s (×0,77); REST 1.1 con 1 conexión frente a 8 → 2211 frente a 2844 ped/s (×0,78).
- **linux · U2-64KB · c = 32**: menor p50 → B · REST 1.1, c conexiones (11,041 ms); los demás: A* · gRPC, c canales ×1,30, B1 · REST 1.1, 1 conexión ×1,36, C · REST h2c, 1 sesión ×1,65, A · gRPC, 1 canal ×1,80. Mayor throughput → B · REST 1.1, c conexiones (2796 ped/s).
  - Multiplexación, linux · U2-64KB · c = 32: gRPC 1 canal frente a 32 canales → 1586 frente a 2179 ped/s (×0,73); REST 1.1 con 1 conexión frente a 32 → 2113 frente a 2796 ped/s (×0,76).
- **linux · U2-64KB · c = 128**: menor p50 → B · REST 1.1, c conexiones (45,122 ms); los demás: A* · gRPC, c canales ×1,32, B1 · REST 1.1, 1 conexión ×1,38, C · REST h2c, 1 sesión ×1,68, A · gRPC, 1 canal ×1,79. Mayor throughput → B · REST 1.1, c conexiones (2799 ped/s).
  - Multiplexación, linux · U2-64KB · c = 128: gRPC 1 canal frente a 128 canales → 1570 frente a 2105 ped/s (×0,75); REST 1.1 con 1 conexión frente a 128 → 2052 frente a 2799 ped/s (×0,73).
- **linux · S1 · c = 1**: menor p50 → C · REST h2c, 1 sesión (0,276 ms); los demás: B · REST 1.1, c conexiones ×1,08, A · gRPC, 1 canal ×2,15. Mayor throughput → C · REST h2c, 1 sesión (3299 ped/s).
- **linux · S1 · c = 8**: menor p50 → C · REST h2c, 1 sesión (0,926 ms); los demás: B · REST 1.1, c conexiones ×1,11, A · gRPC, 1 canal ×2,17, B1 · REST 1.1, 1 conexión ×2,30, A* · gRPC, c canales ×3,27. Mayor throughput → C · REST h2c, 1 sesión (7866 ped/s).
  - Multiplexación, linux · S1 · c = 8: gRPC 1 canal frente a 8 canales → 3694 frente a 2492 ped/s (×1,48); REST 1.1 con 1 conexión frente a 8 → 3650 frente a 7126 ped/s (×0,51).
- **linux · S1 · c = 32**: menor p50 → C · REST h2c, 1 sesión (3,929 ms); los demás: B · REST 1.1, c conexiones ×1,06, A · gRPC, 1 canal ×1,83, B1 · REST 1.1, 1 conexión ×2,21, A* · gRPC, c canales ×3,11. Mayor throughput → C · REST h2c, 1 sesión (7744 ped/s).
  - Multiplexación, linux · S1 · c = 32: gRPC 1 canal frente a 32 canales → 4259 frente a 2548 ped/s (×1,67); REST 1.1 con 1 conexión frente a 32 → 3630 frente a 7353 ped/s (×0,49).
- **linux · S1 · c = 128**: menor p50 → C · REST h2c, 1 sesión (16,080 ms); los demás: B · REST 1.1, c conexiones ×1,14, A · gRPC, 1 canal ×1,79, B1 · REST 1.1, 1 conexión ×2,09, A* · gRPC, c canales ×3,24. Mayor throughput → C · REST h2c, 1 sesión (7787 ped/s).
  - Multiplexación, linux · S1 · c = 128: gRPC 1 canal frente a 128 canales → 4379 frente a 2424 ped/s (×1,81); REST 1.1 con 1 conexión frente a 128 → 3761 frente a 7015 ped/s (×0,54).

### Escenarios donde gRPC NO tuvo el menor p50

- windows · S1 · en serie: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,44)
- windows · U2-100B · c = 32: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×51,50)
- windows · U2-100B · c = 128: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×2,22)
- windows · U2-8KB · c = 1: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,23)
- windows · U2-8KB · c = 8: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×1,57)
- windows · U2-8KB · c = 32: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×1,65)
- windows · U2-8KB · c = 128: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×1,58)
- windows · U2-64KB · c = 1: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×5,70)
- windows · U2-64KB · c = 8: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×6,49)
- windows · S1 · c = 1: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,42)
- windows · S1 · c = 8: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×19,80)
- windows · S1 · c = 32: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×20,73)
- windows · S1 · c = 128: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×21,01)
- linux · U1 · en serie: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,08)
- linux · U2-100B · en serie: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,56)
- linux · U2-8KB · en serie: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,41)
- linux · U2-64KB · en serie: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,30)
- linux · S1 · en serie: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×2,14)
- linux · U1 · c = 1: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,09)
- linux · U1 · c = 8: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,19)
- linux · U1 · c = 128: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,01)
- linux · U2-100B · c = 1: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,59)
- linux · U2-100B · c = 8: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×2,38)
- linux · U2-100B · c = 32: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×2,05)
- linux · U2-100B · c = 128: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×2,18)
- linux · U2-8KB · c = 1: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,44)
- linux · U2-8KB · c = 8: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,56)
- linux · U2-8KB · c = 32: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,56)
- linux · U2-8KB · c = 128: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,53)
- linux · U2-64KB · c = 1: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,30)
- linux · U2-64KB · c = 8: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,90)
- linux · U2-64KB · c = 32: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,80)
- linux · U2-64KB · c = 128: ganó B · REST 1.1, c conexiones (gRPC 1 canal ×1,79)
- linux · S1 · c = 1: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×2,15)
- linux · S1 · c = 8: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×2,17)
- linux · S1 · c = 32: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×1,83)
- linux · S1 · c = 128: ganó C · REST h2c, 1 sesión (gRPC 1 canal ×1,79)

