# Almacenamiento de versiones (riesgo R-02)

Generado por `scripts\almacenamiento.bat` (`scripts/carga/medir-almacenamiento.ts`) contra la base de PRUEBAS `cuaderno_carga_test`. Datos ficticios. Los datos crudos están en `almacenamiento-r.json`.


## Lo que esta medición NO permite concluir

- **El tamaño de una base real.** La base es nueva y solo tiene los documentos de esta medición. No dice cuánto ocupa Cuaderno con uso normal: mide lo que cuesta CADA versión y cuánto puede crecer la base en el peor caso permitido.
- **Otro contenido.** La compresión de PostgreSQL (TOAST, pglz) depende del texto: se mide un texto muy repetitivo (comprime mucho) y uno de letras al azar (casi no comprime) como extremos. Un documento real queda entre los dos, sin saber dónde.
- **El peor caso real de restaurar.** Restaurar cuesta lo mismo que guardar (copia el documento entero) y cuenta en el MISMO límite; no se midió aparte.
- **Varias cuentas.** La proyección es por cuenta. Con N cuentas editoras se multiplica por N; no se midió concurrencia.
- **El espacio en disco del servidor.** Los bytes son los de PostgreSQL (`pg_column_size` y `pg_total_relation_size`); no incluyen WAL, copias de seguridad ni réplicas.
- **Tiempos de producción.** Los tiempos de guardar y verificar son de una máquina con todo local (base y API en el mismo equipo) y una sola corrida: indican el orden de magnitud, no una latencia garantizada.

## Entorno

| Dato | Valor |
|---|---|
| Fecha | 2026-10-27T12:59:59.975Z |
| Sistema | Windows_NT 10.0.26300 |
| Node | v24.13.1 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg12+2) |
| Carga de CPU antes de empezar | 5,5 % |
| Límite vigente (guardar y restaurar) | 30 cada 60 min por cuenta |
| Base antes / después | 9,1 MiB / 621,2 MiB |

## Lo medido por versión

Cada caso es una cuenta nueva, propietaria de su documento, que guarda versiones del MISMO texto hasta que el límite responde 429. «Columnas» es lo que ocupan `estado_yjs` y `contenido_texto` ya comprimidos; «tabla» es lo que creció `versiones` (con TOAST e índices) dividido por las versiones guardadas.

| Caso | Versiones guardadas | ¿429 al pasar el límite? | Sin comprimir | Columnas | Tabla | Guardar ms (mediana / máx) | Verificar la cadena ms |
|---|---|---|---|---|---|---|---|
| 10 000 caracteres, repetitivo | 30 | sí (pedido 31) | 20,0 KiB | 0,4 KiB | 2,7 KiB | 11 / 26 | 9 |
| 10 000 caracteres, aleatorio | 30 | sí (pedido 31) | 19,6 KiB | 19,6 KiB | 25,3 KiB | 11 / 18 | 9 |
| 1 000 000 caracteres, repetitivo | 30 | sí (pedido 31) | 2,0 MiB | 23,0 KiB | 24,5 KiB | 38 / 54 | 48 |
| 1 000 000 caracteres, aleatorio | 30 | sí (pedido 31) | 1,9 MiB | 1,9 MiB | 2,0 MiB | 66 / 78 | 51 |
| 9 000 000 caracteres, repetitivo | 30 | sí (pedido 31) | 17,6 MiB | 205,9 KiB | 213,1 KiB | 262 / 313 | 382 |
| 9 000 000 caracteres, aleatorio | 30 | sí (pedido 31) | 17,2 MiB | 17,2 MiB | 17,8 MiB | 523 / 602 | 552 |

## Peor caso permitido por cuenta (cuenta, no medición)

Bytes de la tabla por versión × 30 versiones por hora, sin parar. El mayor medido: 17,8 MiB por versión.

| Caso | Por versión | Por hora | Por día |
|---|---|---|---|
| 10 000 caracteres, repetitivo | 2,7 KiB | 80,0 KiB | 1,9 MiB |
| 10 000 caracteres, aleatorio | 25,3 KiB | 760,0 KiB | 17,8 MiB |
| 1 000 000 caracteres, repetitivo | 24,5 KiB | 736,0 KiB | 17,2 MiB |
| 1 000 000 caracteres, aleatorio | 2,0 MiB | 59,5 MiB | 1,39 GiB |
| 9 000 000 caracteres, repetitivo | 213,1 KiB | 6,2 MiB | 149,8 MiB |
| 9 000 000 caracteres, aleatorio | 17,8 MiB | 534,5 MiB | 12,53 GiB |
