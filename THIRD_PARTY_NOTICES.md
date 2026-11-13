# 第三方组件声明

VSRead 使用以下主要组件：

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| epub.js (`epubjs`) | EPUB 解包、排版、目录与 CFI | BSD-2-Clause |
| PDF.js (`pdfjs-dist`) | PDF 解析、Worker、页面和文字层 | Apache-2.0；部分字体、CMap、WASM 资源另附许可 |
| React / React DOM | Webview 界面 | MIT |
| iconv-lite | TXT 编码解码 | MIT |
| Cheerio | 在线书源 HTML 与 CSS 规则解析 | MIT |

这些组件及已安装的生产依赖、传递依赖的版本、声明许可和原始许可文本，汇总于：

**[`media/licenses/THIRD_PARTY_LICENSES.txt`](media/licenses/THIRD_PARTY_LICENSES.txt)**

该文件由 `node scripts/licenses.mjs` 根据当前安装依赖生成，并随 VSIX 分发。清单采取保守范围，包含已安装生产依赖图中可能被打包器裁剪的依赖；它不代表每个列出的文件都会参与运行。

PDF.js 的内置字体、CMap 和 WASM 子目录中的许可声明也一并收集。少数上游包（`marks-pane`、类型占位包 `@types/localforage`）没有附带独立许可文件，汇总文件保留其 `package.json` 许可声明；`path-webpack` 另附其 README 指明的 Node.js v7.0.0 路径实现相关许可。第三方原始声明保留其自身版权与条款；VSRead 的 MIT 许可不替代这些条款。

VSRead 没有移植 LegadoC、LightRead 或 foliate-js 的代码。项目中的测试 EPUB、TXT、PDF 由本项目样例生成器创建。
