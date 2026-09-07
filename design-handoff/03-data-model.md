# Модель данных, видимая в интерфейсе

Это не спецификация API, а перечень сущностей и полей, которые показывает макет.
Используйте как отправную точку для контракта фронтенд ↔ бэкенд: если поля нет здесь —
его негде показать; если поле здесь есть — оно должно приходить с сервера.

## Sandbox (песочница)
`id` · `name` («sandbox-01») · `project` («Интеграция 1С») · `status` · `dataVolume` (min/medium/full) ·
`latencyMs` (0–3000) · `errorRate` (0–50 %) · `lastResetAt`

## Service (демо-сервис)
`code` (`bitrix24` | `ozon` | `wildberries`) · `title` · `apiVersion` («REST API v1», «Seller API v3»,
«Suppliers API v2») · `status` (`ok` | `updating` | `down`) · `methodsCount` · `baseUrl` ·
`replacesUrl` (боевой адрес, который подменяется) · `brandColor`

## ApiMethod (метод каталога)
`id` · `serviceCode` · `httpMethod` · `path` · `title` · `description` · `version` ·
`readiness` (`ready` | `updating` | `planned`) · `group` (раздел внутри сервиса) ·
`params[]` (`name`, `type`, `required`, `description`) ·
`scenarios[]` (`code`, `title`, `description`) · `latencyMs`

Поиск на «Обзоре» ищет по `title`, `path`, `description` — во всех сервисах сразу.

## RequestLog (запись лога)
`id` · `timestamp` · `serviceCode` · `httpMethod` · `endpoint` · `statusCode` · `durationMs` ·
`sizeBytes` · `apiKeyName` · `requestBody` · `responseBody` · `requestHeaders` · `responseHeaders`

Агрегаты для сводки: `total`, `errorRate`, `avgLatency`, `p95Latency`, `hourlyBuckets[]` (час, всего, ошибок).

## ApiKey (ключ доступа)
`id` · `name` · `maskedKey` (`stend_sbx_7f3a••••••4c21`) · `services[]` · `createdAt` ·
`lastUsedAt` · `requestsPerDay` (счётчик, без лимита) · `status` (`active` | `revoked`) · `rotationDays`

## Webhook (подписка на событие)
`id` · `serviceCode` · `event` (`posting.created`, `stocks.changed`, `crm.deal.stage.changed`, …) ·
`targetUrl` (может быть `http://localhost:3000/…`) · `deliveryTarget` (`public` | `local`) ·
`httpMethod` · `status` · `lastAttemptAt` · `successRate24h`

## WebhookDelivery (доставка)
`id` · `webhookId` · `timestamp` · `event` · `targetUrl` · `statusCode` · `attempt` / `maxAttempts` ·
`durationMs` · `payload` (JSON) · `nextRetryAt`

## LocalAgent (CLI-доставка на localhost)
`connected` · `agentVersion` («apistend-cli 1.4.2») · `sessionId` (`tnl-8f21`) · `forwardUrl` ·
`latencyMs` · `eventsLastHour` · `failedDeliveries`

## Scenario (сценарий симуляции)
`id` · `name` · `serviceCode` · `stepsCount` · `status` (`running` | `paused`) · `lastRunAt` ·
`steps[]` (`event`, `delayMs`, `errorRate`)

## CustomMock (свой мок)
`id` · `httpMethod` · `path` (`/custom/erp/orders`) · `title` · `status` (`active` | `draft` | `disabled`) ·
`rulesCount` · `callsCount` · `updatedAt` · `responseStatusCode` · `contentType` · `delayMs` ·
`templatingEnabled` · `responseBody` (строка с плейсхолдерами) · `headers[]` · `rules[]`

Поддерживаемые плейсхолдеры: `{{uuid}}`, `{{now}}`, `{{now +3d}}`, `{{randomInt a b}}`,
`{{faker.company}}`, `{{faker.city}}`, `{{request.body.*}}`, `{{query.*}}`.
Сервер должен уметь вернуть и «сырой» шаблон (для редактора), и результат подстановки (для предпросмотра).

## Alert (уведомление на «Обзоре»)
`id` · `severity` (`danger` | `warning` | `info`) · `title` · `meta` · `icon` · `link`
