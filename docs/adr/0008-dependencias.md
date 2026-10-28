# ADR 0008 · Política de dependencias: versiones exactas, 14 días de publicadas y avisos revisados al instalar

- **Estado:** aceptada. Formaliza reglas escritas desde el arranque del proyecto. La regla de los 14 días estaba en el [ADR 0003](0003-crdt.md), que ahora enlaza aquí. `npm audit` al instalar se agregó el 27-10-2026.
- **Fecha:** 2026-10-27
- **Alcance:** los tres repos (editor-ia-database, editor-ia-backend y editor-ia-frontend).
- **Relacionados:** [ADR 0003](0003-crdt.md), riesgo [R-05](../modelo-amenazas.md) del modelo de amenazas, sección «Dependencias y cadena de suministro» del STRIDE.

## Contexto

Los tres repos son **públicos** y cada dependencia entra con todo su árbol transitivo. Los riesgos que importan:

- **Una versión maliciosa o rota recién publicada:** cuenta tomada, paquete secuestrado o error grave. Suelen detectarse y retirarse en días.
- **Un rango (`^`, `~`) que cambia solo.** El mismo `npm ci` de hoy y el de dentro de un mes instalarían cosas distintas, y una prueba que pasó deja de valer.
- **Avisos de seguridad conocidos** (GHSA) en algo del árbol.
- **Secretos en el historial** de un repo público.

## Decisión

### 1. Versiones exactas

- Toda dependencia directa va con versión **exacta** en `package.json`, sin `^` ni `~`. El `package-lock.json` se versiona y el CI instala con `npm ci`.
- **Cuando una transitiva hay que fijarla**, va con un **override exacto**. Pasa por un aviso o porque la versión que resuelve npm tiene menos de 14 días. Cada override lleva su motivo escrito en la tabla de abajo.

### 2. Al menos 14 días de publicada, al instalar

- Antes de comitear un cambio de dependencias, **cada entrada nueva o cambiada del lockfile**, transitivas incluidas, tiene que tener **14 días o más** de publicada en el registro. Se mira el campo `time` de `npm view`.
- **Si alguna tiene menos, se para** y se pregunta. No se instala «por esta vez».
- La cuenta es al instalar. Una versión que hoy tiene 13 días se puede instalar la semana que viene sin pedir nada.

### 3. Excepciones: solo por escrito

Una excepción es para **versiones concretas**, por un **motivo concreto** (un aviso alcanzable que no tiene otra salida), y la aprueba la dueña o el dueño del proyecto **por escrito**. Antes de pedirla:
- se lee el diff de la versión nueva (`npm diff`);
- el lockfile cambia **solo** en esas entradas;
- se agrega, si se puede, una defensa que no dependa de la versión.

| Qué | Por qué | Aprobó | Fecha | Revisión |
|---|---|---|---|---|
| `body-parser` **2.4.0** (publicada el 22-10-2026) y `qs` **6.16.1** (14-10-2026), overrides exactos en el backend | Aviso alto **GHSA-27r3-jxmh-p828** en body-parser 2.0.0–2.3.0: denegación de servicio con bytes sobrantes tras un cuerpo comprimido, alcanzable por `express.json()` y `express.raw()`. La 2.4.0 es la única parcheada y exige `qs ^6.16.1`. El diff de las dos versiones es acotado (sin red, archivos ni procesos nuevos), y el lockfile cambió solo en esas dos entradas. Defensa aparte: `inflate: false` en los dos parsers (415 sin descomprimir; mutaciones back B01–B03). | La dueña o dueño del proyecto, por escrito | 23-10-2026 | **5-11-2026**, cuando body-parser 2.4.0 cumple 14 días (R11). Riesgo [R-05](../modelo-amenazas.md). Se quitan los overrides cuando Express traiga por sí solo una versión parcheada con 14 días o más. |

**No hay otras excepciones.** Ningún otro paquete de los tres repos se instaló con menos de 14 días.

### 4. `npm audit` al instalar y en el CI

- **Al instalar o cambiar cualquier dependencia, antes de comitear:** `npm audit`, y se informa todo aviso nuevo, sea del nivel que sea. Regla vigente desde el 27-10-2026, después de que en R3 entrara un aviso moderado que se vio recién en el CI.
- **En el CI de los tres repos:** `npm audit --audit-level=high`. Un aviso alto o crítico hace fallar el job; uno moderado o bajo se ve en el log y se anota.

### 5. gitleaks sobre todo el historial antes de cada push

- `scripts\gitleaks.bat` en cada repo, y un job `gitleaks` en el CI con `fetch-depth: 0`.
- Los datos de prueba son **solo ficticios**: correos `@example.com` y nombres inventados.
- Ningún secreto va en el repo. Los `.env` los genera `env-init`, y están en `.gitignore`.

## Overrides vigentes y su motivo

| Repo | Override | Motivo |
|---|---|---|
| backend | `body-parser` 2.4.0, `qs` 6.16.1 | Excepción escrita (arriba), por GHSA-27r3-jxmh-p828 |
| backend | `deepmerge-ts` 8.0.2, `mysql2` 3.24.6 | Avisos en dependencias del CLI de Prisma (README general, «Versiones fijadas por compatibilidad») |
| backend | `uuid` 11.1.1 | GHSA-w5hq-g745-h8pq en `uuid` 8.3.2 (moderado, solo de desarrollo, por autocannon → hyperid). La 11.1.1 tiene más de 14 días: **no** es una excepción. El lockfile cambió solo en esa entrada (27-10-2026). |
| frontend | `@lezer/markdown` 1.8.0, `@codemirror/autocomplete` 6.20.3 | La versión que resolvía npm tenía menos de 14 días; se fija una que los cumple |
| frontend | `playwright-core` 1.63.0 | La misma versión que `@playwright/test` y el contenedor de las E2E (`mcr.microsoft.com/playwright:v1.63.0-noble`) |
| frontend | `katex` 0.19.0 dentro de `micromark-extension-math` | Una sola copia de KaTeX en el build: la extensión pedía 0.16.x, con un aviso |
| base | — | Sin overrides |

## Avisos abiertos al cierre de R6

| Aviso | Dónde | Nivel | Qué se espera |
|---|---|---|---|
| `fast-uri` 3.0.0–3.1.8 (GHSA-w74x-v6f9-j3xg y otros tres) | backend, solo de desarrollo | moderado | La versión corregida, 3.1.9, cumple 14 días el **2-11-2026** (R11). Hasta entonces, el CI pasa con el umbral `high`. |

## Alternativas

| Alternativa | Por qué no |
|---|---|
| Rangos `^` con el lockfile como única garantía | Basta un `npm install` sin querer para cambiar el árbol. Con versiones exactas, el cambio siempre es explícito y se revisa. |
| Actualizar al instante (Renovate o Dependabot con merge automático) | Es justo lo que expone a una versión maliciosa recién publicada. Sin revisión, un commit podría meter cientos de transitivas nuevas. |
| Un plazo mayor (30 días) | Deja más tiempo con avisos ya corregidos. Los 14 días cubren la ventana en la que se suele detectar un paquete malicioso. |
| Umbral de `npm audit` en `moderate` en el CI | El aviso de `fast-uri` habría frenado todo el trabajo hasta el 2-11 por algo solo de desarrollo, sin una versión corregida de 14 días. Lo moderado se ve en el log y se anota aquí. |

## Consecuencias

- **Arreglar un aviso puede esperar.** Si la única versión corregida es muy nueva, hay que elegir entre esperar (y anotarlo) o pedir una excepción por escrito.
- **Instalar algo nuevo lleva más pasos:** fechas del lockfile, `npm audit`, diff del lockfile y el motivo de cada override.
- **Las versiones fijadas envejecen.** Se revisan en las fechas de R11 y al cerrar el proyecto.

## Estado de verificación al cierre (R6)

**Verificado:**
- `npm audit --audit-level=high` en el CI de los tres repos, en exit 0 al cierre de R6:
  - backend: 1 aviso moderado (`fast-uri`);
  - frontend: 0 avisos, corrido el 27-10-2026;
  - base: 0 avisos, en el CI de R5.
- gitleaks: sin hallazgos en los tres repos antes de cada push del bloque R.
- Las 33 entradas nuevas de autocannon (R3) y la de `uuid` 11.1.1 (R4), con 14 días o más, revisadas a mano contra el registro.

**Sin control automático:**
- **La regla de los 14 días no la revisa el CI:** se revisa a mano al instalar. Un script que la compruebe en el CI sería una mejora; no está hecho.
- Que cada dependencia directa sea exacta tampoco se comprueba en el CI.
