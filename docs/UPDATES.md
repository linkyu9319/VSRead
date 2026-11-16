# 版本检查

VSRead 提供手动版本检查和 GitHub 发布页面入口。更新检查读取 `linkyu9319/VSRead` 最新正式 Release，并按 Semantic Versioning 比较当前版本；预发布版本和草稿不会作为更新提示。

## 使用

在阅读器的版本检查入口点击“检查更新”。发现新版本后，打开 [GitHub Releases](https://github.com/linkyu9319/VSRead/releases/latest)，下载发布者提供的 VSIX，通过 IDE 的“从 VSIX 安装…”完成升级。公开仓库的发布信息无需配置 GitHub 令牌。

版本检查不会自动安装扩展，也不会创建 GitHub Release。仓库尚未发布正式版本时会显示相应提示。

## 私有仓库

如果使用私有仓库部署的版本，可在版本检查入口配置 GitHub 个人访问令牌。令牌需要该仓库的 **Contents: Read** 权限，保存在当前 IDE 的 SecretStorage 中；Webview、书库 JSON 和项目文件不会接收或保存令牌。

“清除令牌”会移除当前 IDE 保存的令牌。浏览器打开私有 Release 页面时，仍需登录有权访问该仓库的 GitHub 账号。

未找到版本时，GitHub 可能返回“尚无 Release”或“无仓库访问权限”两种情况；VSRead 将其显示为无法确认更新，不会误报“已是最新版本”。网络错误、令牌失效和访问限流也会显示为无法确认。

## 开发与发布

发布者上传命名规范的正式版本标签（如 `v0.2.0`），创建 Release 并附上对应 VSIX 后，客户端即可发现该版本。仅提交代码或创建 Git 标签不会生成可供检查的 Release。

参考：[GitHub Release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)、[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)。
