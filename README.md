# 文件监控应用

这个应用程序可以监控本地文件变化，并自动将变化的文件上传到GitHub仓库。

## 功能特性

- 实时监控指定目录中的文件变化
- 自动将变化的文件上传到GitHub仓库
- 支持多个监控项目，可以同时监控多个目录
- Web界面管理监控项目和查看状态
- 支持浏览和管理GitHub仓库

## 系统要求

- Node.js 18+
- Docker (可选，用于容器化部署)

## 安装方法

### 使用Docker（推荐）

1. 克隆此仓库：
   ```bash
   git clone https://github.com/yourusername/file-monitor-app.git
   cd file-monitor-app
   ```

2. 创建环境变量文件：
   ```bash
   cp env.example .env
   ```

3. 编辑`.env`文件，设置你的GitHub凭据和其他配置：
   ```bash
   # GitHub 配置
   GITHUB_TOKEN=your_personal_access_token
   GITHUB_USERNAME=your_github_username
   GITHUB_REPO=your_repo_name
   GITHUB_BRANCH=main
   
   # 要监控的路径
   WATCH_PATH=/app/watched
   ```

4. 启动Docker容器：
   ```bash
   docker-compose up -d
   ```

5. 访问Web界面：
   ```bash
   http://localhost:3000
   ```

### 无Docker安装

1. 克隆此仓库：
   ```bash
   git clone https://github.com/yourusername/file-monitor-app.git
   cd file-monitor-app
   ```

2. 安装依赖：
   ```bash
   npm install
   ```

3. 创建环境变量文件：
   ```bash
   cp env.example .env
   ```

4. 编辑`.env`文件，设置你的GitHub凭据和其他配置。

5. 启动应用：
   ```bash
   npm start
   ```

6. 访问Web界面：
   ```bash
   http://localhost:3000
   ```

## Docker容器说明

本应用使用Node.js 18 Alpine作为基础镜像，不需要任何额外的shell脚本即可运行。应用程序初始化逻辑已经内置到Node.js代码中，简化了部署过程。

### 容器挂载卷

Docker Compose配置中包含以下挂载卷：

- `./projects.json:/app/projects.json` - 保存监控项目配置
- `./repos-info.json:/app/repos-info.json` - 保存GitHub仓库信息
- `./logs:/app/logs` - 存储应用日志
- `./.env:/app/.env` - 环境变量配置
- `./watched:/app/watched` - 默认监控目录

你可以通过设置`WATCH_DIR`环境变量来更改监控目录的挂载：

```bash
WATCH_DIR=/path/to/your/files docker-compose up -d
```

## 使用方法

1. 访问Web界面 `http://localhost:3000`
2. 使用"添加项目"按钮创建新的监控项目
3. 设置项目名称、监控路径、GitHub仓库和分支
4. 启动监控
5. 任何在监控路径中的文件变化将自动上传到GitHub

## GitHub权限

应用需要一个有足够权限访问和修改仓库的个人访问令牌(PAT)。你的Token至少需要以下权限：

- `repo` - 完整的仓库访问权限

## 疑难解答

如果应用无法启动或不能正常工作，请检查：

1. `.env`文件中的配置是否正确
2. 日志文件(`logs/error.log`和`logs/combined.log`)中的错误信息
3. 确保监控的目录存在且有正确的权限
4. 验证GitHub Token是否有效且拥有足够的权限

## 许可

MIT 