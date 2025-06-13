import os from 'os';
import { logger } from './logger.js';

/**
 * 性能监控器
 */
export class PerformanceMonitor {
  constructor() {
    this.metrics = {
      fileChanges: 0,
      uploadsSuccess: 0,
      uploadsFailed: 0,
      totalUploadTime: 0,
      averageUploadTime: 0,
      startTime: Date.now(),
      lastActivity: Date.now()
    };
    
    this.systemMetrics = {
      cpuUsage: [],
      memoryUsage: [],
      diskUsage: []
    };
    
    // 每分钟收集一次系统指标
    this.metricsInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, 60000);
  }
  
  /**
   * 记录文件变化
   * @param {number} count - 变化文件数量
   */
  recordFileChanges(count = 1) {
    this.metrics.fileChanges += count;
    this.metrics.lastActivity = Date.now();
    logger.debug(`记录文件变化: ${count} 个文件`);
  }
  
  /**
   * 记录上传成功
   * @param {number} uploadTime - 上传耗时（毫秒）
   */
  recordUploadSuccess(uploadTime = 0) {
    this.metrics.uploadsSuccess++;
    this.metrics.totalUploadTime += uploadTime;
    this.metrics.averageUploadTime = this.metrics.totalUploadTime / this.metrics.uploadsSuccess;
    this.metrics.lastActivity = Date.now();
    logger.debug(`记录上传成功，耗时: ${uploadTime}ms`);
  }
  
  /**
   * 记录上传失败
   */
  recordUploadFailure() {
    this.metrics.uploadsFailed++;
    this.metrics.lastActivity = Date.now();
    logger.debug('记录上传失败');
  }
  
  /**
   * 收集系统指标
   */
  collectSystemMetrics() {
    try {
      // CPU 使用率
      const cpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;
      
      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
      });
      
      const cpuUsage = 100 - (totalIdle / totalTick * 100);
      
      // 内存使用率
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsage = (usedMem / totalMem) * 100;
      
      // 进程内存使用
      const processMemory = process.memoryUsage();
      
      // 保存指标（只保留最近100个数据点）
      this.systemMetrics.cpuUsage.push({
        timestamp: Date.now(),
        value: cpuUsage
      });
      
      this.systemMetrics.memoryUsage.push({
        timestamp: Date.now(),
        system: memUsage,
        process: {
          rss: processMemory.rss / 1024 / 1024, // MB
          heapUsed: processMemory.heapUsed / 1024 / 1024, // MB
          heapTotal: processMemory.heapTotal / 1024 / 1024, // MB
          external: processMemory.external / 1024 / 1024 // MB
        }
      });
      
      // 限制数据点数量
      if (this.systemMetrics.cpuUsage.length > 100) {
        this.systemMetrics.cpuUsage.shift();
      }
      if (this.systemMetrics.memoryUsage.length > 100) {
        this.systemMetrics.memoryUsage.shift();
      }
      
    } catch (error) {
      logger.error(`收集系统指标失败: ${error.message}`);
    }
  }
  
  /**
   * 获取性能统计
   * @returns {object} - 性能统计数据
   */
  getStats() {
    const uptime = Date.now() - this.metrics.startTime;
    const lastActivityAgo = Date.now() - this.metrics.lastActivity;
    
    const totalUploads = this.metrics.uploadsSuccess + this.metrics.uploadsFailed;
    const successRate = totalUploads > 0 ? (this.metrics.uploadsSuccess / totalUploads * 100) : 0;
    
    return {
      // 应用指标
      uptime: {
        ms: uptime,
        formatted: this.formatDuration(uptime)
      },
      lastActivity: {
        ms: lastActivityAgo,
        formatted: this.formatDuration(lastActivityAgo) + ' ago'
      },
      fileChanges: this.metrics.fileChanges,
      uploads: {
        total: totalUploads,
        success: this.metrics.uploadsSuccess,
        failed: this.metrics.uploadsFailed,
        successRate: Math.round(successRate * 100) / 100
      },
      performance: {
        averageUploadTime: Math.round(this.metrics.averageUploadTime),
        totalUploadTime: this.metrics.totalUploadTime
      },
      
      // 系统指标
      system: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        cpuCount: os.cpus().length,
        totalMemory: Math.round(os.totalmem() / 1024 / 1024), // MB
        freeMemory: Math.round(os.freemem() / 1024 / 1024), // MB
        loadAverage: os.loadavg()
      },
      
      // 历史数据
      history: {
        cpu: this.systemMetrics.cpuUsage.slice(-20), // 最近20个数据点
        memory: this.systemMetrics.memoryUsage.slice(-20)
      }
    };
  }
  
  /**
   * 格式化持续时间
   * @param {number} ms - 毫秒
   * @returns {string} - 格式化的时间字符串
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days}天 ${hours % 24}小时 ${minutes % 60}分钟`;
    } else if (hours > 0) {
      return `${hours}小时 ${minutes % 60}分钟`;
    } else if (minutes > 0) {
      return `${minutes}分钟 ${seconds % 60}秒`;
    } else {
      return `${seconds}秒`;
    }
  }
  
  /**
   * 重置统计数据
   */
  reset() {
    this.metrics = {
      fileChanges: 0,
      uploadsSuccess: 0,
      uploadsFailed: 0,
      totalUploadTime: 0,
      averageUploadTime: 0,
      startTime: Date.now(),
      lastActivity: Date.now()
    };
    
    this.systemMetrics = {
      cpuUsage: [],
      memoryUsage: [],
      diskUsage: []
    };
    
    logger.info('性能统计数据已重置');
  }
  
  /**
   * 停止监控
   */
  stop() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    logger.info('性能监控已停止');
  }
}

// 创建全局实例
export const performanceMonitor = new PerformanceMonitor();
