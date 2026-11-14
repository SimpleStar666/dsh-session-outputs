# 会话产物目录 dsh-session-outputs

每个对话一个产物文件夹，右侧栏「本对话产物」面板只列出这个对话产出的文件。

## 它解决什么

DSH 里「工作区 = 一个目录 = 会话的 cwd」。同一个工作区下开的每个对话都写进同一个目录，于是「GitHub 限流脚本」和「Minecraft 整合包工具」的文件混在一起，事后分不清哪次对话产出了哪个文件。

装上之后：

```
<你的工作区>/
├── .dsh-outputs/
│   ├── session-1a2b3c4d-…/    ← A 对话的全部产出
│   └── session-9f8e7d6c-…/    ← B 对话的全部产出
└── … 项目原有文件，不受影响
```

同时右侧栏多一个 **「本对话产物」** 页，只列当前对话那一个文件夹里的文件，点一下就在同一栏里预览。

## 为什么是「工作目录」而不是「会话 cwd」

会话创建时记下的 `header.cwd` 是**不可变**的，而且同时是三个东西：沙箱的写根、左栏工作区分组的依据、右侧栏内置文件树的根。改它会导致会话从左栏掉进「未分组」、沙箱被缩到产物文件夹、文件树盯错目录。

工作目录（`workingDirectory` 投影）才是每个工具真正读取的可变根。所以本插件只移动工作目录：写入落进产物文件夹，而上面那三件事都不动。

## 安装

```powershell
# 1) 装进 profile（把路径换成你 checkout 的位置）
dsh plugin --profile desktop add file:C:\path\to\dsh-session-outputs

# 2) 彻底退出 DSH（不是关窗口），再打开
```

也可以用 DSH 界面：**设置 → 插件 → 安装插件**，填本目录的绝对路径。装完必须**完全重启**，只关窗口不算。

## 用法

装好后什么都不用做：照常点「新建对话」。这个对话写下的文件会落在自己的产物文件夹里。

看产物：打开右侧栏 → 点「本对话产物」（或在右栏引导页里点它）。

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里覆盖：

```yaml
- id: session-outputs
  name: dsh-session-outputs
  config:
    enabled: true          # false = 完全停用
    isolate: true          # false = 只建文件夹、不改工作目录
    directory: .dsh-outputs # 产物文件夹的名字（必须是单个文件夹名）
```

| 设置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `isolate` | `true` | 是否把对话的工作目录移进产物文件夹 |
| `directory` | `.dsh-outputs` | 产物文件夹名，放在各工作区根下 |

## 已知限制

- **只影响新对话**。已经存在的对话不会搬家——工作区目录一旦创建就写进会话记录，迁移历史文件不在本插件职责内。
- **只隔离顶层对话**。子代理和 fork 沿用父对话的工作目录，不会各自散开。
- **不阻止你手动切目录**。如果对话中途自己改了工作目录，本插件不会强行拉回。
- **产物文件夹在工作区内**。所以内置「文件」页仍会显示 `.dsh-outputs/`，搜索也能搜到——这是刻意保留的：它保证右栏预览、沙箱、`AGENTS.md` 发现全部照常工作。
- **面板不递归太深**：最多 6 层、400 个文件；超出的部分会明确说明被截断了。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-session-outputs
```

已建的产物文件夹和里面的文件都会保留。想清理就手动删 `.dsh-outputs`。

## 设计说明

- **零依赖、无构建**：Host 半身是纯 ESM，浏览器半身是手写的 `__ModuleLoader__` bundle，只依赖宿主自带的 React。
- **失败不挡路**：建目录或改工作目录失败只记一条 warn，对话照常创建。
- **复用官方 Remote**：面板走 `workspaceFiles.list`，不新开 HTTP 路由，不新增协议，鉴权与越界拦截都由宿主负责。
- 资源注册全部包在 `ctx.effect` 里，卸载即清理。

## 开工前的调研记录

动手前按要求先检索了现成插件，避免重复造轮子。

**检索过的关键词**：`topic:dsh-plugin`、`dsh-plugin 会话 文件 面板 工作区`、`dsh plugin per-session working directory`、`deepseek-harness plugin session cwd sandbox folder per conversation`、`dsh 每个会话 独立工作目录`。

**看过的相关仓库**：

| 仓库 | 它做了什么 | 为什么没有直接用它 |
|---|---|---|
| [stevenwang15/dsh-session-workspace](https://github.com/stevenwang15/dsh-session-workspace) | 包装 `sessionController.create`，把每个新对话注册成**独立工作区** | 只解决隔离的一半，且靠新增工作区实现，左栏会多出一行行工作区；没有"只看本对话产物"的界面 |
| [Tonywqs/dsh-session-folders](https://github.com/Tonywqs/dsh-session-folders) | 同样在 `session.create` 上建时间戳子目录 | 同上，且 `workspace` 模式同样新增工作区层级 |
| [romantic123fly/dsh-session-folders](https://github.com/romantic123fly/dsh-session-folders) · [DieJob/dsh-session-folders](https://github.com/DieJob/dsh-session-folders) | 建子目录并直接写 `working-directory/change` 事件 | 隔离思路与本插件一致；但都没有产物面板，且直接 append 事件属于绕过服务 |
| [ghbhiee/dsh-plugin-workbench](https://github.com/ghbhiee/dsh-plugin-workbench) | 文件浏览器+预览+终端，文件树**锚定当前会话目录** | 功能很强但是"整个工作区"的浏览器，不是"这次对话产出了什么"；且它自己的 README 也说明未覆盖 `bash` 写出的文件 |
| 内置 `ui-sidebar-files` | 右栏文件树 | 根永远是会话 `header.cwd`=工作区根，所有对话看到同一棵树，正是问题的来源 |

**结论：都不完全满足**——隔离的插件没有产物面板，有面板的插件不做隔离，且没有任何一个同时做到"隔离写入 + 左栏不增加层级 + 只列本对话产物"。因此自研，但骨架与 API 用法全部取自官方包源码（`ui-sidebar-files`、`ui-sidebar-right`、`api-workspace-files`、`working-directory`），不凭空设计。

## License

MIT
