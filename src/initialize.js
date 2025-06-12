import fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 应用根目录
const appRoot = path.dirname(__dirname);

/**
 * 初始化应用程序所需的文件和目录
 */
export async function initialize() {
  try {
    // 创建必要的目录
    const logsDir = path.join(appRoot, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    
    // 检查并创建默认的配置文件
    const projectsFile = path.join(appRoot, 'projects.json');
    if (!existsSync(projectsFile)) {
      logger.info("创建默认的projects.json文件...");
      writeFileSync(projectsFile, "[]");
    }
    
    const reposInfoFile = path.join(appRoot, 'repos-info.json');
    if (!existsSync(reposInfoFile)) {
      logger.info("创建默认的repos-info.json文件...");
      writeFileSync(reposInfoFile, "[]");
    }
    
    // 检查环境变量文件是否存在，如果不存在则创建默认的.env文件
    const envFile = path.join(appRoot, '.env');
    if (!existsSync(envFile)) {
      logger.info("创建默认的.env文件...");
      const defaultEnv = `# 要监控的路径
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
LOG_LEVEL=info`;
      writeFileSync(envFile, defaultEnv);
      
      logger.info("已创建默认的.env文件，请在容器运行后修改为正确的配置。");
      logger.warn("警告: 使用了默认的GitHub凭据，某些GitHub相关功能可能无法正常工作。");
      logger.info("您可以通过环境变量覆盖这些设置，或者挂载自定义的.env文件。");
    }
    
    // 检查环境变量
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_USERNAME || 
        process.env.GITHUB_TOKEN === 'default_token_please_change' || 
        process.env.GITHUB_USERNAME === 'default_username_please_change') {
      logger.warn("警告: GITHUB_TOKEN 或 GITHUB_USERNAME 未设置或使用了默认值。");
      logger.info("请在.env文件中或通过环境变量设置这些值。");
      logger.warn("为了确保应用能正常启动，将使用默认值继续运行，但GitHub相关功能可能无法使用。");
      
      // 设置默认的环境变量，确保应用能启动
      if (!process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN === 'default_token_please_change') {
        process.env.GITHUB_TOKEN = "default_token_for_startup";
      }
      
      if (!process.env.GITHUB_USERNAME || process.env.GITHUB_USERNAME === 'default_username_please_change') {
        process.env.GITHUB_USERNAME = "default_username_for_startup";
      }
    }
    
    logger.info("应用程序初始化完成");
    return true;
  } catch (error) {
    logger.error(`初始化失败: ${error.message}`);
    return false;
  }
} 