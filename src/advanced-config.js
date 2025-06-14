import { logger } from './logger.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

/**
 * 高级监控配置类
 * 用于支持多文件监控的灵活配置和权重设置
 */
export class AdvancedMonitoringConfig {
  /**
   * 构造函数
   * @param {string} configPath - 配置文件路径
   */
  constructor(configPath = null) {
    this.configPath = configPath;
    this.config = {
      fileGroups: [],
      priorities: {
        high: [],
        medium: [],
        low: []
      },
      watchSettings: {
        pollingInterval: 1000,
        usePolling: false,
        followSymlinks: false,
        deepScan: true,
        maxDepth: 5
      },
      syncSettings: {
        syncIntervals: {
          high: 60000,    // 1分钟
          medium: 300000, // 5分钟
          low: 3600000    // 1小时
        },
        batchSize: 10,
        maxRetries: 3
      }
    };
  }

  /**
   * 加载配置
   * @returns {Promise<object>} - 加载的配置
   */
  async loadConfig() {
    if (!this.configPath || !existsSync(this.configPath)) {
      logger.warn('未找到高级监控配置文件，使用默认配置');
      return this.config;
    }
    
    try {
      const configData = await fs.readFile(this.configPath, 'utf-8');
      const loadedConfig = JSON.parse(configData);
      
      // 合并加载的配置
      this.config = {
        ...this.config,
        ...loadedConfig
      };
      
      logger.info('已加载高级监控配置');
      return this.config;
    } catch (error) {
      logger.error(`加载高级监控配置失败: ${error.message}`);
      return this.config;
    }
  }

  /**
   * 添加文件组
   * @param {string} name - 组名
   * @param {Array<string>} paths - 文件/目录路径列表
   * @param {string} priority - 优先级 (high, medium, low)
   * @param {Object} options - 额外选项
   * @returns {string} - 组ID
   */
  addFileGroup(name, paths, priority = 'medium', options = {}) {
    const groupId = `group_${Date.now()}`;
    
    this.config.fileGroups.push({
      id: groupId,
      name,
      paths,
      priority,
      options
    });
    
    // 将组ID添加到对应优先级
    if (!this.config.priorities[priority]) {
      this.config.priorities[priority] = [];
    }
    this.config.priorities[priority].push(groupId);
    
    return groupId;
  }

  /**
   * 根据优先级获取文件组
   * @param {string} priority - 优先级
   * @returns {Array} - 匹配的文件组
   */
  getFileGroupsByPriority(priority) {
    if (!this.config.priorities[priority]) {
      return [];
    }
    
    const groupIds = this.config.priorities[priority];
    return this.config.fileGroups.filter(group => groupIds.includes(group.id));
  }

  /**
   * 获取所有文件路径
   * @returns {Array} - 所有要监控的文件路径
   */
  getAllFilePaths() {
    const allPaths = [];
    
    for (const group of this.config.fileGroups) {
      allPaths.push(...group.paths);
    }
    
    return [...new Set(allPaths)]; // 去重
  }

  /**
   * 保存配置
   * @returns {Promise<boolean>} - 是否保存成功
   */
  async saveConfig() {
    if (!this.configPath) {
      logger.error('未指定配置文件路径，无法保存');
      return false;
    }
    
    try {
      // 确保目录存在
      const configDir = path.dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });
      
      // 写入配置
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.info(`高级监控配置已保存到: ${this.configPath}`);
      return true;
    } catch (error) {
      logger.error(`保存高级监控配置失败: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 获取监控设置
   * @returns {Object} - 监控设置
   */
  getWatchSettings() {
    return this.config.watchSettings;
  }
  
  /**
   * 获取同步间隔时间（毫秒）
   * @param {string} priority - 优先级
   * @returns {number} - 同步间隔时间（毫秒）
   */
  getSyncInterval(priority) {
    return this.config.syncSettings.syncIntervals[priority] || 
           this.config.syncSettings.syncIntervals.medium;
  }
} 