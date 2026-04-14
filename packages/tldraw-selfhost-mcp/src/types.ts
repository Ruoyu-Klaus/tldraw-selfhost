// 与主仓 src/server/mcp-bridge.ts 保持一致的类型定义（仅类型，无运行时依赖）

export interface McpRequest {
  type: 'request'
  id: string
  action: McpAction
  payload?: unknown
}

export type McpAction =
  | 'get_context'
  | 'get_shapes'
  | 'get_pages'
  | 'create_shape'
  | 'update_shape'
  | 'delete_shapes'

export interface McpResponse {
  type: 'response'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}
