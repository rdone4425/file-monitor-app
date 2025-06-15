import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * 创建文件监控器
 * @param {string} watchPath - 要监控的路径
 * @param {Array<string>} ignoredPatterns - 要忽略的文件/文件夹模式
 * @param {number} debounceTime - 防抖时间（毫秒）
 * @param {Function} onChange - 文件变化时的回调函数
 * @returns {object} - 文件监控器实例
 */
export function createWatcher(watchPath, ignoredPatterns, debounceTime, onChange) {
  // 存储变化的文件
  let changedFiles = [];
  let debounceTimer = null;
  
  // 检查路径是否存在
  if (!fs.existsSync(watchPath)) {
    logger.error(`监控路径不存在: ${watchPath}`);
    logger.warn(`将继续尝试监控该路径，但可能不会检测到任何变化，直到路径被创建`);
  }
  
  // 尝试检查路径类型，如果路径存在
  let isFile = false;
  try {
    const stats = fs.existsSync(watchPath) ? fs.statSync(watchPath) : null;
    isFile = stats ? stats.isFile() : false;
  } catch (error) {
    logger.error(`无法获取路径信息: ${watchPath}, 错误: ${error.message}`);
    logger.warn('将假设这是一个目录路径');
  }
  
  // 如果是文件，则监控该文件的目录，但只关注该文件
  const watchTarget = isFile ? path.dirname(watchPath) : watchPath;
  
  // 创建监控器实例
  const watcher = chokidar.watch(watchTarget, {
    ignored: (filePath) => {
      // 如果是单个文件监控，只关注该特定文件
      if (isFile && filePath !== watchPath) {
        return true;
      }
      
      // 应用忽略模式
      return ignoredPatterns.some(pattern => {
        if (pattern.startsWith('*')) {
          const ext = pattern.substring(1);
          return filePath.endsWith(ext);
        }
        return path.basename(filePath) === pattern || filePath.includes(`/${pattern}/`);
      }) || /(^|[\/\\])\./.test(filePath); // 忽略以点开头的文件/文件夹（如 .git）
    },
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });
  
  // 注册所有文件事件
  ['add', 'change', 'unlink'].forEach(event => {
    watcher.on(event, (filePath) => {
      // 如果是单个文件监控，确保只处理目标文件
      if (isFile && filePath !== watchPath) {
        return;
      }
      
      logger.info(`文件 ${event}: ${filePath}`);
      
      // 添加到变化列表
      if (!changedFiles.includes(filePath)) {
        changedFiles.push(filePath);
      }
      
      // 重置防抖计时器
      clearTimeout(debounceTimer);
      
      // 设置新计时器
      debounceTimer = setTimeout(() => {
        if (changedFiles.length > 0) {
          // 调用回调函数
          onChange([...changedFiles]);
          // 清空变化列表
          changedFiles = [];
        }
      }, debounceTime);
    });
  });
  
  // 监控器就绪事件
  watcher.on('ready', () => {
    if (isFile) {
      logger.info(`开始监控文件: ${watchPath}`);
    } else {
      logger.info(`初始扫描完成，开始监控目录: ${watchPath}`);
    }
  });
  
  // 监控器错误事件
  watcher.on('error', (error) => {
    logger.error(`监控错误: ${error}`);
  });
  
  return watcher;
} 