import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { createWatcher } from './watcher.js';
import { GitHubApiService } from './github-api.js';
import { logger } from './logger.js';
import fs from 'fs';
import { startServer } from './web-server.js';

// 加载环境变量
dotenv.config();

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 从绝对路径获取相对路径
 * @param {string} absolutePath - 绝对路径
 * @param {string} basePath - 基础路径
 * @returns {string} - 相对路径
 */
function getRelativePath(absolutePath, basePath) {
  return path.relative(basePath, absolutePath).replace(/\\/g, '/');
}

async function startMonitoring() {
  try {
    // 要监控的路径（从环境变量获取或使用默认值）
    const watchPath = process.env.WATCH_PATH || path.resolve(process.cwd(), 'watched');
    
    // GitHub 仓库相关配置
    const githubToken = process.env.GITHUB_TOKEN;
    const githubUsername = process.env.GITHUB_USERNAME;
    const githubRepo = process.env.GITHUB_REPO;
    const githubBranch = process.env.GITHUB_BRANCH || 'main';
    const commitMessage = process.env.COMMIT_MESSAGE || 'Auto-commit: 文件更新';
    
    // 忽略的文件/文件夹模式
    const ignoredPatterns = process.env.IGNORED_PATTERNS 
      ? process.env.IGNORED_PATTERNS.split(',') 
      : ['node_modules', '.git', '*.tmp'];
      
    // 配置延迟提交时间（毫秒），防止频繁提交
    const debounceTime = parseInt(process.env.DEBOUNCE_TIME || '2000', 10);
    
    // 验证必要的环境变量
    if (!githubToken || !githubUsername || !githubRepo) {
      logger.error('缺少必要的环境变量: GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO');
      logger.info('请通过 Web 界面配置这些信息: http://localhost:3000/config');
      return false;
    }
    
    logger.info(`启动文件监控应用`);
    logger.info(`监控路径: ${watchPath}`);
    logger.info(`GitHub 用户: ${githubUsername}`);
    logger.info(`GitHub 仓库: ${githubRepo}`);
    logger.info(`GitHub 分支: ${githubBranch}`);
    
    // 初始化 GitHub API 服务
    const githubService = new GitHubApiService(
      githubToken,
      githubUsername,
      githubRepo,
      githubBranch
    );
    
    // 验证 token 有效性
    const isTokenValid = await githubService.validateToken();
    if (!isTokenValid) {
      logger.error('GitHub Token 无效或与用户名不匹配，请检查配置');
      logger.info('请通过 Web 界面重新配置: http://localhost:3000/config');
      return false;
    }
    
    // 创建并启动文件监控
    createWatcher(watchPath, ignoredPatterns, debounceTime, async (changedFiles) => {
      try {
        logger.info(`检测到文件变化: ${changedFiles.length} 个文件被修改`);
        
        if (changedFiles.length > 0) {
          // 准备上传文件
          const filesToUpload = changedFiles
            .filter(file => fs.existsSync(file)) // 过滤掉已删除的文件
            .map(file => ({
              localPath: file,
              repoPath: getRelativePath(file, watchPath)
            }));
          
          // 上传文件
          if (filesToUpload.length > 0) {
            const uploadResults = await githubService.uploadFiles(filesToUpload, commitMessage);
            
            // 输出上传结果
            const successCount = uploadResults.filter(r => r.success).length;
            const failCount = uploadResults.length - successCount;
            
            logger.info(`上传完成: ${successCount} 成功, ${failCount} 失败`);
            
            // 记录失败的文件
            if (failCount > 0) {
              uploadResults
                .filter(r => !r.success)
                .forEach(r => logger.error(`文件 ${r.file.repoPath} 上传失败: ${r.error}`));
            }
          }
          
          // 处理已删除的文件
          const deletedFiles = changedFiles
            .filter(file => !fs.existsSync(file))
            .map(file => getRelativePath(file, watchPath));
          
          if (deletedFiles.length > 0) {
            logger.info(`处理已删除的文件: ${deletedFiles.length} 个`);
            
            for (const filePath of deletedFiles) {
              try {
                await githubService.deleteFile(filePath, `删除文件: ${filePath}`);
              } catch (error) {
                logger.error(`删除远程文件 ${filePath} 失败: ${error.message}`);
              }
            }
          }
        }
      } catch (error) {
        logger.error(`GitHub 操作失败: ${error.message}`);
      }
    });
    
    logger.info('监控已启动，等待文件变化...');
    return true;
  } catch (error) {
    logger.error(`应用启动失败: ${error.message}`);
    return false;
  }
}

async function main() {
  // 启动 Web 服务器
  const webPort = process.env.WEB_PORT || 3000;
  const server = startServer(webPort);
  
  // 尝试启动文件监控
  const monitoringStarted = await startMonitoring();
  
  if (!monitoringStarted) {
    logger.info('文件监控未启动，请通过 Web 界面完成配置');
  }
}

main(); 