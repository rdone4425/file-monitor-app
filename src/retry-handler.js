import { logger } from './logger.js';

/**
 * 重试处理器
 */
export class RetryHandler {
  /**
   * 执行带重试的异步操作
   * @param {Function} operation - 要执行的异步操作
   * @param {object} options - 重试选项
   * @returns {Promise} - 操作结果
   */
  static async executeWithRetry(operation, options = {}) {
    const {
      maxRetries = 3,
      baseDelay = 1000,
      maxDelay = 10000,
      backoffFactor = 2,
      retryCondition = (error) => true,
      onRetry = null
    } = options;

    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        
        if (attempt > 0) {
          logger.info(`操作在第 ${attempt + 1} 次尝试后成功`);
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        // 如果是最后一次尝试，直接抛出错误
        if (attempt === maxRetries) {
          logger.error(`操作在 ${maxRetries + 1} 次尝试后仍然失败: ${error.message}`);
          throw error;
        }
        
        // 检查是否应该重试
        if (!retryCondition(error)) {
          logger.error(`操作失败且不符合重试条件: ${error.message}`);
          throw error;
        }
        
        // 计算延迟时间（指数退避）
        const delay = Math.min(
          baseDelay * Math.pow(backoffFactor, attempt),
          maxDelay
        );
        
        logger.warn(`操作失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
        logger.info(`将在 ${delay}ms 后重试...`);
        
        // 调用重试回调
        if (onRetry) {
          try {
            await onRetry(error, attempt + 1);
          } catch (callbackError) {
            logger.error(`重试回调执行失败: ${callbackError.message}`);
          }
        }
        
        // 等待指定时间后重试
        await this.delay(delay);
      }
    }
    
    throw lastError;
  }
  
  /**
   * 延迟函数
   * @param {number} ms - 延迟毫秒数
   * @returns {Promise} - Promise对象
   */
  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * GitHub API 专用重试条件
   * @param {Error} error - 错误对象
   * @returns {boolean} - 是否应该重试
   */
  static githubRetryCondition(error) {
    // 网络错误或临时服务器错误应该重试
    if (error.code === 'ECONNRESET' || 
        error.code === 'ENOTFOUND' || 
        error.code === 'ETIMEDOUT') {
      return true;
    }
    
    // HTTP 状态码检查
    if (error.response) {
      const status = error.response.status;
      
      // 5xx 服务器错误应该重试
      if (status >= 500) {
        return true;
      }
      
      // 429 限流错误应该重试
      if (status === 429) {
        return true;
      }
      
      // 403 可能是临时限制，可以重试
      if (status === 403) {
        return true;
      }
      
      // 4xx 客户端错误通常不应该重试（除了上面的特殊情况）
      if (status >= 400 && status < 500) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * 文件操作专用重试条件
   * @param {Error} error - 错误对象
   * @returns {boolean} - 是否应该重试
   */
  static fileRetryCondition(error) {
    // 文件被占用或临时不可访问
    if (error.code === 'EBUSY' || 
        error.code === 'EMFILE' || 
        error.code === 'ENFILE') {
      return true;
    }
    
    // 权限错误通常不应该重试
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return false;
    }
    
    // 文件不存在错误不应该重试
    if (error.code === 'ENOENT') {
      return false;
    }
    
    return true;
  }
  
  /**
   * 创建 GitHub 上传重试包装器
   * @param {Function} uploadFunction - 上传函数
   * @returns {Function} - 包装后的函数
   */
  static createGitHubUploadWrapper(uploadFunction) {
    return async (...args) => {
      return this.executeWithRetry(
        () => uploadFunction(...args),
        {
          maxRetries: 3,
          baseDelay: 2000,
          maxDelay: 30000,
          backoffFactor: 2,
          retryCondition: this.githubRetryCondition,
          onRetry: async (error, attempt) => {
            logger.info(`GitHub 上传重试 (第 ${attempt} 次): ${error.message}`);
            
            // 如果是限流错误，等待更长时间
            if (error.response && error.response.status === 429) {
              const retryAfter = error.response.headers['retry-after'];
              if (retryAfter) {
                const waitTime = parseInt(retryAfter) * 1000;
                logger.info(`检测到限流，将等待 ${waitTime}ms`);
                await this.delay(waitTime);
              }
            }
          }
        }
      );
    };
  }
  
  /**
   * 创建文件操作重试包装器
   * @param {Function} fileFunction - 文件操作函数
   * @returns {Function} - 包装后的函数
   */
  static createFileOperationWrapper(fileFunction) {
    return async (...args) => {
      return this.executeWithRetry(
        () => fileFunction(...args),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 5000,
          backoffFactor: 2,
          retryCondition: this.fileRetryCondition,
          onRetry: async (error, attempt) => {
            logger.info(`文件操作重试 (第 ${attempt} 次): ${error.message}`);
          }
        }
      );
    };
  }
}

/**
 * 错误分类器
 */
export class ErrorClassifier {
  /**
   * 分类错误类型
   * @param {Error} error - 错误对象
   * @returns {object} - 错误分类信息
   */
  static classify(error) {
    const classification = {
      type: 'unknown',
      severity: 'medium',
      recoverable: true,
      userMessage: '发生了未知错误',
      technicalMessage: error.message,
      suggestions: []
    };
    
    // GitHub API 错误
    if (error.response && error.response.config && error.response.config.url.includes('api.github.com')) {
      classification.type = 'github_api';
      
      const status = error.response.status;
      
      switch (status) {
        case 401:
          classification.severity = 'high';
          classification.recoverable = false;
          classification.userMessage = 'GitHub 认证失败';
          classification.suggestions = ['检查 GitHub Token 是否正确', '确认 Token 是否已过期'];
          break;
          
        case 403:
          classification.severity = 'high';
          classification.userMessage = 'GitHub 访问被拒绝';
          classification.suggestions = ['检查 Token 权限', '确认仓库访问权限', '检查是否触发了限流'];
          break;
          
        case 404:
          classification.severity = 'medium';
          classification.userMessage = 'GitHub 资源未找到';
          classification.suggestions = ['检查仓库名称是否正确', '确认分支是否存在'];
          break;
          
        case 429:
          classification.severity = 'low';
          classification.userMessage = 'GitHub API 限流';
          classification.suggestions = ['稍后重试', '减少请求频率'];
          break;
          
        case 422:
          classification.severity = 'medium';
          classification.recoverable = false;
          classification.userMessage = 'GitHub 请求数据无效';
          classification.suggestions = ['检查文件内容', '确认提交信息格式'];
          break;
          
        default:
          if (status >= 500) {
            classification.severity = 'medium';
            classification.userMessage = 'GitHub 服务器错误';
            classification.suggestions = ['稍后重试', '检查 GitHub 服务状态'];
          }
      }
    }
    
    // 网络错误
    else if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      classification.type = 'network';
      classification.severity = 'medium';
      classification.userMessage = '网络连接错误';
      classification.suggestions = ['检查网络连接', '稍后重试'];
    }
    
    // 文件系统错误
    else if (error.code && error.code.startsWith('E')) {
      classification.type = 'filesystem';
      
      switch (error.code) {
        case 'ENOENT':
          classification.severity = 'high';
          classification.recoverable = false;
          classification.userMessage = '文件或目录不存在';
          classification.suggestions = ['检查文件路径是否正确'];
          break;
          
        case 'EACCES':
        case 'EPERM':
          classification.severity = 'high';
          classification.recoverable = false;
          classification.userMessage = '文件访问权限不足';
          classification.suggestions = ['检查文件权限', '以管理员身份运行'];
          break;
          
        case 'EBUSY':
          classification.severity = 'low';
          classification.userMessage = '文件正在被使用';
          classification.suggestions = ['稍后重试', '关闭占用文件的程序'];
          break;
      }
    }
    
    return classification;
  }
  
  /**
   * 生成用户友好的错误报告
   * @param {Error} error - 错误对象
   * @returns {string} - 错误报告
   */
  static generateReport(error) {
    const classification = this.classify(error);
    
    let report = `错误类型: ${classification.type}\n`;
    report += `严重程度: ${classification.severity}\n`;
    report += `用户消息: ${classification.userMessage}\n`;
    
    if (classification.suggestions.length > 0) {
      report += `建议解决方案:\n`;
      classification.suggestions.forEach((suggestion, index) => {
        report += `  ${index + 1}. ${suggestion}\n`;
      });
    }
    
    report += `技术详情: ${classification.technicalMessage}`;
    
    return report;
  }
}
