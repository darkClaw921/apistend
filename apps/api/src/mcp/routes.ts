import type { FastifyInstance } from 'fastify'
import { handleMcpRequest } from './transport.ts'
import { apifyMcpServer } from './apify.ts'
import { apistendMcpServer } from './apistend.ts'

/**
 * Два MCP-сервера на двух адресах.
 *
 *   /apify/mcp — мок mcp.apify.com. Клиент меняет адрес и работает,
 *                как работал бы с боевым сервером Apify.
 *   /mcp       — сам APIStend: каталог методов, вызов моков, журнал запросов.
 *
 * Оба живут в шлюзовом сегменте маршрутов, поэтому CORS им уже выдан
 * (см. isGatewayPath в server.ts). Заголовки, которые обязан видеть браузерный
 * клиент MCP, перечислены в MCP_EXPOSED_HEADERS и добавлены к exposedHeaders.
 *
 * Путь мока намеренно вложен в префикс сервиса: /apify отдаёт REST, /apify/mcp —
 * MCP. Так один и тот же ключ песочницы и одна и та же строка базового адреса
 * покрывают оба протокола, а не расходятся на два разных хоста.
 */
export function registerMcp(app: FastifyInstance): void {
  for (const method of ['POST', 'GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/apify/mcp',
      handler: (req, reply) => handleMcpRequest(req, reply, apifyMcpServer),
    })
    app.route({
      method,
      url: '/mcp',
      handler: (req, reply) => handleMcpRequest(req, reply, apistendMcpServer),
    })
  }
}
