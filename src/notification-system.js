import axios from 'axios';
import { logger } from './logger.js';

/**
 * 通知系统
 */
export class NotificationSystem {
  constructor() {
    this.providers = new Map();
    this.enabled = true;
    this.setupDefaultProviders();
  }

  /**
   * 设置默认通知提供者
   */
  setupDefaultProviders() {
    // Webhook 通知
    this.providers.set('webhook', {
      name: 'Webhook',
      send: this.sendWebhook.bind(this),
      config: {
        url: process.env.WEBHOOK_URL || '',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    });

    // Slack 通知
    this.providers.set('slack', {
      name: 'Slack',
      send: this.sendSlack.bind(this),
      config: {
        webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
        channel: process.env.SLACK_CHANNEL || '#general',
        username: process.env.SLACK_USERNAME || 'File Monitor'
      }
    });

    // 邮件通知（简单实现）
    this.providers.set('email', {
      name: 'Email',
      send: this.sendEmail.bind(this),
      config: {
        enabled: false, // 默认禁用，需要配置SMTP
        to: process.env.EMAIL_TO || '',
        from: process.env.EMAIL_FROM || '',
        subject: process.env.EMAIL_SUBJECT || 'File Monitor Notification'
      }
    });
  }

  /**
   * 发送通知
   * @param {string} type - 通知类型
   * @param {object} data - 通知数据
   * @param {Array<string>} providers - 使用的通知提供者
   */
  async notify(type, data, providers = ['webhook']) {
    if (!this.enabled) {
      logger.debug('通知系统已禁用');
      return;
    }

    const notification = this.formatNotification(type, data);
    const results = [];

    for (const providerName of providers) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        logger.warn(`未知的通知提供者: ${providerName}`);
        continue;
      }

      try {
        await provider.send(notification);
        results.push({ provider: providerName, success: true });
        logger.debug(`通知发送成功: ${providerName}`);
      } catch (error) {
        results.push({ provider: providerName, success: false, error: error.message });
        logger.error(`通知发送失败 ${providerName}: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * 格式化通知内容
   * @param {string} type - 通知类型
   * @param {object} data - 数据
   * @returns {object} - 格式化的通知
   */
  formatNotification(type, data) {
    const timestamp = new Date().toLocaleString();
    
    const notifications = {
      'file_change': {
        title: '📁 文件变化检测',
        message: `检测到 ${data.fileCount} 个文件发生变化`,
        details: {
          project: data.projectName,
          files: data.files?.slice(0, 5), // 只显示前5个文件
          timestamp
        },
        color: '#36a64f',
        urgency: 'low'
      },
      
      'upload_success': {
        title: '✅ 文件上传成功',
        message: `成功上传 ${data.successCount} 个文件到 GitHub`,
        details: {
          project: data.projectName,
          repository: data.repository,
          successCount: data.successCount,
          failedCount: data.failedCount,
          uploadTime: data.uploadTime,
          timestamp
        },
        color: '#36a64f',
        urgency: 'low'
      },
      
      'upload_failed': {
        title: '❌ 文件上传失败',
        message: `上传失败: ${data.errorMessage}`,
        details: {
          project: data.projectName,
          repository: data.repository,
          error: data.errorMessage,
          retryCount: data.retryCount,
          timestamp
        },
        color: '#ff0000',
        urgency: 'high'
      },
      
      'system_error': {
        title: '🚨 系统错误',
        message: `系统发生错误: ${data.errorMessage}`,
        details: {
          error: data.errorMessage,
          stack: data.stack,
          timestamp
        },
        color: '#ff0000',
        urgency: 'critical'
      },
      
      'config_changed': {
        title: '⚙️ 配置更新',
        message: '系统配置已更新',
        details: {
          changes: data.changes,
          timestamp
        },
        color: '#ffaa00',
        urgency: 'medium'
      },
      
      'project_started': {
        title: '🚀 项目监控启动',
        message: `项目 "${data.projectName}" 监控已启动`,
        details: {
          project: data.projectName,
          path: data.path,
          repository: data.repository,
          timestamp
        },
        color: '#36a64f',
        urgency: 'low'
      },
      
      'project_stopped': {
        title: '⏹️ 项目监控停止',
        message: `项目 "${data.projectName}" 监控已停止`,
        details: {
          project: data.projectName,
          reason: data.reason,
          timestamp
        },
        color: '#ffaa00',
        urgency: 'medium'
      }
    };

    return notifications[type] || {
      title: '📢 通知',
      message: data.message || '未知通知',
      details: data,
      color: '#cccccc',
      urgency: 'low'
    };
  }

  /**
   * 发送 Webhook 通知
   * @param {object} notification - 通知内容
   */
  async sendWebhook(notification) {
    const config = this.providers.get('webhook').config;
    
    if (!config.url) {
      throw new Error('Webhook URL 未配置');
    }

    const payload = {
      type: 'file_monitor_notification',
      title: notification.title,
      message: notification.message,
      details: notification.details,
      urgency: notification.urgency,
      timestamp: new Date().toISOString()
    };

    await axios({
      method: config.method,
      url: config.url,
      headers: config.headers,
      data: payload,
      timeout: 10000
    });
  }

  /**
   * 发送 Slack 通知
   * @param {object} notification - 通知内容
   */
  async sendSlack(notification) {
    const config = this.providers.get('slack').config;
    
    if (!config.webhookUrl) {
      throw new Error('Slack Webhook URL 未配置');
    }

    const payload = {
      channel: config.channel,
      username: config.username,
      attachments: [{
        color: notification.color,
        title: notification.title,
        text: notification.message,
        fields: Object.entries(notification.details).map(([key, value]) => ({
          title: key,
          value: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
          short: true
        })),
        footer: 'File Monitor',
        ts: Math.floor(Date.now() / 1000)
      }]
    };

    await axios.post(config.webhookUrl, payload, {
      timeout: 10000
    });
  }

  /**
   * 发送邮件通知（占位符实现）
   * @param {object} notification - 通知内容
   */
  async sendEmail(notification) {
    const config = this.providers.get('email').config;
    
    if (!config.enabled) {
      throw new Error('邮件通知未启用');
    }

    // 这里应该集成真正的邮件服务，如 nodemailer
    logger.info('邮件通知功能需要配置 SMTP 服务器');
    throw new Error('邮件通知功能尚未完全实现');
  }

  /**
   * 添加自定义通知提供者
   * @param {string} name - 提供者名称
   * @param {object} provider - 提供者配置
   */
  addProvider(name, provider) {
    this.providers.set(name, provider);
    logger.info(`添加通知提供者: ${name}`);
  }

  /**
   * 移除通知提供者
   * @param {string} name - 提供者名称
   */
  removeProvider(name) {
    this.providers.delete(name);
    logger.info(`移除通知提供者: ${name}`);
  }

  /**
   * 启用/禁用通知系统
   * @param {boolean} enabled - 是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    logger.info(`通知系统${enabled ? '已启用' : '已禁用'}`);
  }

  /**
   * 获取通知系统状态
   * @returns {object} - 状态信息
   */
  getStatus() {
    return {
      enabled: this.enabled,
      providers: Array.from(this.providers.keys()),
      providerConfigs: Object.fromEntries(
        Array.from(this.providers.entries()).map(([name, provider]) => [
          name,
          {
            name: provider.name,
            configured: this.isProviderConfigured(name)
          }
        ])
      )
    };
  }

  /**
   * 检查提供者是否已配置
   * @param {string} providerName - 提供者名称
   * @returns {boolean} - 是否已配置
   */
  isProviderConfigured(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) return false;

    switch (providerName) {
      case 'webhook':
        return !!provider.config.url;
      case 'slack':
        return !!provider.config.webhookUrl;
      case 'email':
        return provider.config.enabled && !!provider.config.to;
      default:
        return true;
    }
  }
}

// 创建全局实例
export const notificationSystem = new NotificationSystem();
