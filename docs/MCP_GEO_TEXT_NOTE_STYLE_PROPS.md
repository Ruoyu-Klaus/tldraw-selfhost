# MCP 扩展：geo / text / note 的样式 Props（dash、size、font、align）

本文档细化 **实现范围、与 tldraw 4.5.x 类型的对应关系、改哪些文件、默认值与测试要点**。依赖版本以仓库根目录 `package.json` 中的 `tldraw` / `@tldraw/tlschema` 为准（当前为 **4.5.3**）。

---

## 1. 目标

在现有 `create_shape` / `update_shape` 工具上，为 **`geo`、`text`、`note`** 增加（或打通）以下能力：

| 能力 | geo | text | note |
|------|-----|------|------|
| **dash**（轮廓线型） | ✅ | ❌ 不适用 | ❌ 不适用 |
| **size**（线粗/字号档位） | ✅ | ✅ | ✅ |
| **font** | ✅ | ✅ | ✅ |
| **align**（水平对齐） | ✅（`align`） | ✅（`textAlign`） | ✅（`align`） |
| **verticalAlign**（垂直对齐） | ✅ | ❌ schema 无此字段 | ✅ |

说明：

- **`dash`** 仅 **`TLGeoShapeProps`** 具备；`text` / `note` 在 `@tldraw/tlschema` 中**没有** `dash`，MCP 不应给这两类传 `dash`，避免无效字段误导模型。
- **`text`** 的水平对齐字段名为 **`textAlign`**，不是 `align`（见 `TLTextShapeProps`）。
- **`note`** 同时支持 **`align`** 与 **`verticalAlign`**，与 **geo** 一致。

若实现时希望「便签也有竖线感」，那是 **draw/line** 等类型，不在本次范围。

---

## 2. 合法枚举值（与 `@tldraw/tlschema` 一致）

下列取值来自类型定义中的 `EnumStyleProp`，MCP 侧建议用 **zod `z.enum([...])`** 与之一致，避免写入非法字符串导致运行时报错。

### 2.1 `dash`（仅 geo）— `TLDefaultDashStyle`

- `solid`
- `dashed`
- `dotted`
- `draw`

### 2.2 `size` — `TLDefaultSizeStyle`

三类 shape 共用：

- `s`
- `m`
- `l`
- `xl`

### 2.3 `font` — `TLDefaultFontStyle`

三类 shape 共用：

- `draw`
- `sans`
- `serif`
- `mono`

### 2.4 水平对齐

| Shape | 字段名 | 类型 | 建议 MCP 暴露的取值 |
|-------|--------|------|---------------------|
| geo | `align` | `TLDefaultHorizontalAlignStyle` | 最小集：`start`、`middle`、`end`（与 UI 常用一致） |
| text | `textAlign` | `TLDefaultTextAlignStyle` | `start`、`middle`、`end` |
| note | `align` | `TLDefaultHorizontalAlignStyle` | 同 geo：`start`、`middle`、`end` |

可选（完整兼容 schema）：`TLDefaultHorizontalAlignStyle` 还包含 `start-legacy`、`middle-legacy`、`end-legacy` 等。若只面向 AI 简化接口，**第一阶段仅暴露 `start | middle | end`** 即可；若需与旧文档完全互操作，再在 zod 中扩展枚举。

### 2.5 `verticalAlign`（geo、note）— `TLDefaultVerticalAlignStyle`

- `start`
- `middle`
- `end`

---

## 3. 代码改动清单

### 3.1 浏览器端（真正写入 store）

**文件：** `src/client/hooks/useMcpBridge.ts`

**`create_shape`：**

- 在解析 `req.payload` 的类型中增加可选字段：`dash?`、`size?`、`font?`，以及：
  - geo：`align?`、`verticalAlign?`
  - text：`textAlign?`（不要复用 `align` 以免和 geo 混淆）
  - note：`align?`、`verticalAlign?`
- **`geo` 分支**：`editor.createShape` 的 `props` 在现有字段基础上合并：
  - `dash`、`size`、`font`、`align`、`verticalAlign`（凡在 payload 中出现的再写入；未出现则用 **§4 默认值**）。
- **`text` 分支**：合并 `size`、`font`、`textAlign`。
- **`note` 分支**：合并 `size`、`font`、`align`、`verticalAlign`。

类型断言：与现有代码一致，对来自 MCP 的字符串使用 `as any` 或从 `@tldraw/tlschema` 导入类型后断言，确保与 `TLGeoShapeProps` / `TLTextShapeProps` / `TLNoteShapeProps` 兼容。

**`update_shape`：**

- 扩展 `req.payload`，允许上述字段均为可选。
- 在构建 `partialProps` 时：
  - 若 `color` / `text`（映射到 `richText`）已有逻辑，保持不变。
  - 若 `dash`、`size`、`font` 传入，按 shape 类型**有条件**写入（例如仅当 `shape.type === 'geo'` 时写 `dash`）。
  - geo：`align`、`verticalAlign`。
  - text：`textAlign`（注意 prop 名）。
  - note：`align`、`verticalAlign`。
- **`updateShape` 合并行为**：当前实现传入 `props: partialProps`。需确认仅包含**该 shape 类型合法**的 key；若 tldraw 对未知 key 报错，应在分支里按 `shape.type` 过滤。

**`get_shapes`（建议，可选但强烈建议）：**

- 在返回的每条记录中，对 `geo` / `text` / `note` 从 `props` 读出 `dash`、`size`、`font`、对齐字段，便于模型读回当前样式（闭环）。
- 字段命名可与 `create_shape` 对齐；`text` 对外可统一称 `textAlign` 或文档说明「text 的水平对齐」。

### 3.2 MCP 独立包（Cursor / Agent 看到的工具定义）

**文件：** `packages/tldraw-selfhost-mcp/src/index.ts`

- 在 `create_shape` 的 zod schema 中增加可选参数：
  - 公共：`size`、`font`
  - 仅当需要简化：可把 **全部**列为可选，在 description 中写明「仅对 geo 生效：dash、verticalAlign；仅对 text 生效：textAlign；…」，避免 zod 按 `shapeType` 动态分支（若希望严格，可用 `z.discriminatedUnion` 按 `shapeType` 拆分，实现成本略高）。
- 在 `update_shape` 中同样增加对应可选字段。
- 若扩展了 `get_shapes` 的返回结构，一般 **无需**改 MCP 工具（仍返回 JSON 字符串）；若新增独立 tool 再议。

### 3.3 类型（保持主仓与 MCP 包一致）

**文件：**

- `src/server/mcp-bridge.ts` — 若将 payload 结构文档化，可在注释或单独类型中列出（**不强制**改 `McpAction`，因 payload 为 `unknown`）。
- `packages/tldraw-selfhost-mcp/src/types.ts` — 可选：导出 `CreateShapePayload` 接口供包内复用。

### 3.4 文档同步

- 更新 `docs/MCP_INTEGRATION.md` 中 **`create_shape` / `update_shape`** 小节，与实现保持一致。
- 本文档 `docs/MCP_GEO_TEXT_NOTE_STYLE_PROPS.md` 作为专项说明保留。

### 3.5 发布

- 修改 `packages/tldraw-selfhost-mcp` 后 bump 版本并按 `.github/workflows/release-mcp.yml` 发布；使用者需更新 Cursor 中的 tgz URL 或本地路径。

---

## 4. 默认值（与 tldraw 默认一致，便于「不传则与画布工具一致」）

实现时建议在 **`useMcpBridge.ts`** 内集中定义常量或内联默认值，与 **`GeoShapeUtil.getDefaultProps()` / `TextShapeUtil` / `NoteShapeUtil`** 行为对齐。若不确定，可在浏览器控制台对 `editor.getShapeUtil('geo').getDefaultProps()` 打样核对。

经验上（以 schema 文档示例为准）：

- **geo**：`dash: 'solid'`，`size: 'm'`，`font: 'draw'`，`align: 'middle'`，`verticalAlign: 'middle'`（与官方 geo 示例一致）。
- **text**：`size: 'm'`，`font: 'draw'`，`textAlign: 'start'`（按你们当前未设置 `w` 时的自动布局，可与 `getDefaultProps` 核对）。
- **note**：`size: 'm'`，`font: 'sans'`（官方 note 示例为 `sans`），`align: 'middle'`，`verticalAlign: 'middle'`。

**仅对「未在 payload 中出现的字段」应用默认值**；若用户显式传入，以传入为准。

---

## 5. 桥接协议

无需新增 `McpAction`。仍使用：

- `create_shape`，payload 增加字段；
- `update_shape`，payload 增加字段。

WebSocket 消息格式不变（见 `docs/MCP_INTEGRATION.md`）。

---

## 6. 测试建议（手工）

1. 浏览器打开某 `roomId`，运行 `npm run mcp`（或 Cursor 加载 MCP）。
2. `create_shape`：`shapeType=geo`，设置 `dash: 'dashed'`，`size: 'l'`，`font: 'mono'`，`align: 'start'`，`verticalAlign: 'end'`，确认画布上边框与文字样式符合预期。
3. `create_shape`：`shapeType=text`，`textAlign: 'middle'`，`font: 'serif'`，`size: 'xl'`。
4. `create_shape`：`shapeType=note`，`align: 'end'`，`verticalAlign: 'start'`。
5. `update_shape`：对上述 shape 分别只改一项样式，确认不丢其它 prop。
6. `get_shapes`：若已扩展，确认 JSON 中能读回新字段。

---

## 7. 风险与注意事项

- **水平对齐 legacy 值**：若未来从文件导入含 `*-legacy` 的 shape，`update_shape` 若用窄枚举可能拒绝写入；第一阶段可只接受 `start|middle|end`。
- **text 的 `w` 与 `autoSize`**：当前创建 text 未传 `w`；改样式后若出现换行异常，可后续再扩 `w` / `autoSize`，本次可不动。
- **Zod 与 discriminated union**：若模型常误把 `dash` 传给 `text`，用 `discriminatedUnion` 可在 MCP 层直接校验失败并提示，减少无效请求。

---

## 8. 实现顺序建议

1. `useMcpBridge.ts`：`create_shape` 三类分支补 props + 默认值。
2. `useMcpBridge.ts`：`update_shape` 按类型合并样式字段。
3. `get_shapes` 返回补充字段（可选但推荐）。
4. `packages/tldraw-selfhost-mcp/src/index.ts`：zod 与 handler 对齐。
5. 更新 `MCP_INTEGRATION.md`，发 MCP 包新版本。

完成以上步骤后，AI 即可在「结构 + 填充」之外，通过 MCP 控制 **线型、字号档位、字体与对齐**，满足基础版「细节点缀与版面感」需求。
