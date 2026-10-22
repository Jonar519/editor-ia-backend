// Genera los tipos TypeScript del contrato gRPC (proto/) en src/generated/ia, con proto-loader-gen-types.
// Como src/generated/prisma, no se versiona: el CI lo genera (npm run proto:generate) antes del typecheck.
//
// proto-loader-gen-types escribe imports relativos sin extensión ("./cuaderno/ia/v1/Origen"), que
// TypeScript rechaza con moduleResolution nodenext: este script les agrega ".js" al copiarlos.
// Las opciones tienen que coincidir con las de src/ia/contrato.ts (OPCIONES_CARGA).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(RAIZ, 'src', 'generated', 'ia');
const ARCHIVOS = ['cuaderno/ia/v1/ia.proto', 'grpc/health/v1/health.proto'];

const temporal = mkdtempSync(path.join(tmpdir(), 'cuaderno-proto-'));
try {
  // Sin shell: node con el script del generador (las rutas con espacios y acentos no se parten).
  const generador = path.join(RAIZ, 'node_modules', '@grpc', 'proto-loader', 'build', 'bin', 'proto-loader-gen-types.js');
  const r = spawnSync(
    process.execPath,
    [generador, '--keepCase', '--longs=String', '--enums=String', '--defaults', '--oneofs', '--grpcLib=@grpc/grpc-js', '-I', 'proto', '-O', temporal, ...ARCHIVOS],
    { cwd: RAIZ, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    console.error(`proto-loader-gen-types falló (exit ${String(r.status)}):\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    process.exit(1);
  }
  rmSync(DESTINO, { recursive: true, force: true });
  let n = 0;
  /** @param {string} dir */
  const copiar = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const origen = path.join(dir, e.name);
      if (e.isDirectory()) {
        copiar(origen);
        continue;
      }
      const relativo = path.relative(temporal, origen);
      const texto = readFileSync(origen, 'utf8').replace(/from '(\.\.?\/[^']+)'/g, (_m, ruta) => `from '${ruta}.js'`);
      mkdirSync(path.dirname(path.join(DESTINO, relativo)), { recursive: true });
      writeFileSync(path.join(DESTINO, relativo), texto);
      n++;
    }
  };
  copiar(temporal);
  console.log(`Tipos del contrato gRPC: ${String(n)} archivos en src/generated/ia.`);
} finally {
  rmSync(temporal, { recursive: true, force: true });
}
