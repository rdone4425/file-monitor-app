FROM node:18-alpine

# 创建应用目录
WORKDIR /app

# 安装应用依赖
# 首先复制package.json和package-lock.json
COPY package*.json ./
RUN npm install

# 创建必要的目录
RUN mkdir -p /app/logs /app/watched

# 复制应用源代码
COPY . .

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 暴露端口
EXPOSE 3000

# 添加初始化代码到应用程序启动前
CMD ["node", "src/web-server.js"] 