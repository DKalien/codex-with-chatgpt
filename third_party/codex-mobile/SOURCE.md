# Codex Mobile 来源与适配范围

Desktop named pipe 的帧格式、初始化、owner discovery、状态跟随和
`thread-follower-start-turn` 请求形状参考以下固定上游版本：

- 仓库：`NathanZane/codex-mobile`
- commit：`f79e6807ca0b9d6052afd24f822ee41b9a52e07d`
- 许可证：MIT，完整文本见同目录 `LICENSE`
- 参考文件：
  - [`src/codex/CodexDesktopIpcClient.ts`](https://github.com/NathanZane/codex-mobile/blob/f79e6807ca0b9d6052afd24f822ee41b9a52e07d/src/codex/CodexDesktopIpcClient.ts)
    （SHA-256：`3efc2f0b9c5821ac85927485baa16c8938602b0446404823aee9bb467b5a2b0d`）
  - [`src/platform.ts`](https://github.com/NathanZane/codex-mobile/blob/f79e6807ca0b9d6052afd24f822ee41b9a52e07d/src/platform.ts)
    （SHA-256：`24eb299ec519382e0f5e2ac1fae0fba75eec5c1634578f5eb285e42ba8cdb29f`）

本项目仅采用协议形状和平台判断思路，并在
`src/desktop/helper/desktop_ipc.py` 中按已验证的本机 Desktop/app-server
版本重新实现。未复制上游运行时、未安装 Discord 集成，也不执行上游安装脚本。
内部 Windows IPC 版本门禁、进程/owner/cwd 校验、普通 token 校验和一次性投递
语义属于本项目实现；未知版本会停止并返回错误。
