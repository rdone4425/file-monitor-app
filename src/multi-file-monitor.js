import { createWatcher } from './watcher.js';
import { logger } from './logger.js';
import path from 'path';
import { existsSync } from 'fs';

/**
 * 多文件监控器
 * 用于处理多个文件/目录的监控，支持优先级和分组
 */
export class MultiFileMonitor {
  /**
   * 构造函数
   * @param {object} options - 配置选项
   */
  constructor(options = {}) {
    this.options = {
      debounceTime: 2000,
      maxConcurrentUploads: 3,
      ...options
    };
    
    // 存储活跃的监控任务
    this.watchers = new Map();
    
    // 存储文件变更队列
    this.changeQueue = {
      high: [],
      medium: [],
      low: []
    };
    
    // 文件变更回调集合
    this.changeCallbacks = [];
    
    // 处理队列的标志
    this.isProcessingQueue = false;
  }
  
  /**
   * 添加监控路径
   * @param {string} id - 监控ID
   * @param {string} filePath - 文件或目录路径
   * @param {Array} ignoredPatterns - 忽略的文件模式
   * @param {string} priority - 优先级 (high, medium, low)
   * @param {object} metadata - 附加元数据
   * @returns {boolean} - 是否成功添加
   */
  addWatchPath(id, filePath, ignoredPatterns = [], priority = 'medium', metadata = {}) {
    // 检查路径是否存在
    if (!existsSync(filePath)) {
      logger.error(`路径不存在: ${filePath}`);
      return false;
    }
    
    // 如果已存在相同ID的监控，先停止它
    if (this.watchers.has(id)) {
      this.removeWatchPath(id);
    }
    
    try {
      // 创建监控器
      const watcher = createWatcher(
        filePath, 
        ignoredPatterns, 
        this.options.debounceTime, 
        (changedFiles) => this._handleFileChanges(id, changedFiles, priority, metadata)
      );
      
      // 存储监控器
      this.watchers.set(id, {
        watcher,
        path: filePath,
        ignoredPatterns,
        priority,
        metadata
      });
      
      logger.info(`已添加监控 [${priority}]: ${filePath} (ID: ${id})`);
      return true;
    } catch (error) {
      logger.error(`添加监控失败 ${filePath}: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 移除监控路径
   * @param {string} id - 监控ID
   * @returns {boolean} - 是否成功移除
   */
  removeWatchPath(id) {
    if (!this.watchers.has(id)) {
      return false;
    }
    
    try {
      const { watcher, path: filePath } = this.watchers.get(id);
      
      // 关闭监控
      watcher.close();
      
      // 从映射中移除
      this.watchers.delete(id);
      
      logger.info(`已移除监控: ${filePath} (ID: ${id})`);
      return true;
    } catch (error) {
      logger.error(`移除监控失败 (ID: ${id}): ${error.message}`);
      return false;
    }
  }
  
  /**
   * 添加文件变更回调
   * @param {Function} callback - 回调函数
   */
  onFileChange(callback) {
    if (typeof callback === 'function') {
      this.changeCallbacks.push(callback);
    }
  }
  
  /**
   * 获取所有监控的路径
   * @returns {Array} - 监控路径列表
   */
  getWatchedPaths() {
    const paths = [];
    
    for (const [id, { path: filePath, priority, metadata }] of this.watchers.entries()) {
      paths.push({
        id,
        path: filePath,
        priority,
        metadata
      });
    }
    
    return paths;
  }
  
  /**
   * 按优先级获取监控列表
   * @param {string} priority - 优先级
   * @returns {Array} - 匹配的监控列表
   */
  getWatchersByPriority(priority) {
    const result = [];
    
    for (const [id, data] of this.watchers.entries()) {
      if (data.priority === priority) {
        result.push({ id, ...data });
      }
    }
    
    return result;
  }
  
  /**
   * 处理文件变更
   * @param {string} id - 监控ID
   * @param {Array} changedFiles - 变更文件列表
   * @param {string} priority - 优先级
   * @param {object} metadata - 元数据
   * @private
   */
  _handleFileChanges(id, changedFiles, priority, metadata) {
    if (changedFiles.length === 0) {
      return;
    }
    
    // 添加到对应优先级的队列
    this.changeQueue[priority].push({
      id,
      timestamp: Date.now(),
      files: changedFiles,
      metadata
    });
    
    logger.debug(`添加到 ${priority} 优先级队列: ${changedFiles.length} 文件来自 ID: ${id}`);
    
    // 开始处理队列（如果尚未处理）
    if (!this.isProcessingQueue) {
      this._processChangeQueue();
    }
  }
  
  /**
   * 处理变更队列
   * @private
   */
  async _processChangeQueue() {
    // 设置处理标志
    this.isProcessingQueue = true;
    
    try {
      // 按优先级顺序处理: high -> medium -> low
      const priorities = ['high', 'medium', 'low'];
      
      for (const priority of priorities) {
        const queue = this.changeQueue[priority];
        
        if (queue.length === 0) {
          continue;
        }
        
        logger.info(`处理 ${priority} 优先级队列: ${queue.length} 批次`);
        
        // 处理当前优先级的队列
        const batchesToProcess = [...queue];
        this.changeQueue[priority] = []; // 清空当前优先级队列
        
        // 同步调用所有回调
        for (const batch of batchesToProcess) {
          for (const callback of this.changeCallbacks) {
            try {
              await callback({
                watcherId: batch.id,
                priority,
                files: batch.files,
                metadata: batch.metadata,
                timestamp: batch.timestamp
              });
            } catch (error) {
              logger.error(`回调处理失败: ${error.message}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error(`处理队列异常: ${error.message}`);
    } finally {
      // 重置处理标志
      this.isProcessingQueue = false;
      
      // 检查是否有新的变更需要处理
      for (const priority of ['high', 'medium', 'low']) {
        if (this.changeQueue[priority].length > 0) {
          // 稍后再次处理队列
          setTimeout(() => this._processChangeQueue(), 100);
          break;
        }
      }
    }
  }
  
  /**
   * 停止所有监控
   */
  stopAll() {
    for (const [id] of this.watchers.entries()) {
      this.removeWatchPath(id);
    }
    
    logger.info('已停止所有监控');
  }
} 