import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { env } from '../env.ts'
import { requireSandbox } from '../lib/guard.ts'
import { apistendMcpServer } from '../mcp/apistend.ts'

/**
 * Настройки аккаунта. Пока здесь одно — доступ по MCP.
 *
 * Почему это настройка, а не всегда включённая возможность: агент, которому дали
 * ключ, вызывает моки и читает журнал запросов, а в журнале лежат тела запросов,
 * написанные человеком. Такое включают осознанно. Открытая часть — каталог
 * методов — доступна и без включения: в ней нет ничего личного, и агенту она
 * нужна как раз до того, как у него появится ключ.
 */

const mcpBody = z.object({ enabled: z.boolean() })

/**
 * Готовая инструкция для ИИ-агента.
 *
 * Собирается из живого списка инструментов, а не пишется отдельным текстом:
 * инструкция, разошедшаяся с сервером, хуже отсутствующей — агент попробует
 * вызвать то, чего нет, и решит, что сломан сервер.
 */
function agentInstructions(mcpUrl: string, tools: readonly { name: string; description: string }[]): string {
  const lines = [
    '# APIStend — демо-копии боевых API',
    '',
    'У тебя есть MCP-сервер APIStend. Он отдаёт демо-копии боевых API вместо самих',
    'сервисов: Bitrix24, Ozon Seller, Wildberries и Apify. Разработчик подменяет',
    'базовый адрес на адрес песочницы и работает, не трогая боевой аккаунт.',
    '',
    '## Когда им пользоваться',
    '',
    'Всегда, когда пишешь или отлаживаешь интеграцию с одним из этих сервисов.',
    'Не угадывай пути методов и форму ответа по названию — живую документацию Ozon',
    'и Wildberries ты всё равно не откроешь, они закрыты антиботом. Спроси каталог.',
    '',
    '## Порядок работы',
    '',
    '1. `list_services` — какой префикс что заменяет, как передаётся ключ, каковы лимиты.',
    '2. `search_catalog` — найти метод по куску пути, названию или описанию.',
    '3. `describe_method` — его параметры, коды ошибок и пример ответа.',
    '4. `call_mock` — вызвать и посмотреть настоящее тело ответа.',
    '',
    '## Инструменты',
    '',
    ...tools.map((t) => `- \`${t.name}\` — ${t.description.split('\n')[0]}`),
    '',
    '## Чему верить в ответе',
    '',
    'Поле `responseSource` говорит, откуда взято тело:',
    '',
    '- `example` — пример из документации сервиса: верны и форма, и значения;',
    '- `schema` — форма из спецификации, значения выдуманы: не проверяй по ним бизнес-логику;',
    '- `generic` — пустой валидный конверт: гарантируется только то, что клиент не упадёт на разборе.',
    '',
    'Ответы детерминированы: один и тот же вызов всегда даёт одно и то же тело.',
    'Если тело изменилось — изменился твой запрос, а не мок.',
    '',
    '## Чего мок не делает',
    '',
    'Он не ходит в боевые сервисы и не имеет их данных. Ключ песочницы',
    '(`stend_sk_…`) не подходит к боевому API, а боевой токен — к песочнице.',
    'Числа, имена и суммы в ответах — демонстрационные; не выдавай их за настоящие.',
    '',
    '## Подключение',
    '',
    '```json',
    JSON.stringify(
      { mcpServers: { apistend: { url: mcpUrl, headers: { Authorization: 'Bearer stend_sk_ВАШ_КЛЮЧ' } } } },
      null,
      2,
    ),
    '```',
  ]
  return lines.join('\n')
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings/mcp', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const url = `${env.publicOrigin}/mcp`
    // Список инструментов берётся у самого сервера: расходиться им нельзя.
    const tools = await apistendMcpServer.tools(req)

    return reply.send({
      enabled: ctx.sandbox.mcpEnabled,
      url,
      protocolVersion: apistendMcpServer.protocolVersion,
      /** Готовый блок для конфига клиента MCP. */
      clientConfig: JSON.stringify(
        { mcpServers: { apistend: { url, headers: { Authorization: 'Bearer stend_sk_ВАШ_КЛЮЧ' } } } },
        null,
        2,
      ),
      /** Готовая инструкция для агента: копируется в его системный текст или AGENTS.md. */
      agentInstructions: agentInstructions(url, tools),
      tools: tools.map((t) => ({ name: t.name, title: t.title ?? t.name, description: t.description })),
    })
  })

  app.patch('/api/settings/mcp', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const parsed = mcpBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }

    const updated = await prisma.sandbox.update({
      where: { id: ctx.sandbox.id },
      data: { mcpEnabled: parsed.data.enabled },
    })

    return reply.send({ enabled: updated.mcpEnabled })
  })
}
