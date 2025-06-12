#!/bin/sh
set -e

# 创建必要的目录
mkdir -p /app/logs

# 检查并创建默认的配置文件
if [ ! -f /app/projects.json ]; then
  echo "创建默认的projects.json文件..."
  echo "[]" > /app/projects.json
fi

if [ ! -f /app/repos-info.json ]; then
  echo "创建默认的repos-info.json文件..."
  echo "[]" > /app/repos-info.json
fi

# 检查环境变量文件是否存在，如果不存在则创建默认的.env文件
if [ ! -f /app/.env ]; then
  echo "创建默认的.env文件..."
  cat > /app/.env << EOF
# 要监控的路径
WATCH_PATH=/app/watched

# GitHub 配置
GITHUB_TOKEN=default_token_please_change
GITHUB_USERNAME=default_username_please_change
GITHUB_REPO=default_repo_please_change
GITHUB_BRANCH=main

# 自动提交消息
COMMIT_MESSAGE=Auto-commit: 文件更新

# 忽略的文件/文件夹模式（逗号分隔）
IGNORED_PATTERNS=node_modules,.git,*.tmp

# 防抖时间（毫秒）
DEBOUNCE_TIME=2000

# 日志级别 (error, warn, info, verbose, debug, silly)
LOG_LEVEL=info
EOF
  echo "已创建默认的.env文件，请在容器运行后修改为正确的配置。"
  echo "警告: 使用了默认的GitHub凭据，某些GitHub相关功能可能无法正常工作。"
  echo "您可以通过环境变量覆盖这些设置，或者挂载自定义的.env文件。"
fi

# 检查环境变量
if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_USERNAME" ]; then
  echo "警告: GITHUB_TOKEN 或 GITHUB_USERNAME 未设置或使用了默认值。"
  echo "请在.env文件中或通过环境变量设置这些值。"
  echo "为了确保应用能正常启动，将使用默认值继续运行，但GitHub相关功能可能无法使用。"
  
  # 设置默认的环境变量，确保应用能启动
  export GITHUB_TOKEN=${GITHUB_TOKEN:-"default_token_for_startup"}
  export GITHUB_USERNAME=${GITHUB_USERNAME:-"default_username_for_startup"}
fi

# 执行传入的命令
exec "$@" 