// Types aligned with repo src/server/mcp-bridge.ts (types only; no runtime import from app)

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
  | 'create_backdrop'
  | 'update_shape'
  | 'delete_shapes'
  | 'layout_shapes'

export interface McpResponse {
  type: 'response'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}
