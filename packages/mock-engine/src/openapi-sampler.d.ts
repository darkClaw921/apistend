declare module 'openapi-sampler' {
  export interface Options {
    readonly skipNonRequired?: boolean
    readonly skipReadOnly?: boolean
    readonly skipWriteOnly?: boolean
    readonly quiet?: boolean
    readonly enablePatterns?: boolean
    readonly format?: 'json' | 'xml'
  }
  export function sample(schema: unknown, options?: Options, document?: object): unknown
}
