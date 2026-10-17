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
- **Mitigaciones adicionales:**
  - los cambios de permiso solo se hacen por el API, que publica después del commit;
  - si Redis no responde, no se aceptan conexiones nuevas (falla cerrado) y las abiertas se revalidan en la base;
  - el log `warn` y la métrica de actualizaciones descartadas o rechazadas.
- **Cómo se mide (prueba de K2):** se quita el permiso **sin** publicar en pub/sub y se mide, con reloj falso:
  1. el tiempo hasta cortar la retransmisión de un lector que solo recibe (≤ 30 s);
  2. que la primera escritura rechazada por la base corte la conexión en ese momento;
  3. cuántas actualizaciones de esa conexión recibieron los demás dentro de la ventana, y que después del corte sean **cero**.

  El número medido se escribe aquí cuando K2 lo produzca.
- **Estado:** aceptado por escrito al aprobar el ADR 0002, con la condición de cortar la retransmisión en cuanto el rol revalidado cambie.
