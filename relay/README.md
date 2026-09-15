# wb-relay —— 把本机 WorkBuddy 反代成一个本地接口

把你的 WorkBuddy（桌面版）变成本机的一个 HTTP 服务，任何会调 OpenAI 接口的程序都能用它。

```
其他程序  --HTTP(OpenAI格式)-->  wb-relay  --stdin/stdout-->  WorkBuddy CLI（常驻进程）
            127.0.0.1:8790                        真正的对话在这里跑
```

它**不碰** WorkBuddy 的登录凭证，也不改它的任何文件。它只是把你本机已经装好、已经登录的
WorkBuddy CLI 当成后端拉起来，在它前面架了一层标准接口。

## 怎么启动

双击 `start.cmd`，或者：

```bat
node wb-relay.js
```

看到这样的输出就成功了：

```
  监听      http://127.0.0.1:8790
  CLI       D:\workboddy\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy
            （来源：运行中的 WorkBuddy 进程）
  工作目录  D:\workboddy\relay\workspace
  模型      (跟随 WorkBuddy auto)
  工具权限  未放开（纯问答）
  鉴权      本机回环，未设密钥
```

然后浏览器打开 **http://127.0.0.1:8790** —— 那就是控制台，权限、模型、会话都在上面点。

## WorkBuddy 路径是自动找的，没有任何写死

程序启动时自己定位 WorkBuddy 的 CLI，顺序是：

1. `config.json` 里 `cli.cliJs` 手写的路径（你写了就听你的）
2. 上次找到的路径缓存（`.wb-location.json`）
3. 问系统：正在运行的 WorkBuddy 进程的 exe 路径 ← 实际最常命中这条
4. 问系统：PATH 里的 `codebuddy` / `cbc`
5. 问系统：注册表卸载信息里的安装位置
6. 按盘符遍历目录树（有 3 层深度上限、12 秒超时，只读目录名，会跳过 Windows / node_modules 这类目录）

找到之后写进 `.wb-location.json`，下次直接读缓存。

**路径变了会自动重找**：如果缓存里的路径已经不存在（你挪了目录、卸载重装、换盘），
程序会丢掉缓存重新走一遍上面的流程，运行时发现 CLI 不见了也会重找一次。控制台上也有个
「重新查找 WorkBuddy 路径」按钮可以手动触发。

如果 6 条都没找到，错误信息会告诉你是不是「找到了安装目录但 CLI 还打包在 app.asar 里」——
那种情况请把 WorkBuddy 完整跑一次，或者手动在 `config.json` 的 `cli.cliJs` 里填路径。

## 网页控制台

浏览器打开 http://127.0.0.1:8790 就能看到，分四块：

| 区块 | 能做什么 |
| --- | --- |
| 运行状态 | 监听地址、鉴权状态、工具权限、CLI 路径和它的来源、工作目录、模型来源和数量；「重新查找 WorkBuddy 路径」 |
| 权限与模型 | 工具权限总开关；勾选允许哪些工具（分「只读/安全」「会改文件」「执行命令/危险」三组，有只读、常用读写、全开三个预设）；设默认模型；追加模型别名 |
| 全部可用模型 | 把 WorkBuddy 里能用的模型全列出来（含积分倍率、上下文长度、是否支持工具/图片/推理），可搜索、按类型过滤、一键复制全部模型名 |
| 活跃会话 | 看每个会话跑了几轮、空不空、忙不忙；单独清空或全部清空 |

改完点「保存设置」，会立刻写回 `config.json`。

**注意生效范围**：会话进程的启动参数在它诞生时就定下了，所以改完设置后**已经存在的会话还在按旧设置跑**，
要清掉那个会话（控制台里点「清空」）才会用新设置重建。

改权限的接口有防护：必须带 `x-wb-relay: 1` 请求头，且带 `Origin` 时必须是同源。
这是为了拦住「你浏览器里某个陌生页面向 127.0.0.1 发请求偷偷把工具权限打开」这种情况。

## 怎么给别的程序用

在对方程序里填「OpenAI 兼容 / 自定义接口」：

| 项目 | 填什么 |
| --- | --- |
| Base URL / 接口地址 | `http://127.0.0.1:8790/v1` |
| API Key | 随便填，或按下面「对外暴露」那节配一个真密钥 |
| 模型名 | `auto`、`glm-5.2`、`deepseek-v4-pro` 等任意一个真实模型 id，或 `workbuddy-auto`（= 用控制台设的默认模型） |

命令行验证：

```bat
curl http://127.0.0.1:8790/health

curl -N -X POST http://127.0.0.1:8790/v1/chat/completions ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"workbuddy-auto\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 网页控制台 |
| GET | `/health` | 存活状态，顺带看当前有哪些会话在跑 |
| GET | `/v1/models` | **全部可用模型**（OpenAI 列表格式）。可选 `?kind=chat` 只取对话模型 |
| POST | `/v1/chat/completions` | OpenAI 标准对话接口，支持 `stream: true` 的 SSE 流式 |
| POST | `/v1/wb/prompt` | 简易接口，`{"prompt":"...","session":"...","model":"..."}`，返回 `{"text":"..."}` |
| GET | `/api/state` | 控制台用的状态：配置、模型清单、工具清单、活跃会话 |
| POST | `/api/config` | 改配置（权限、模型、会话参数），写回 config.json |
| POST | `/api/sessions` | 清空会话：`{"id":"..."}` 或 `{"all":true}` |
| POST | `/api/models/refresh` | 立刻重读模型清单，返回数量、来源、有没有新增/移除 |
| POST | `/api/locate` | 丢开缓存，重新查找 WorkBuddy 路径 |

`/v1/models` 里每条模型除了标准字段，还额外带了 `name`、`kind`（chat/completion/image/video）、
`credits`（积分倍率）、`context_length`、`supports_tools`、`supports_images`、`recommended`
这些非标准字段——普通客户端会忽略它们，脚本可以用。当前这台机器上会返回 **52 个**。

多轮对话怎么算：请求里带 `"user": "某个名字"`，或者 HTTP 头 `x-wb-session: 某个名字`，
同名的会落到同一个常驻进程里，上下文自然延续。想开一段全新对话，加个头
`x-wb-new-session: 1`（或 JSON 里写 `"new_session": true`）。

不传 session 的全部走 `default` 这一条会话。**换模型等于换进程**（模型是 CLI 的启动参数），
所以同一个会话名换了模型，上下文会重新开始。

## 性能：第一次慢，后面快

这是实测数据，不是估计：

- **一段会话的第一问：约 10 秒**。慢的原因不是进程启动，而是 WorkBuddy 每轮都要吃一份
  约 2.6 万 token 的系统提示词（记忆系统 + 项目规则），第一轮没法命中缓存。
- **同一段会话的后续问题：约 2 秒**。命中提示词缓存后才省下来。
- 换一个 session 名字 = 新进程 + 新一轮冷启动，又要约 10 秒。

所以：**连续对话请复用同一个 session**；一次性脚本调用就接受每次 10 秒。

启动时会把 `default` 会话的进程先拉起来（`sessions.prewarm`），但这只省掉进程启动那
一秒左右，省不掉首轮的提示词处理时间。

另外提醒：每轮请求都会消耗你 WorkBuddy 账号的额度，提示词约 2.6 万 token 起步，
别拿它当高频轮询的后端。

## 配置

`config.json` 第一次启动会自动生成。改完重启生效。

```jsonc
{
  "listen": { "host": "127.0.0.1", "port": 8790 },
  "apiKeys": [],                  // 填了就要求带 Bearer Key
  "cli": {
    "nodeExe": "",                // 空 = 用当前 node
    "cliJs": "",                  // 空 = 自动找 WorkBuddy 的 CLI
    "cwd": "",                    // 空 = <程序目录>\workspace
    "verbose": true,
    "allowTools": false,          // 见下面「工具权限」
    "allowedTools": "",           // 如 "Read,Grep,WebSearch"
    "systemPrompt": "",           // 追加到系统提示词，用来固定人设
    "model": ""                   // 固定模型，如 "deepseek-v4-pro"；空 = 跟随 auto
  },
  "sessions": {
    "maxWorkers": 4,              // 最多几个并行会话进程
    "idleMs": 1800000,            // 会话空闲 30 分钟回收
    "turnTimeoutMs": 900000,      // 单轮最长等 15 分钟
    "keepAliveHintMs": 15000,     // SSE 心跳间隔
    "prewarm": true
  },
  "models": ["workbuddy-auto"]    // 追加到 /v1/models 末尾的别名；真实模型清单自动读
}
```

大部分配置改完不用重启 —— 直接去网页控制台点保存就行（权限、模型、会话参数、别名）。
要重启的只有：监听地址、端口、访问密钥、CLI 路径、工作目录。

命令行可以覆盖常用项：

```bat
node wb-relay.js --port 8899 --key my-secret-key
node wb-relay.js --allow-tools "Read,Grep"
node wb-relay.js --model deepseek-v4-pro
node wb-relay.js --cli-js "D:\别的盘\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
```

## 模型清单从哪来，什么时候会更新

按优先级读三处，只读不写：

1. WorkBuddy 自己缓存的云端配置（`~/.workbuddy/local_storage/*.info`）—— 这是你账号实际下发的清单，最准
2. CLI 安装目录里的内置目录（`product.json`）—— 缓存缺失时兜底
3. 你自己加的自定义模型（`~/.workbuddy/models.json`）—— 合并进去，标「自定义」

**更新有两层，别搞混**：

| 层 | 多久更新 | 怎么催 |
| --- | --- | --- |
| wb-relay 读文件 | 缓存 15 秒，控制台每 5 秒轮询，所以最迟约 20 秒 | 控制台点「拉取最新模型」立刻重读 |
| WorkBuddy 自己写这个文件 | 由 WorkBuddy 决定（联网刷新云端配置时写） | 打开一次它的模型选择器，或重启 WorkBuddy |

所以「模型没变」有两种可能：wb-relay 还没重读（点一下按钮就好），或者 WorkBuddy 那份文件本身还没更新。
控制台里两个时间都显示出来了 —— 「清单读取于 X」是前者，「WorkBuddy 的配置文件更新于 Y」是后者。
点「拉取最新模型」会告诉你这次重读有没有变化（新增/移除了哪些）。

`/v1/models` 返回的是**全部**模型，不做过滤；如果某个模型在你这账号下其实不可用，选它会报错，
错误会照原样回给调用方。

## 工具权限（重要）

默认**不放开工具**。意思是模型只能聊天，不能读写文件、不能跑命令 —— 这是安全的默认值。
注意 WorkBuddy 的系统提示词本身很大，会带一堆工具说明，模型偶尔会想动手，那种情况下
调用会被权限拦下，日志里会提示你「有 N 次工具调用被权限拦下」。

要让它真的干活（能读文件、跑命令），才加：

```bat
node wb-relay.js --allow-tools
node wb-relay.js --allow-tools "Read,Grep,WebSearch"
```

这等于对**所有调用方**放开了你这台机器的文件系统和命令执行权限。只在你自己完全信任
调用方的时候用，别对着公网开。

### 白名单的三种状态（控制台里的勾选框就是它）

| 勾选情况 | 实际效果 |
| --- | --- |
| 总开关关着 | 不给任何工具权限（默认，最安全）。模型只能聊天 |
| 总开关开着，勾了一部分 | 只允许勾上的那些工具（`--allowedTools`） |
| 总开关开着，一个都没勾 | **什么工具都不给**（用 `--disallowedTools` 把全部工具禁掉） |

第三种容易误解，所以说清楚：勾选框是「允许什么」，一个都不勾就是什么都不允许，不是「全放开」。
想全放开用「全开」按钮（它会勾上全部）。

配置层面 `allowTools: true` 配 `allowedTools: ""` 就是第三种状态。之前版本的语义是反的
（空 = 全部放开），已经改掉 —— 因为那种情况下刷新页面会显示成「没勾任何工具」，用户一点保存就
会被静默放大权限。

## 对外暴露（局域网或公网）

默认只监听 `127.0.0.1`，本机以外访问不到。要让同局域网的其他设备用：

```bat
node wb-relay.js --host 0.0.0.0 --key 一个够长的随机串
```

规则是硬性的：**监听地址对外时必须配 `apiKeys`，否则程序拒绝启动**。这是防止你把一个
能在你电脑上执行操作的服务裸奔到网络上。

放到公网就再在前面套一层你自己的反代（nginx / caddy / frp），把它转到
`127.0.0.1:8790`，并且务必：
- 配 HTTPS；
- 保留密钥鉴权，别为了省事关掉；
- 如果调用方是浏览器里的页面，反代域名需要出现在加白名单的位置（这一层是浏览器同源策略，
  和 wb-relay 无关）—— 上面已经对所有来源放开了 CORS，剩下的看你的反代设置。

## 常见调用示例

### Python（装了 openai 库）

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="sk-任意字符串")

r = client.chat.completions.create(
    model="workbuddy-auto",
    messages=[{"role": "user", "content": "你好"}],
    extra_body={"user": "my-script"},   # 用同一个名字 = 同一段连续对话
)
print(r.choices[0].message.content)
```

### Node

```js
const r = await fetch('http://127.0.0.1:8790/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-wb-session': 'my-script' },
  body: JSON.stringify({ model: 'workbuddy-auto', messages: [{ role: 'user', content: '你好' }] }),
});
const j = await r.json();
console.log(j.choices[0].message.content);
```

### 只想要一句话结果（最省事）

```bat
curl -s -X POST http://127.0.0.1:8790/v1/wb/prompt ^
  -H "content-type: application/json" ^
  -d "{\"prompt\":\"用一句话说明什么是反代\"}"
```

### 图形客户端

Cherry Studio、Chatbox、SillyTavern 这类，选「OpenAI 兼容 / 自定义 OpenAI」，然后：

- 接口地址：`http://127.0.0.1:8790/v1`
- 密钥：任意字符串（本机默认不校验）
- 模型名：点「获取模型列表」能拉到全部模型；也可以手动填 `workbuddy-auto`

## 验证

```bat
node smoke-test.js
```

它会另起一个 8791 端口的实例、用独立的临时配置（不碰你的 `config.json`），跑完自己退出并清理。
当前 **35 项全部通过**，覆盖：
- 路径自动定位：首次能找到、来源有记录、配置里没写死路径、缓存写入、
  强制重扫、**目录遍历兜底能找到**（造一个假的安装目录树让它翻）、
  **缓存路径失效后能自动重新找回来**
- 网页控制台：页面能打开、脚本引用的元素都存在、内联脚本语法正确
- 模型：`/v1/models` 返回全部 52 个、含默认别名与真实模型、条目带元数据、
  清单带时间戳、**手动拉取最新模型**
- 代理：SSE 流式对话真调通、**工具白名单模式能起进程**（`-y --allowedTools`）、
  **空白名单也能起进程**（`-y --disallowedTools` 全禁）
- 安全：缺自定义头 403、跨站 Origin 403、本机回环默认免密钥
- 配置：写入成功且落盘、立即反映在状态里、自定义别名生效、奇怪参数给告警不崩、超范围数值夹回上限
- 会话：清空会话

注意其中三次对话是真的调用模型，会消耗你的额度（每次约 1 万 token），不是空跑。

## 两个小坑

- **控制台窗口的中文变成乱码**：Windows 的 cmd 默认用 GBK（代码页 936），而本程序输出的是
  UTF-8。用 `start.cmd` 启动就没这个问题（它开头会把代码页切成 65001）。如果你是直接
  `node wb-relay.js` 启动的，先执行一次 `chcp 65001` 再启动。
- **端口被占**：默认 8790。想换端口用 `--port`，或者去 `config.json` 改 `listen.port`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `wb-relay.js` | 主程序：HTTP 服务、会话池、控制台接口 |
| `locate.js` | 自动定位 WorkBuddy 的 CLI（进程 → PATH → 注册表 → 目录遍历） |
| `models.js` | 读 WorkBuddy 的模型清单（云端缓存 → 内置目录 → 自定义模型） |
| `public/index.html` | 网页控制台（单页，无外部依赖） |
| `config.json` | 配置，首次启动自动生成 |
| `.wb-location.json` | 记住找到的 CLI 路径；删掉它就会重新查找 |
| `start.cmd` | 双击启动（自动找 node） |
| `smoke-test.js` | 冒烟测试 |
| `workspace/` | 会话的工作目录，故意用一个干净空目录，避免把项目规则注入提示词 |

## 已知限制

- **不是逐字流式**。CLI 的 `stream-json` 吐的是「整条消息」，不是 token 增量，所以 SSE 里
  一个 chunk 可能是半句话甚至整句话，不是逐字。客户端能正常显示，但不会有一个字一个字
  蹦出来的效果。
- **客户端传的历史消息会被忽略**（除系统提示词外）。上下文由 WorkBuddy 自己的会话维持。
  所以如果你在客户端里删掉中间几轮再重发，模型看不到这个删除动作 —— 那种场景请用
  `x-wb-new-session: 1` 开新会话。
- **系统提示词只在会话第一次建立时生效**。会话已经跑起来之后再传 `role: "system"` 会被忽略。
- **图片支持有限**：`image_url` 里的 base64 data URL 会转给 CLI，外链图片只转发一个占位文字。
- **模型清单是账号级的**：读的是 WorkBuddy 缓存的云端配置，跟你登录的账号走。清单里理论上
  可用的模型如果在你账号下没开通，选它会返回错误。要彻底确认只能用一次才知道。
- **改权限对所有调用方生效**，不是针对某一个客户端。控制台里打开总开关就等于同时给所有
  连着这个服务的程序放权。
- 只实现了 OpenAI 对话格式。Anthropic 的 `/v1/messages` 没做 —— 要做的话得连工具调用一起
  对齐，半成品反而误导客户端。
