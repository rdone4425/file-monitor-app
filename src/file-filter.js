import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

/**
 * 文件过滤器
 */
export class FileFilter {
  constructor(options = {}) {
    this.maxFileSize = options.maxFileSize || 100 * 1024 * 1024; // 100MB 默认
    this.allowedExtensions = options.allowedExtensions || [];
    this.blockedExtensions = options.blockedExtensions || ['.exe', '.dll', '.so', '.dylib'];
    this.ignoredPatterns = options.ignoredPatterns || ['node_modules', '.git', '*.tmp'];
    this.minFileSize = options.minFileSize || 0;
  }

  /**
   * 检查文件是否应该被过滤
   * @param {string} filePath - 文件路径
   * @returns {Promise<object>} - 过滤结果
   */
  async shouldFilter(filePath) {
    const result = {
      shouldFilter: false,
      reason: '',
      fileInfo: null
    };

    try {
      // 获取文件信息
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;
      const fileName = path.basename(filePath);
      const fileExt = path.extname(filePath).toLowerCase();

      result.fileInfo = {
        size: fileSize,
        name: fileName,
        extension: fileExt,
        isDirectory: stats.isDirectory(),
        lastModified: stats.mtime
      };

      // 跳过目录
      if (stats.isDirectory()) {
        result.shouldFilter = true;
        result.reason = '是目录';
        return result;
      }

      // 检查文件大小限制
      if (fileSize > this.maxFileSize) {
        result.shouldFilter = true;
        result.reason = `文件过大 (${this.formatFileSize(fileSize)} > ${this.formatFileSize(this.maxFileSize)})`;
        return result;
      }

      if (fileSize < this.minFileSize) {
        result.shouldFilter = true;
        result.reason = `文件过小 (${this.formatFileSize(fileSize)} < ${this.formatFileSize(this.minFileSize)})`;
        return result;
      }

      // 检查被阻止的扩展名
      if (this.blockedExtensions.includes(fileExt)) {
        result.shouldFilter = true;
        result.reason = `被阻止的文件类型: ${fileExt}`;
        return result;
      }

      // 检查允许的扩展名（如果设置了）
      if (this.allowedExtensions.length > 0 && !this.allowedExtensions.includes(fileExt)) {
        result.shouldFilter = true;
        result.reason = `不在允许的文件类型列表中: ${fileExt}`;
        return result;
      }

      // 检查忽略模式
      const shouldIgnore = this.ignoredPatterns.some(pattern => {
        if (pattern.startsWith('*')) {
          const ext = pattern.substring(1);
          return fileName.endsWith(ext);
        }
        return fileName.includes(pattern) || filePath.includes(pattern);
      });

      if (shouldIgnore) {
        result.shouldFilter = true;
        result.reason = '匹配忽略模式';
        return result;
      }

      // 检查隐藏文件
      if (fileName.startsWith('.') && fileName !== '.env') {
        result.shouldFilter = true;
        result.reason = '隐藏文件';
        return result;
      }

      return result;

    } catch (error) {
      result.shouldFilter = true;
      result.reason = `无法访问文件: ${error.message}`;
      return result;
    }
  }

  /**
   * 批量过滤文件列表
   * @param {Array<string>} filePaths - 文件路径列表
   * @returns {Promise<object>} - 过滤结果
   */
  async filterFiles(filePaths) {
    const results = {
      allowed: [],
      filtered: [],
      stats: {
        total: filePaths.length,
        allowed: 0,
        filtered: 0,
        totalSize: 0,
        allowedSize: 0
      }
    };

    for (const filePath of filePaths) {
      const filterResult = await this.shouldFilter(filePath);
      
      if (filterResult.shouldFilter) {
        results.filtered.push({
          path: filePath,
          reason: filterResult.reason,
          info: filterResult.fileInfo
        });
        results.stats.filtered++;
      } else {
        results.allowed.push({
          path: filePath,
          info: filterResult.fileInfo
        });
        results.stats.allowed++;
        if (filterResult.fileInfo) {
          results.stats.allowedSize += filterResult.fileInfo.size;
        }
      }

      if (filterResult.fileInfo) {
        results.stats.totalSize += filterResult.fileInfo.size;
      }
    }

    return results;
  }

  /**
   * 检查文件内容是否包含敏感信息
   * @param {string} filePath - 文件路径
   * @returns {Promise<object>} - 检查结果
   */
  async checkSensitiveContent(filePath) {
    const result = {
      hasSensitiveContent: false,
      warnings: []
    };

    try {
      const stats = await fs.stat(filePath);
      
      // 只检查文本文件
      const textExtensions = ['.js', '.ts', '.json', '.env', '.txt', '.md', '.yml', '.yaml', '.xml', '.html', '.css', '.sql'];
      const fileExt = path.extname(filePath).toLowerCase();
      
      if (!textExtensions.includes(fileExt) || stats.size > 1024 * 1024) { // 跳过大于1MB的文件
        return result;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      
      // 敏感信息模式
      const sensitivePatterns = [
        { pattern: /password\s*[:=]\s*['"]\w+['"]|password\s*[:=]\s*\w+/gi, type: '密码' },
        { pattern: /api[_-]?key\s*[:=]\s*['"]\w+['"]|api[_-]?key\s*[:=]\s*\w+/gi, type: 'API密钥' },
        { pattern: /secret\s*[:=]\s*['"]\w+['"]|secret\s*[:=]\s*\w+/gi, type: '密钥' },
        { pattern: /token\s*[:=]\s*['"]\w+['"]|token\s*[:=]\s*\w+/gi, type: '令牌' },
        { pattern: /private[_-]?key/gi, type: '私钥' },
        { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi, type: 'RSA私钥' },
        { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: '邮箱地址' },
        { pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, type: '信用卡号' }
      ];

      for (const { pattern, type } of sensitivePatterns) {
        const matches = content.match(pattern);
        if (matches) {
          result.hasSensitiveContent = true;
          result.warnings.push({
            type,
            count: matches.length,
            examples: matches.slice(0, 3) // 只显示前3个匹配
          });
        }
      }

    } catch (error) {
      logger.warn(`检查敏感内容失败 ${filePath}: ${error.message}`);
    }

    return result;
  }

  /**
   * 格式化文件大小
   * @param {number} bytes - 字节数
   * @returns {string} - 格式化的大小
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 更新过滤器配置
   * @param {object} newOptions - 新的配置选项
   */
  updateConfig(newOptions) {
    if (newOptions.maxFileSize !== undefined) {
      this.maxFileSize = newOptions.maxFileSize;
    }
    if (newOptions.minFileSize !== undefined) {
      this.minFileSize = newOptions.minFileSize;
    }
    if (newOptions.allowedExtensions !== undefined) {
      this.allowedExtensions = newOptions.allowedExtensions;
    }
    if (newOptions.blockedExtensions !== undefined) {
      this.blockedExtensions = newOptions.blockedExtensions;
    }
    if (newOptions.ignoredPatterns !== undefined) {
      this.ignoredPatterns = newOptions.ignoredPatterns;
    }
    
    logger.info('文件过滤器配置已更新');
  }

  /**
   * 获取过滤器统计信息
   * @returns {object} - 统计信息
   */
  getStats() {
    return {
      maxFileSize: this.maxFileSize,
      minFileSize: this.minFileSize,
      allowedExtensions: this.allowedExtensions,
      blockedExtensions: this.blockedExtensions,
      ignoredPatterns: this.ignoredPatterns,
      formattedMaxSize: this.formatFileSize(this.maxFileSize),
      formattedMinSize: this.formatFileSize(this.minFileSize)
    };
  }
}
