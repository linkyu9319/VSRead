# VSRead

VSRead 是面向 CodeBuddy IDE 和 Visual Studio Code 的电子书阅读扩展，支持本地 EPUB、TXT、PDF，以及可配置的在线书源。书库、阅读进度、偏好和章节缓存保存在本机。

## 功能

| 内容 | 支持能力 |
| --- | --- |
| EPUB | 目录、图片与样式、元数据、分页与滚动阅读、CFI 位置恢复 |
| TXT | UTF-8、GBK / GB18030、UTF-16 编码识别，章节识别与分块阅读 |
| PDF | 按需读取、缩放与翻页、目录、文字选择与搜索、页码恢复 |
| 在线书源 | JSON 导入、启用与停用、在线搜索、章节阅读、目录刷新与本地缓存 |

- 书架管理、阅读进度自动保存与恢复。
- 跟随 IDE、浅色、深色及自定义配色。
- TXT / EPUB 正文字号、行距与字体设置；PDF 缩放设置。
- GitHub 正式版本检查与发布页面入口。

## 安装与使用

1. 在 IDE 扩展面板选择 **从 VSIX 安装…**，安装对应版本的 VSIX 文件。
2. 点击活动栏中的 **VSRead** 书本图标，选择“打开阅读器”。
3. 在书架中导入本地电子书，或进入“在线书源”配置来源。

也可通过命令面板执行 `VSRead: 打开阅读器`、`VSRead: 导入本地电子书`。升级时覆盖安装即可，同一 IDE 用户配置中的书库和进度会保留。

阅读器右上角提供“我的书架”和“阅读设置”。设置支持点击面板外区域或按 `Esc` 关闭。

## 在线书源

书源通过 JSON 文件内容或 URL 导入，支持 VSRead 配置及部分阅读（Legado）声明式 HTML 规则。可启用来源、搜索书籍、加入在线书架，并将章节缓存到本机。

当前支持 CSS 选择器与文本、属性提取规则；不执行书源 JavaScript，不支持 XPath、动态脚本、登录或验证码处理。复杂规则需转换为支持的配置格式。可通过“公版示例”导入 Project Gutenberg 配置；不会在后台自动导入或查询，访问能力取决于目标站点及所配置规则。

配置格式、兼容范围和示例见 [书源配置](docs/BOOK_SOURCES.md)。

## 版本更新

通过版本检查入口查询 GitHub 最新正式 Release，并打开发布页面下载安装包。私有仓库可配置 GitHub 读取令牌，令牌由 IDE SecretStorage 保存。详见 [版本检查](docs/UPDATES.md)。

## 数据与限制

数据存放于 IDE 分配给 `vsread-local.vsread` 的全局存储目录。不同 IDE 和用户配置的书库相互独立；备份时应复制整个存储目录。

- TXT 单文件上限 100 MB；EPUB / PDF 上限 256 MB。
- EPUB 进度百分比为近似值，位置恢复以 CFI 为准。
- PDF 保留原稿纸色与固定排版；扫描件支持显示，暂不提供 OCR。
- 暂不支持 DRM 电子书、密码保护 PDF、MOBI / AZW3。
- 书签、高亮、评论和笔记管理仍在后续计划中。

## 开发

环境要求：Node.js 22.13+、VS Code API 1.85+。

```sh
npm ci
npm run check
npm run test:browser
```

在 IDE 中按 `F5` 启动扩展调试。常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建 Extension Host、TXT Worker 与 Webview |
| `npm run watch` | 监听源码并重新构建 |
| `npm run typecheck` | TypeScript 检查 |
| `npm test` | 运行底层测试，需先构建 |
| `npm run package` | 构建检查并生成 VSIX |

浏览器回归使用模拟 Extension Host；IDE 验收步骤见 [手动验收清单](docs/MANUAL_TEST.md)。变更记录见 [CHANGELOG](CHANGELOG.md)。

## 许可证

项目采用 [MIT](LICENSE) 许可证。所用组件及许可文本见 [第三方声明](THIRD_PARTY_NOTICES.md)。
