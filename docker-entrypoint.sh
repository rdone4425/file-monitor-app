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

# 检查环境变量
if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_USERNAME" ]; then
  echo "警告: GITHUB_TOKEN 或 GITHUB_USERNAME 未设置。某些功能可能无法正常工作。"
  echo "请在.env文件中或通过环境变量设置这些值。"
fi

# 执行传入的命令
exec "$@" 