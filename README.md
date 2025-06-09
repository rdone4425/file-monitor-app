# 文件监控自动上传 GitHub 工具

这是一个用 Node.js 开发的应用程序，可以监控本地文件或文件夹的变化，并通过 GitHub API 自动将这些变化上传到 GitHub 仓库。

## 功能特点

- 实时监控指定目录的文件变化
- 使用 GitHub API 自动上传文件变更
- 使用 Token 和用户名严格认证
- 支持防抖设置，避免频繁上传
- 完整的日志记录
- 可通过 Docker 部署

## 安装

### 本地安装

1. 克隆仓库：
   ```bash
   git clone https://github.com/yourusername/file-monitor-app.git
   cd file-monitor-app
   ```

2. 安装依赖：
   ```bash
   npm install
   ```

3. 创建环境变量文件 `.env`：
   ```
   # 要监控的路径
   WATCH_PATH=/path/to/watch
   
   # GitHub 配置
   GITHUB_TOKEN=your_personal_access_token
   GITHUB_USERNAME=your_github_username
   GITHUB_REPO=your_repo_name
   GITHUB_BRANCH=main
   
   # 自动提交消息
   COMMIT_MESSAGE=Auto-commit: 文件更新
   
   # 忽略的文件/文件夹模式（逗号分隔）
   IGNORED_PATTERNS=node_modules,.git,*.tmp
   
   # 防抖时间（毫秒）
   DEBOUNCE_TIME=2000
   
   # 日志级别 (error, warn, info, verbose, debug, silly)
   LOG_LEVEL=info
   ```

4. 启动应用：
   ```bash
   npm start
   ```

### Docker 安装

1. 构建 Docker 镜像：
   ```bash
   docker build -t file-monitor-app .
   ```

2. 运行 Docker 容器：
   ```bash
   docker run -d \
     -v /path/to/watch:/app/watched \
     -e WATCH_PATH=/app/watched \
     -e GITHUB_TOKEN=your_personal_access_token \
     -e GITHUB_USERNAME=your_github_username \
     -e GITHUB_REPO=your_repo_name \
     -e GITHUB_BRANCH=main \
     -e COMMIT_MESSAGE="Auto-commit: 文件更新" \
     --name file-monitor \
     file-monitor-app
   ```

## 使用说明

1. 获取 GitHub 个人访问令牌（Personal Access Token）:
   - 访问 GitHub 设置页面: https://github.com/settings/tokens
   - 点击 "Generate new token"
   - 选择 "repo" 作用域（允许完全访问仓库）
   - 生成并复制令牌字符串
   - 将令牌字符串添加到 `.env` 文件中的 `GITHUB_TOKEN` 变量

2. 配置要监控的目录和 GitHub 仓库信息：
   - 设置 `WATCH_PATH` 为你想要监控的本地目录
   - 设置 `GITHUB_USERNAME` 为你的 GitHub 用户名
   - 设置 `GITHUB_REPO` 为你要上传文件的仓库名称

3. 启动应用后，它将开始监控指定目录。当文件发生变化时，变化会自动上传到 GitHub 仓库。

## 安全说明

- 本应用使用 GitHub 个人访问令牌进行认证，这是一种安全的认证方式
- 应用会验证令牌的有效性，并确认令牌所属的用户与配置的用户名匹配
- 为了保护你的令牌安全，请确保：
  - 不要将包含令牌的 `.env` 文件提交到版本控制系统
  - 给予令牌最小必要的权限（只需要 "repo" 作用域）
  - 定期轮换令牌

## 注意事项

- 为了避免频繁上传，应用使用了防抖机制，默认情况下会在最后一次文件变化后等待 2 秒再进行上传
- 如果监控大型目录，请适当调整 `IGNORED_PATTERNS` 来排除不需要监控的文件/文件夹
- GitHub API 有速率限制，如果你频繁上传大量文件，可能会触发限制

## 许可证

MIT 