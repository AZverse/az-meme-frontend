# az-meme-frontend

AZ MEME BOT PoC 前端，使用 Node.js 24 + TypeScript。当前页面通过 Meme REST/WS 获取榜单、Token、K 线和成交数据，可连接 Local Mock 或真实后端，不在页面内写死业务 fixture。

主账户 PoC 的交易按钮点一次就会下单：页面依次完成估价（ESTIMATE，未过期的估价直接复用）、准备（PREPARE_EXECUTION）和提交，中间没有单独的确认步骤。滑点由报价给出（AUTO），页面不能手填。实际签名和广播由后端执行。数据与交易请求见 [API client](src/api.ts)，交易流程见 [交易面板](src/TradingPanel.tsx) 与 [报价校验](src/quote-flow.ts)。

从父工作区启动完整本地 Mock 拓扑（在父仓目录执行，env 准备见父仓 README）：

```text
pnpm dev:mock
```

真实后端联调在父仓目录执行 `pnpm dev:frontend`：只启动前端，连接已经在运行的 API，默认 `http://127.0.0.1:3013`，可用 `VITE_MEME_API_BASE_URL` 指定别的地址。后端的启动方式见父仓 README。

验证本仓（要在父仓检出里执行：`src/display.test.ts` 读取父仓的 `tests/display-price.fixtures.json`，单独检出本仓时类型检查、测试和构建都会因为找不到它而失败）：

```text
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

开发地址默认为 `http://127.0.0.1:5173`。客户端公共配置为 `VITE_MEME_API_BASE_URL` 和 `VITE_MEME_WS_URL`；未配置时使用同源 REST/WS。真实连接配置放在 Git ignored 的本地 env 文件；密钥和服务端凭据不得进入前端环境变量。

交易浏览器优先使用服务端公共配置的 `explorerBaseUrl`；不可用时使用 `VITE_EXPLORER_BASE_URL`，默认为 `https://robinhoodchain.blockscout.com`。交易链接遵循项目现有的 `<explorer>/tx/<txHash>` 格式；Robinhood Chain 官方网络配置见 https://docs.robinhood.com/chain/connecting/。
