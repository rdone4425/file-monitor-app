import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * 认证中间件
 */
export class AuthMiddleware {
  constructor() {
    this.apiKeys = new Map();
    this.sessions = new Map();
    this.rateLimits = new Map();
    this.setupDefaultAuth();
  }

  /**
   * 设置默认认证
   */
  setupDefaultAuth() {
    // 从环境变量获取 API 密钥
    const apiKey = process.env.API_KEY || this.generateApiKey();
    const adminKey = process.env.ADMIN_API_KEY || this.generateApiKey();
    
    // 设置默认 API 密钥
    this.apiKeys.set(apiKey, {
      name: 'default',
      permissions: ['read', 'write'],
      createdAt: new Date(),
      lastUsed: null,
      usageCount: 0
    });
    
    this.apiKeys.set(adminKey, {
      name: 'admin',
      permissions: ['read', 'write', 'admin'],
      createdAt: new Date(),
      lastUsed: null,
      usageCount: 0
    });
    
    // 如果是新生成的密钥，记录到日志
    if (!process.env.API_KEY) {
      logger.warn(`生成的默认 API 密钥: ${apiKey}`);
      logger.warn(`生成的管理员 API 密钥: ${adminKey}`);
      logger.warn('请将这些密钥保存到环境变量中');
    }
  }

  /**
   * 生成 API 密钥
   * @returns {string} - API 密钥
   */
  generateApiKey() {
    return 'fm_' + crypto.randomBytes(32).toString('hex');
  }

  /**
   * API 密钥认证中间件
   * @param {Array<string>} requiredPermissions - 需要的权限
   * @returns {Function} - Express 中间件
   */
  requireApiKey(requiredPermissions = ['read']) {
    return (req, res, next) => {
      const apiKey = req.headers['x-api-key'] || req.query.api_key;
      
      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: 'API 密钥缺失',
          code: 'MISSING_API_KEY'
        });
      }
      
      const keyInfo = this.apiKeys.get(apiKey);
      if (!keyInfo) {
        return res.status(401).json({
          success: false,
          error: 'API 密钥无效',
          code: 'INVALID_API_KEY'
        });
      }
      
      // 检查权限
      const hasPermission = requiredPermissions.every(permission => 
        keyInfo.permissions.includes(permission)
      );
      
      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          error: '权限不足',
          code: 'INSUFFICIENT_PERMISSIONS',
          required: requiredPermissions,
          available: keyInfo.permissions
        });
      }
      
      // 更新使用统计
      keyInfo.lastUsed = new Date();
      keyInfo.usageCount++;
      
      // 添加用户信息到请求对象
      req.auth = {
        apiKey,
        keyName: keyInfo.name,
        permissions: keyInfo.permissions
      };
      
      next();
    };
  }

  /**
   * 速率限制中间件
   * @param {object} options - 限制选项
   * @returns {Function} - Express 中间件
   */
  rateLimit(options = {}) {
    const {
      windowMs = 15 * 60 * 1000, // 15分钟
      maxRequests = 100,
      keyGenerator = (req) => req.ip || 'unknown'
    } = options;

    return (req, res, next) => {
      const key = keyGenerator(req);
      const now = Date.now();
      const windowStart = now - windowMs;
      
      // 获取或创建限制记录
      if (!this.rateLimits.has(key)) {
        this.rateLimits.set(key, []);
      }
      
      const requests = this.rateLimits.get(key);
      
      // 清理过期的请求记录
      const validRequests = requests.filter(timestamp => timestamp > windowStart);
      this.rateLimits.set(key, validRequests);
      
      // 检查是否超过限制
      if (validRequests.length >= maxRequests) {
        const resetTime = Math.ceil((validRequests[0] + windowMs) / 1000);
        
        res.set({
          'X-RateLimit-Limit': maxRequests,
          'X-RateLimit-Remaining': 0,
          'X-RateLimit-Reset': resetTime
        });
        
        return res.status(429).json({
          success: false,
          error: '请求过于频繁',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil((validRequests[0] + windowMs - now) / 1000)
        });
      }
      
      // 记录当前请求
      validRequests.push(now);
      
      // 设置响应头
      res.set({
        'X-RateLimit-Limit': maxRequests,
        'X-RateLimit-Remaining': maxRequests - validRequests.length,
        'X-RateLimit-Reset': Math.ceil((now + windowMs) / 1000)
      });
      
      next();
    };
  }

  /**
   * 会话认证中间件（用于 Web 界面）
   * @returns {Function} - Express 中间件
   */
  requireSession() {
    return (req, res, next) => {
      const sessionId = req.cookies?.sessionId || req.headers['x-session-id'];
      
      if (!sessionId || !this.sessions.has(sessionId)) {
        return res.status(401).json({
          success: false,
          error: '会话无效或已过期',
          code: 'INVALID_SESSION'
        });
      }
      
      const session = this.sessions.get(sessionId);
      
      // 检查会话是否过期
      if (session.expiresAt < new Date()) {
        this.sessions.delete(sessionId);
        return res.status(401).json({
          success: false,
          error: '会话已过期',
          code: 'SESSION_EXPIRED'
        });
      }
      
      // 更新会话活动时间
      session.lastActivity = new Date();
      session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24小时
      
      req.session = session;
      next();
    };
  }

  /**
   * 创建会话
   * @param {object} userData - 用户数据
   * @returns {string} - 会话ID
   */
  createSession(userData = {}) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const session = {
      id: sessionId,
      user: userData,
      createdAt: new Date(),
      lastActivity: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24小时
    };
    
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  /**
   * 销毁会话
   * @param {string} sessionId - 会话ID
   */
  destroySession(sessionId) {
    this.sessions.delete(sessionId);
  }

  /**
   * 添加 API 密钥
   * @param {string} name - 密钥名称
   * @param {Array<string>} permissions - 权限列表
   * @returns {string} - 生成的 API 密钥
   */
  addApiKey(name, permissions = ['read']) {
    const apiKey = this.generateApiKey();
    this.apiKeys.set(apiKey, {
      name,
      permissions,
      createdAt: new Date(),
      lastUsed: null,
      usageCount: 0
    });
    
    logger.info(`创建新的 API 密钥: ${name}`);
    return apiKey;
  }

  /**
   * 删除 API 密钥
   * @param {string} apiKey - API 密钥
   */
  removeApiKey(apiKey) {
    const keyInfo = this.apiKeys.get(apiKey);
    if (keyInfo) {
      this.apiKeys.delete(apiKey);
      logger.info(`删除 API 密钥: ${keyInfo.name}`);
    }
  }

  /**
   * 获取认证统计信息
   * @returns {object} - 统计信息
   */
  getStats() {
    const apiKeyStats = Array.from(this.apiKeys.entries()).map(([key, info]) => ({
      name: info.name,
      permissions: info.permissions,
      createdAt: info.createdAt,
      lastUsed: info.lastUsed,
      usageCount: info.usageCount,
      keyPreview: key.substring(0, 8) + '...'
    }));

    return {
      apiKeys: {
        total: this.apiKeys.size,
        keys: apiKeyStats
      },
      sessions: {
        active: this.sessions.size,
        list: Array.from(this.sessions.values()).map(session => ({
          id: session.id.substring(0, 8) + '...',
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          expiresAt: session.expiresAt
        }))
      },
      rateLimits: {
        activeIPs: this.rateLimits.size
      }
    };
  }

  /**
   * 清理过期的会话和限制记录
   */
  cleanup() {
    const now = new Date();
    
    // 清理过期会话
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt < now) {
        this.sessions.delete(sessionId);
      }
    }
    
    // 清理过期的速率限制记录
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [key, requests] of this.rateLimits.entries()) {
      const validRequests = requests.filter(timestamp => timestamp > oneHourAgo);
      if (validRequests.length === 0) {
        this.rateLimits.delete(key);
      } else {
        this.rateLimits.set(key, validRequests);
      }
    }
    
    logger.debug('认证系统清理完成');
  }
}

// 创建全局实例
export const authMiddleware = new AuthMiddleware();

// 定期清理
setInterval(() => {
  authMiddleware.cleanup();
}, 60 * 60 * 1000); // 每小时清理一次
