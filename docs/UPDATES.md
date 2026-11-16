# 版本更新

VSRead 从 `linkyu9319/VSRead` 的最新正式 GitHub Release 检查更新，按 Semantic Versioning 比较版本，不使用预发布版本或草稿。检查和安装均由用户主动操作，不在后台静默升级。

## 一键更新

1. 在阅读器中点击“检查更新”。
2. 发现新版本后，点击“一键更新”。
3. IDE 显示下载与安装进度；下载阶段可在进度通知中取消，取消不会替换当前版本。
4. 安装成功后点击“重载窗口”，使新版生效。进入 IDE 安装阶段后，请等待安装结果。

**0.1.8 及更早版本尚无一键更新功能。** 请先从 [GitHub Releases](https://github.com/linkyu9319/VSRead/releases/latest) 下载 0.1.9 的 VSIX，使用 IDE 的“从 VSIX 安装…”覆盖安装并重载，之后即可通过一键更新升级。同一 IDE 用户配置中的书库、进度和偏好会保留。

公开仓库无需配置 GitHub 令牌。“查看发布页”始终提供手动安装入口；缺少安装包、没有有效的 SHA-256 摘要、下载或安装失败时，可在发布页下载 VSIX 手动安装。

## 安装包校验

一键更新仅选择对应正式 Release 中的 `vsread-<版本号>.vsix`。安装前检查下载文件大小、GitHub 提供的 SHA-256 摘要，以及包内的扩展名称 `vsread`、发布者 `vsread-local` 和版本号。校验通过后才交给 IDE 安装；缺少校验信息或校验失败时停止一键安装。

VS Code 原生自动更新使用配置的扩展市场，不会追踪 GitHub Release；通过 VSIX 安装时，原生自动更新默认关闭。VSRead 的一键更新独立于市场更新。参见 [VS Code 扩展更新说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_extension-autoupdate)。

## 私有仓库

如果使用私有仓库部署的版本，可在更新面板配置 GitHub 个人访问令牌。令牌需要该仓库的 **Contents: Read** 权限，保存在当前 IDE 的 SecretStorage 中；Webview、书库 JSON 和项目文件不会接收或保存令牌。

“清除令牌”会移除当前 IDE 保存的令牌。浏览器打开私有 Release 页面时，仍需登录有权访问该仓库的 GitHub 账号。

未找到版本时，GitHub 可能返回“尚无 Release”或“无仓库访问权限”两种情况；VSRead 将其显示为无法确认更新，不会误报“已是最新版本”。网络错误、令牌失效和访问限流也会显示为无法确认。

## 开发与发布

发布者创建正式版本标签（如 `v0.2.0`）和 Release，并上传对应的 `vsread-0.2.0.vsix`。一键更新要求 GitHub Release API 返回该附件的有效 SHA-256 摘要。仅提交代码或创建 Git 标签不会生成可供检查的 Release。

参考：[GitHub Release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)、[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)。
