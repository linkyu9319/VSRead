# 在线书源

VSRead 通过可配置的 HTML 规则读取网站。网络请求由 Extension Host 完成；页面脚本不会执行，阅读区仅展示提取后的纯文本。

## 导入

打开“在线书源”，粘贴书源 JSON 或填写 JSON 订阅地址。支持单个对象和对象数组；每次最多导入 200 个书源。导入结果会逐项报告不支持的规则。书源可以停用或移除。

[Project Gutenberg 示例](../examples/sources/gutenberg.json) 使用公开图书目录，可点击“公版示例”导入，随后搜索 `Pride and Prejudice` 等作品。此示例把网站提供的整书 HTML 作为一个全文条目，不拆分页内章节，也不提供搜索翻页。网络内容的获取与缓存由用户操作触发，VSRead 不会自动导入或访问示例书源。

## 格式

兼容阅读（Legado）书源的以下字段：

| 字段 | 用途 |
| --- | --- |
| `bookSourceName` / `bookSourceUrl` | 名称与基础网址 |
| `searchUrl` | GET 搜索地址，支持 `{{key}}` 和 `{{page}}` |
| `ruleSearch` | `bookList`、`name`、`author`、`bookUrl` |
| `ruleBookInfo` | 可选的 `name`、`author`、`tocUrl` |
| `ruleToc` | `chapterList`、`chapterName`、`chapterUrl` |
| `ruleContent` | `content` |

选择器使用 CSS；如 `.book-list a@href`、`.title@text`、`#content@html`。`@html` 提取后仍会转换成纯文本并保留段落。`@text` / `@textNodes` 读取文本，`@href`、`@src`、`@content`、`@title` 和 `@data-*` 读取属性。兼容常见的 `class.`、`id.`、`tag.` 前缀与数字索引，例如 `class.book@tag.a.0@href`。

不支持 JavaScript、XPath、JSONPath、POST、登录/请求头规则、正则替换和目录/正文多页拼接。含这些必要规则的书源会被拒绝，不能视为完整 Legado 引擎兼容。字段设计参考 [LegadoC 的公开书源模型](https://github.com/CCSSNE/legadoC/blob/own/app/src/main/java/io/legado/app/data/entities/BookSource.kt)，解析逻辑独立实现。

## 阅读与缓存

搜索结果加入在线书架后会保存目录。打开章节时优先读取本地缓存；已缓存章节及阅读位置可在断网后恢复。移除或停用书源不会删除已缓存正文。

刷新目录按章节网址匹配已读位置与缓存，插入新章节不会把旧缓存分配给错误章节。可手动刷新正文、缓存后续 1–20 章或清理当前书籍缓存。单本缓存上限 100 MB，在线缓存总上限 200 MB；移除在线书籍会一并移除其缓存。

请求仅支持公开 HTTP / HTTPS 地址，书籍及章节应与书源网址同源。默认单页响应上限 2 MB、超时 15 秒、最多跳转 3 次；本机、私有网络地址和含 URL 凭据的地址不能作为书源。UTF-8、GBK / GB18030 等编码在宿主侧解码。
