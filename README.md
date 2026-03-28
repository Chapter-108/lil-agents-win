# 桌面宠物（Windows 适配版）

基于 `lil-agents` 思路进行学习与适配的项目，当前包含：
- `LilAgentsWin`：Windows 版 Electron 客户端（可运行、可打包）
- `Sounds`：原有 macOS 侧 Swift 代码（保留参考）

## 本地运行（Windows）

1. 进入项目目录：
   - `cd LilAgentsWin`
2. 安装依赖：
   - `pnpm install`
3. 若首次启动缺 Electron，可执行：
   - `pnpm run postinstall`
4. 启动应用：
   - `pnpm start`

## 打包

在 `LilAgentsWin` 目录执行：
- `pnpm run pack`

产物输出到：
- `LilAgentsWin/dist`

## 上传 GitHub（完整步骤）

在项目根目录执行：

1. 初始化仓库：
   - `git init`
2. 关联远程仓库：
   - `git branch -M main`
   - `git remote add origin https://github.com/Chapter-108/<repo-name>.git`
3. 提交并推送：
   - `git add .`
   - `git commit -m "chore: initial upload"`
   - `git push -u origin main`

## 上传前检查（建议）

- 确认未提交 `node_modules`、`dist`、`.env`、密钥文件
- 确认可正常安装与启动（`pnpm install` + `pnpm start`）
- 建议首次先私有仓库，确认后再公开
- 如需自定义托盘“检查更新”跳转地址，可在启动前设置环境变量：
  - `LIL_AGENTS_WIN_RELEASES_URL=https://github.com/Chapter-108/lil-agents-win/releases`

## 尊重原创

本项目尊重原创与开源协议。  
若涉及引用或改编，均保留来源说明并标注原项目：

- 原项目：`ryanstephen/lil-agents`
- 链接：<https://github.com/ryanstephen/lil-agents>

本仓库为学习/适配版本，不代表原作者官方发布。
