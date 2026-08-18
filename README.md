# PLT 布料紧凑排版

这是一个 Vite + TypeScript 静态网页应用和 MCP 服务。PLT 文件可以只在浏览器
本地读取，不会上传；程序会识别裁片、保留内部标记、按 1450 毫米布宽紧凑排版，
并生成 A/B 分版、PLT、PNG 审核预览和 JSON 清单。

## 网页运行

```powershell
npm install
npm run dev
```

打开 Vite 输出的网址，选择 PLT 文件；只有存在余料时才填写余料长度，然后点击
开始排版。默认裁片间距和排版栅格均为 `1 毫米`，边缘留量为 `5 毫米`。默认只
考虑 0 度和 180 度，以保持布料纹向；确认布料允许横向裁剪后，才勾选 90 度旋转。
排版计算在 Web Worker 中执行，耗时较长时界面仍可操作。

## Docker 部署

构建并启动网页服务：

```powershell
docker build -t plt-fabric-nester:latest .
docker run --rm -p 18191:80 plt-fabric-nester:latest
```

浏览器访问 `http://localhost:18191/`。也可以使用 `docker compose up --build web`。

## MCP 服务

MCP 服务通过 Streamable HTTP 提供，端点为 `POST /mcp`。同一 HTTP 服务也会在
`/files/*` 提供工具生成的 PLT、PNG 和 JSON 下载文件。提供三个工具：

- `analyze_plt`：分析路径、裁片数量、原始尺寸和裁片包围盒
- `nest_plt`：生成紧凑总版；余料不足时同时返回 A 余料版和 B 新料版 PLT
- `preview_plt`：返回带标尺、长度、宽度和裁片编号的 PNG 审核预览

`nest_plt` 和 `preview_plt` 都支持设置布宽、裁片间距、边缘留量、栅格、单位换算、
余料长度、是否允许 90 度旋转和排版强度。工具会返回 `pltUrl`、`pngUrl` 和
`manifestUrl`，其中预览始终是 PNG，不生成 SVG。MCP 和下载地址由同一服务提供，
默认监听 `127.0.0.1:8765`；Compose 会将它发布到主机的 `18192` 端口。可通过 `MCP_OUTPUT_DIR`、`MCP_HTTP_HOST`、
`MCP_HTTP_PORT`、`MCP_PUBLIC_BASE_URL` 环境变量调整输出目录和地址；`MCP_FILE_HOST` 与
`MCP_FILE_PORT` 仍兼容为旧环境变量别名。

本地启动：

```powershell
npm install
npm run mcp
```

MCP URL：`http://127.0.0.1:8765/mcp`。

Docker 启动：

```powershell
docker build -f Dockerfile.mcp -t plt-fabric-nester-mcp:latest .
docker run --rm -p 18192:8765 `
  -e MCP_HTTP_HOST=0.0.0.0 `
  -e MCP_PUBLIC_BASE_URL=http://host.docker.internal:18192 `
  plt-fabric-nester-mcp:latest
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "plt-fabric-nester": {
      "url": "http://host.docker.internal:18192/mcp"
    }
  }
}
```

与本服务位于同一 Compose 网络的客户端应使用 `http://mcp:8765/mcp`。Linux 上使用
`host.docker.internal` 的其他容器需要配置 `host-gateway` 映射。
本 Compose 部署面向独立容器调用，MCP URL 为 `http://host.docker.internal:18192/mcp`；
宿主机浏览器访问网页仍使用 `http://localhost:18191/`。

生产构建：

```powershell
npm run build
```

生成的 `dist/` 可直接部署到静态网站。HP-GL 坐标默认按 40 单位/毫米换算；只有
裁剪机使用其他标定值时才需要在 MCP 工具参数中覆盖 `unitsPerMm`。
