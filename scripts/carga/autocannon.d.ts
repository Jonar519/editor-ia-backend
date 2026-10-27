// Tipos mínimos de autocannon 8.0.0 (solo lo que usan las pruebas de carga). No hay @types/autocannon en
// el proyecto: se declara aquí lo justo en lugar de agregar otra dependencia.
declare module 'autocannon' {
  interface Opciones {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    connections?: number;
    pipelining?: number;
    duration?: number;
    timeout?: number;
  }
  interface Histograma {
    average: number;
    mean: number;
    stddev: number;
    min: number;
    max: number;
    p50: number;
    p90: number;
    p97_5: number;
    p99: number;
    total: number;
  }
  interface Resultado {
    duration: number;
    latency: Histograma;
    requests: Histograma & { sent: number };
    throughput: Histograma;
    errors: number;
    timeouts: number;
    non2xx: number;
    '2xx': number;
    '4xx': number;
    '5xx': number;
    statusCodeStats: Record<string, { count: number }>;
  }
  function autocannon(o: Opciones): Promise<Resultado>;
  export default autocannon;
  export type { Opciones, Resultado };
}
