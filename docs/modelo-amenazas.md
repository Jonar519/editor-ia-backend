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
