/**
 * Программный API пакета.
 *
 * Существует не для красоты: без него сквозные тесты туннеля пришлось бы гонять
 * через дочерний процесс, а это медленно и плохо отлаживается.
 */
export { listen, type ListenOptions, type ListenStats } from './listen.ts'
export { apiClient, CliError, type SessionResponse, type StatusResponse } from './api.ts'
export { readConfig, writeConfig, resolveApiBase, resolveApiKey, configPath, type CliConfig } from './config.ts'
export { isLoopbackForward, normalizeForward, CloseCode, TUNNEL_SUBPROTOCOL } from './protocol.ts'
export type { DeliveryFrame, ReadyFrame, ServerFrame } from './protocol.ts'
